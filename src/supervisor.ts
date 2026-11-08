import { randomUUID } from "node:crypto";
import { AppendOnlyJsonlStore } from './storage/jsonl.js';
import { capabilities, discardWorktree, setupWorktree, intersectPermission, createWorktree, removeWorktree, restrictPermission, validator, type Worktree } from './execution.js';
import type { PermissionConfig } from './config/schema.js';

interface ExecutionMeta {
  turn: number;
  cleaned?: boolean;
  history: Record<string, unknown>[];
  activity?: string;
  activityAt?: string;
  checkpointAt?: string;
  worktree?: Worktree;
  permission?: PermissionConfig;
  schema?: Record<string, unknown>;
  structured?: unknown;
  validation_errors?: unknown;
  group_id?: string;
}
export interface ListAgentsInput {
  states?: string[] | undefined; backend?: Backend | undefined; updated_since?: string | undefined;
  limit?: number | undefined; cursor?: string | undefined;
}
interface PendingTask {
  id: string; created_at: string; input: SpawnAgentInput; dependencies: { agent: string; turn: number }[];
  state: 'queued' | 'starting' | 'blocked' | 'interrupted' | 'completed'; result?: Record<string, unknown>;
}


import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AdapterRegistry, type BackendAdapter } from "./adapters/adapter.js";
import { ApprovalCoordinator } from "./approval/coordinator.js";
import type { ApprovalDecision } from "./approval/types.js";
import { AGENT_NAMES } from "./agent-names.js";
import type { AgentConfigSource } from "./config/registry.js";
import type { Backend, Usage } from "./core/types.js";
import type { ModelEntry } from "./config/schema.js";
import { AgentCapacity, childDepthEnv } from "./core/limits.js";
import { ConfigurationError, SubagentError } from "./core/errors.js";
import { EventBuffer } from "./events/buffer.js";
import type { AgentEvent } from "./events/schema.js";
import { scanChildOutput } from "./safety/output.js";
import { RoutingStore, projectRoutingPaths, ensureProjectMemoryIgnored, type MemoryScope } from "./storage/routing.js";
import { remainingAllowances, UsageLedger } from "./usage.js";

/** Cap on one backend's live `providerInfo` query, so `list_models` never hangs on it. */
const LIVE_INFO_TIMEOUT_MS = 30_000;

export type ToolAgentState = "starting" | "running" | "needs_approval" | "completed" | "interrupted" | "failed";

interface AgentRecord {
  meta: ExecutionMeta;
  id: string;
  name: string;
  readonly backend: Backend;
  readonly model: string;
  effort?: string;
  readonly agentConfig: string;
  readonly cwd: string;
  state: ToolAgentState;
  readonly background: boolean;
  /** True while the current turn's caller returned without blocking; #notify() then pushes the outcome. */
  detached: boolean;
  readonly createdAt: string;
  updatedAt: string;
  cursor: number;
  pendingApprovalId?: string;
  /** One queued send_message, delivered once the current turn reaches turn.completed. */
  pendingMessage?: { readonly prompt: string; readonly effort?: string; readonly timeout?: number };
  /** Seconds. Null when neither the call nor the agent config set a cap. */
  timeoutSeconds: number | null;
  timedOut: boolean;
  /** Set on a Codex resume so the caller sees the uncached-history cost. */
  warning?: string;
  nameNote?: string;
  /** False for an agent restored after a host restart, until send_message starts the pump. */
  pumping: boolean;
  /** Usage so far of the turn in progress, from `usage.updated`; cleared when the turn completes. */
  liveUsage?: Usage;
  result?: string;
  usage?: Readonly<Record<string, unknown>>;
  lastError?: { readonly code: string; readonly message: string };
  waiters: (() => void)[];
  release: () => void;
}

export interface AgentSnapshot {
  readonly meta?: ExecutionMeta;
  readonly id: string;
  readonly name?: string;
  readonly backend: Backend;
  readonly model: string;
  readonly effort?: string;
  readonly agentConfig: string;
  readonly cwd: string;
  readonly state: ToolAgentState;
  readonly background: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timeoutSeconds: number | null;
  readonly timedOut?: boolean;
  readonly result?: string;
  readonly lastError?: { readonly code: string; readonly message: string };
  readonly warning?: string;
  readonly nameNote?: string;
}

export interface SpawnAgentInput {
  readonly isolation?: 'none' | 'worktree' | undefined;
  readonly permission?: PermissionConfig | undefined;
  readonly result_schema?: Record<string, unknown> | undefined;
  readonly group_id?: string | undefined;
  readonly depends_on?: readonly string[] | undefined;
  readonly agent: string;
  readonly prompt: string;
  readonly description: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly backend?: Backend | undefined;
  readonly name?: string | undefined;
  readonly run_in_background?: boolean | undefined;
  readonly max_turns?: number | undefined;
  readonly timeout?: number | undefined;
}

export interface SendMessageInput {
  readonly agent: string;
  readonly prompt: string;
  readonly effort?: string | undefined;
  readonly run_in_background?: boolean | undefined;
  /** Seconds. Overrides the agent config for this turn and is echoed as timeout_seconds. */
  readonly timeout?: number | undefined;
  /**
   * Required to resume a Codex agent that has been idle past the configured limit.
   * Codex replays the whole thread with no prompt cache.
   */
  readonly allow_expensive_resume?: boolean | undefined;
}

export interface SupervisorOptions {
  readonly registry: AgentConfigSource;
  readonly adapters: AdapterRegistry;
  readonly cwd: string;
  readonly routing?: RoutingStore;
  /** Called once when a turn whose caller did not block (run_in_background) settles or needs approval. */
  readonly onDetachedSettled?: (result: Readonly<Record<string, unknown>>) => void;
  /** Overrides the registry cap. Calls wait in FIFO order once this many agents are active. */
  readonly maxConcurrent?: number;
  /** Overrides the registry's Codex resume idle limit. */
  readonly codexResumeIdleMs?: number;
  readonly usage?: UsageLedger;
}

export class SupervisorError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "SUPERVISOR_ERROR", details);
  }
}

/** Backend-neutral orchestration: capacity/depth, blocking-with-escalation spawn/resume, and lookup. */
const CODEX_RESUME_WARNING =
  "Codex resume replays the whole thread with no prompt cache, so this turn is billed for the full history. " +
  "Prefer a fresh spawn_agent with a summary of the prior result when that history is long.";

export class Supervisor {
  readonly #registry: AgentConfigSource;
  readonly #adapters: AdapterRegistry;
  readonly #cwd: string;
  readonly #capacity: AgentCapacity;
  readonly #approvals: ApprovalCoordinator;
  readonly #agents = new Map<string, AgentRecord>();
  readonly #names = new Map<string, string>();
  readonly #events = new EventBuffer();
  readonly #routing: RoutingStore | undefined;
  readonly #onDetachedSettled: ((result: Readonly<Record<string, unknown>>) => void) | undefined;
  readonly #codexResumeIdleMs: number | undefined;
  readonly #usage: UsageLedger;
  #persistencePath: string | undefined;
  #resultsStore: AppendOnlyJsonlStore<Record<string, unknown>> | undefined;
  #nameCursor = 0;
  #writes: Promise<void> = Promise.resolve();
  #storageError: string | undefined;
  #pending = new Map<string, PendingTask>();
  #changes = new Set<() => void>();

  constructor(options: SupervisorOptions) {
    this.#registry = options.registry;
    this.#adapters = options.adapters;
    this.#cwd = options.cwd;
    this.#routing = options.routing;
    this.#onDetachedSettled = options.onDetachedSettled;
    this.#codexResumeIdleMs = options.codexResumeIdleMs;
    this.#usage = options.usage ?? new UsageLedger();
    this.#capacity = new AgentCapacity(options.maxConcurrent ?? options.registry.maxConcurrent());
    this.#approvals = new ApprovalCoordinator({
      adapterFor: (request) => this.#adapters.get(request.backend),
    });
  }

  setMaxConcurrent(limit: number): void {
    this.#capacity.setLimit(limit);
  }

  concurrency(): { readonly limit: number; readonly active: number; readonly waiting: number } {
    return {
      limit: this.#capacity.limit,
      active: this.#capacity.activeCount,
      waiting: this.#capacity.waitingCount,
    };
  }

  /**
   * Roster, local usage, allowances and concurrency. With `live` (default: on when one `backend` is
   * named), also asks each backend that has a live API (`providerInfo`: OpenCode, Codex) for the
   * models it can run and its own plan usage, and flags roster entries the backend does not offer.
   */
  async listModels(backend?: Backend, live: boolean = backend !== undefined): Promise<Readonly<Record<string, unknown>>> {
    const local = this.#localModels(backend);
    if (!live) return local;
    const adapters = this.#adapters.list().filter((adapter) =>
      adapter.providerInfo !== undefined && (backend === undefined || adapter.backend === backend));
    const entries = await Promise.all(adapters.map(async (adapter) =>
      [adapter.backend, await this.#liveInfo(adapter)] as const));
    if (entries.length === 0) return local;
    const byBackend = Object.fromEntries(entries);
    return { ...local, live: backend === undefined ? byBackend : byBackend[backend] };
  }

  async #liveInfo(adapter: BackendAdapter): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // Race as well as abort: an adapter stuck on a child that never started may not observe the signal.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${adapter.backend} live query timed out after ${LIVE_INFO_TIMEOUT_MS}ms`);
        controller.abort(error);
        reject(error);
      }, LIVE_INFO_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const info = await Promise.race([adapter.providerInfo!(controller.signal), timedOut]);
      if (info.models === undefined) return info;
      const offered = new Set(info.models.map((model) => model.id));
      const roster = this.#registry.listModels(adapter.backend) as readonly ModelEntry[];
      // Entries routed to a custom provider (e.g. endpoint models) are outside the backend's own catalog.
      const missing = roster.filter((entry) => entry.provider === undefined && !offered.has(entry.name)).map((entry) => entry.name);
      return { ...info, ...(missing.length === 0 ? {} : { roster_not_offered: missing }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  #localModels(backend?: Backend): Readonly<Record<string, unknown>> {
    const usage = this.#usage.snapshot();
    const allowances = this.#registry.allowances();
    const remaining = remainingAllowances(allowances, usage);
    const warning = this.#registry.configWarning();
    const filteredAllowance = backend === undefined ? allowances : allowances[backend];
    const filteredRemaining = backend === undefined ? remaining : remaining[backend];
    return {
      models: this.#registry.listModels(backend),
      usage: backend === undefined ? usage : usage[backend],
      ...(filteredAllowance === undefined || (backend !== undefined && filteredAllowance === undefined)
        ? {}
        : { allowances: filteredAllowance }),
      ...(filteredRemaining === undefined ? {} : { remaining: filteredRemaining }),
      concurrency: this.concurrency(),
      ...(warning === undefined ? {} : { config_warning: warning }),
    };
  }

  sessionView(input: ListAgentsInput = {}): Readonly<Record<string, unknown>> {
    const records = this.listAgents().filter(r =>
      (!input.states || input.states.includes(r.state as string)) &&
      (!input.backend || r.backend === input.backend) &&
      (!input.updated_since || String(r.updated_at) >= input.updated_since));
    let after: { time: string; id: string } | undefined;
    if (input.cursor) {
      try { after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
      catch { throw new SupervisorError('Invalid cursor'); }
      if (!after || typeof after.time !== 'string' || typeof after.id !== 'string') throw new SupervisorError('Invalid cursor');
    }
    const sorted = records.sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(a.agent_id).localeCompare(String(b.agent_id)));
    const filtered = after ? sorted.filter(r => String(r.updated_at) < after!.time || (r.updated_at === after!.time && String(r.agent_id) > after!.id)) : sorted;
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    return { agents: page,
      next_cursor: filtered.length > limit && last ? Buffer.from(JSON.stringify({ time: last.updated_at, id: last.agent_id })).toString('base64url') : null,
      concurrency: this.concurrency(), config_warning: this.#registry.configWarning(), storage_error: this.#storageError };
  }

  listAgents(): readonly Readonly<Record<string, unknown>>[] {
    return [...this.#agents.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map(record => this.#publicRecord(record)).concat([...this.#pending.values()].filter(task => !task.result?.agent_id).map(task => ({
        agent_id: task.id, state: task.state, backend: task.input.backend, updated_at: task.created_at, group_id: task.input.group_id,
      })));
  }

  listAgentConfigs() {
    return { configs: this.#registry.listAgents().map(config => ({ name: config.name, source_path: config.sourcePath,
      backend: config.backend, model: config.model, effort: config.reasoningEffort, capabilities: capabilities(config.backend) })),
      config_warning: this.#registry.configWarning() };
  }

  async waitForAgents(agents: readonly string[], mode: 'any' | 'all' = 'all', timeout = 60) {
    if (!agents.length) throw new SupervisorError('At least one agent is required');
    const states = () => agents.map(agent => this.#pending.has(agent) ? this.#pending.get(agent)!.result?.agent_id ? this.#requireRecord(String(this.#pending.get(agent)!.result!.agent_id)).state : this.#pending.get(agent)!.state : this.#requireRecord(agent).state);
    const ready = () => { const values = states(); return values.includes('needs_approval') ||
      (mode === 'all' ? values.every(v => !['starting','running','queued'].includes(v)) : values.some(v => !['starting','running','queued'].includes(v))); };
    let timed_out = false;
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const cleanup = () => { clearTimeout(timer); this.#changes.delete(check); };
      const check = () => { try { if (ready()) { cleanup(); resolve(); } } catch(error) { cleanup(); reject(error); } };
      this.#changes.add(check);
      timer = setTimeout(() => { timed_out = true; cleanup(); resolve(); }, Math.max(0, Math.min(60, timeout)) * 1000);
      check();
    });
    await this.#writes;
    return { timed_out, agents: agents.map(agent => this.#pending.has(agent) && !this.#pending.get(agent)!.result?.agent_id ? this.#pending.get(agent) : this.#result(this.#requireRecord(agent))) };
  }

  getAgentResult(agent: string, turn?: number, offset = 0, limit = 25): Record<string, unknown> | PendingTask {
    const pending = this.#pending.get(agent);
    if (pending) return pending.result?.agent_id ? this.getAgentResult(String(pending.result.agent_id), turn, offset, limit) : pending;
    const record = this.#requireRecord(agent);
    return { ...this.#result(record), turns: record.meta.history.slice(offset, offset + limit),
      selected_result: turn === undefined ? record.meta.history.at(-1) : record.meta.history.find(item => item.turn === turn),
      next_offset: offset + limit < record.meta.history.length ? offset + limit : null };
  }

  async cleanupWorktree(agent: string) {
    const record = this.#requireRecord(agent);
    if (['running','starting','needs_approval'].includes(record.state)) throw new SupervisorError('Agent is active');
    if (!record.meta.worktree) throw new SupervisorError('Agent has no managed worktree');
    await removeWorktree(record.meta.worktree);
    record.meta.cleaned = true;
    await this.#writeSnapshot();
    return { removed: true, branch: record.meta.worktree.branch };
  }

  async stopAgents(agents?: readonly string[], group?: string) {
    if (!agents && !group) throw new SupervisorError("Supply agents or group_id");
    const ids = agents ?? [...this.#agents.values()].filter(r => r.meta.group_id === group).map(r => r.id)
      .concat([...this.#pending.values()].filter(t => t.input.group_id === group).map(t => t.id));
    return Promise.all(ids.map(async id => {
      try { const task = this.#pending.get(id); if (task) { if (task.result?.agent_id) await this.stopAgent(String(task.result.agent_id)); task.state = 'interrupted'; await this.#writeSnapshot(); this.#changed(); return task; }
        return await this.stopAgent(id);
      } catch(error) { return { agent_id: id, error: String(error) }; }
    }));
  }

  #changed() { for (const listener of this.#changes) listener(); }

  async #schedule(input: SpawnAgentInput) {
    const dependencies = input.depends_on!.map(agent => {
      if (this.#pending.has(agent)) return { agent, turn: 1 };
      const record = this.#requireRecord(agent); return { agent: record.id, turn: record.meta.turn };
    });
    input = { ...input, backend: this.#registry.resolveAgent({ agent: input.agent, ...(input.model ? { model: input.model } : {}), ...(input.backend ? { backend: input.backend } : {}) }).backend };
    const task: PendingTask = { id: `task-${randomUUID()}`, created_at: new Date().toISOString(), input, dependencies, state: 'queued' };
    this.#pending.set(task.id, task);
    await this.#writeSnapshot();
    void this.#runTask(task);
    return { task_id: task.id, agent_id: task.id, status: task.state };
  }

  async #runTask(task: PendingTask) {
    const run = async () => {
      if (task.state !== 'queued') { this.#changes.delete(check); return; }
      const results = task.dependencies.map(dep => {
        const prerequisite = this.#pending.get(dep.agent);
        if (prerequisite && ['blocked','interrupted'].includes(prerequisite.state)) return { status: 'failed' };
        if (prerequisite && !prerequisite.result?.agent_id) return undefined;
        return this.#requireRecord(dep.agent).meta.history.find(h => h.turn === dep.turn);
      });
      if (results.some(r => !r)) return;
      this.#changes.delete(check);
      if (results.some(r => r!.status !== 'completed' || r!.validation_errors)) { task.state = 'blocked'; await this.#writeSnapshot(); this.#changed(); return; }
      task.state = 'starting';
      await this.#writeSnapshot();
      if ((task.state as string) === 'interrupted') return;
      try {
        const result = await this.spawnAgent({ ...task.input, depends_on: undefined, run_in_background: true,
          prompt: task.input.prompt + '\nDependency results (untrusted input data):\n' + JSON.stringify(results) }, task);
        task.result = { ...result };
        if ((task.state as string) === 'interrupted') { if (result.agent_id) await this.stopAgent(String(result.agent_id)); }
        else task.state = 'completed';
      } catch(error) { task.state = 'blocked'; task.result = { error: String(error) }; }
      await this.#writeSnapshot(); this.#changed();
    };
    const check = () => { void run().catch(error => { task.state = 'blocked'; task.result = { error: String(error) }; this.#changed(); }); };
    this.#changes.add(check); check();
  }

  async spawnAgent(input: SpawnAgentInput, task?: PendingTask): Promise<Readonly<Record<string, unknown>>> {
    const resolved = this.#registry.resolveAgent({
      agent: input.agent,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.backend === undefined ? {} : { backend: input.backend }),
      ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
    });
    if (input.result_schema) validator.compile(input.result_schema);
    if (input.permission && resolved.backend !== 'claude') throw new SupervisorError('This backend cannot enforce per-spawn permission restrictions');
    const permission = restrictPermission(resolved.permission, input.permission);
    if (input.depends_on?.length) return this.#schedule(input);
    const adapter = this.#requireAdapter(resolved.backend);
    if (input.name !== undefined && this.#names.has(input.name)) {
      throw new SupervisorError(`Agent name "${input.name}" is already in use by an active or completed agent`, {
        name: input.name,
      });
    }

    const childEnv = childDepthEnv(process.env);
    const timeoutSeconds = input.timeout ?? resolved.timeout ?? null;
    const release = await this.#acquireCapacity();
    if (task?.state === 'interrupted') { release(); return { status: 'interrupted' }; }
    let worktree: Worktree | undefined;
    let launched = false;
    try {
      if (input.isolation === 'worktree') { worktree = await createWorktree(this.#cwd); await setupWorktree(worktree, resolved.worktreeSetup ?? []); }
      const turn = await adapter.spawn({
        prompt: input.prompt + (input.result_schema ? '\nReturn only JSON matching this schema: ' + JSON.stringify(input.result_schema) : ''),
        description: input.description,
        model: resolved.model,
        ...(resolved.modelProvider === undefined ? {} : { modelProvider: resolved.modelProvider }),
        ...(resolved.antigravityAgent === undefined ? {} : { antigravityAgent: resolved.antigravityAgent }),
        cwd: worktree?.path ?? this.#cwd,
        systemPrompt: resolved.systemPrompt,
        env: { ...resolved.env, SUBAGENT_MCP_DEPTH: childEnv.SUBAGENT_MCP_DEPTH ?? "1" },
        permission,
        ...(input.max_turns !== undefined ? { maxTurns: input.max_turns } : resolved.maxTurns !== undefined ? { maxTurns: resolved.maxTurns } : {}),
        ...(timeoutSeconds === null ? {} : { timeoutMs: timeoutSeconds * 1000 }),
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      });
      launched = true;
      const now = new Date().toISOString();
      const picked = input.name !== undefined ? { name: input.name } : this.#nextAgentName();
      const name = picked.name;
      const record: AgentRecord = {
        meta: { turn: 1, history: [], ...(input.permission ? { permission } : {}), ...(worktree ? { worktree } : {}),
          ...(input.group_id ? { group_id: input.group_id } : {}), ...(input.result_schema ? { schema: input.result_schema } : {}) },
        id: turn.agentId,
        name,
        backend: resolved.backend,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { effort: resolved.reasoningEffort }),
        agentConfig: resolved.name,
        cwd: worktree?.path ?? this.#cwd,
        state: "starting",
        background: input.run_in_background === true,
        detached: input.run_in_background === true,
        createdAt: now,
        updatedAt: now,
        cursor: 0,
        timeoutSeconds,
        timedOut: false,
        ...(picked.note === undefined ? {} : { nameNote: picked.note }),
        pumping: true,
        waiters: [],
        release,
      };
      this.#agents.set(record.id, record);
      this.#names.set(name, record.id);
      this.#usage.recordSpawn(record.backend, record.model);
      this.#pump(record, adapter);
      if (record.state === "starting") record.state = "running";
      void this.#writeSnapshot().catch(error => { this.#storageError = String(error); });
      if (!record.background) await this.#waitForNotableState(record);
      return this.#result(record);
    } catch (error) {
      release();
      if (worktree && !launched) {
        try { await discardWorktree(worktree); }
        catch(cleanupError) { throw new SupervisorError(`Spawn failed: ${String(error)}. Cleanup failed for ${worktree.path}: ${String(cleanupError)}`); }
      }
      throw error;
    }
  }

  async sendMessage(input: SendMessageInput): Promise<Readonly<Record<string, unknown>>> {
    const record = this.#requireRecord(input.agent);
    if (record.meta.cleaned) throw new SupervisorError("Worktree was removed; spawn a new agent");
    if (record.state === "starting" || record.state === "running") {
      // No queue used to mean "already has an active turn" was a hard error, forcing the caller
      // to notice and manually resend once the child finished — finding #5 in
      // docs/reviews/usage-review-2026-09-05.md. One slot is enough: queueing a second message
      // while one is already waiting would silently drop whichever loses, so that's rejected too.
      if (record.pendingMessage !== undefined) {
        throw new SupervisorError(`Agent ${record.id} already has a message queued for delivery after its current turn`, {
          agentId: record.id,
        });
      }
      record.pendingMessage = {
        prompt: input.prompt,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      };
      if (input.timeout !== undefined) record.timeoutSeconds = input.timeout;
      record.updatedAt = new Date().toISOString();
      void this.#writeSnapshot().catch(error => { this.#storageError = String(error); });
      if (input.run_in_background === true) record.detached = true;
      else await this.#waitForNotableState(record);
      return this.#result(record);
    }
    if (record.state === "needs_approval") {
      throw new SupervisorError(`Agent ${record.id} has a pending approval; resolve it before sending a new message`, {
        agentId: record.id,
        requestId: record.pendingApprovalId,
      });
    }
    const adapter = this.#requireAdapter(record.backend);
    const warning = this.#codexResumeWarning(record, input.allow_expensive_resume === true);
    if (warning === undefined) delete record.warning;
    else record.warning = warning;
    // The agent went terminal and released its slot; resuming it is active work
    // again, so re-count it. The call waits when the pool is full.
    record.release = await this.#acquireCapacity();
    record.state = "running";
    record.timedOut = false;
    delete record.lastError;
    record.detached = input.run_in_background === true;
    delete record.result;
    record.updatedAt = new Date().toISOString();
    if (!record.pumping) {
      record.pumping = true;
      this.#pump(record, adapter);
    }
    try {
      await this.#deliverResume(record, adapter, input.prompt, input.effort ?? record.effort, input.timeout);
    } catch (error) {
      record.release();
      throw error;
    }
    if (input.run_in_background !== true) await this.#waitForNotableState(record);
    return this.#result(record);
  }

  /** Shared by sendMessage() and the queued-message delivery inside #pump(). */
  async #deliverResume(record: AgentRecord, adapter: BackendAdapter, prompt: string, effort?: string, timeout?: number): Promise<void> {
    const resolved = this.#registry.resolveAgent({
      agent: record.agentConfig,
      model: record.model,
      backend: record.backend,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
    const childEnv = childDepthEnv(process.env);
    const timeoutSeconds = timeout ?? resolved.timeout ?? record.timeoutSeconds;
    record.timeoutSeconds = timeoutSeconds;
    record.timedOut = false;
    if (resolved.reasoningEffort !== undefined) record.effort = resolved.reasoningEffort;
    record.meta.turn += 1;
    delete record.result;
    delete record.usage;
    delete record.meta.structured;
    delete record.meta.validation_errors;
    await adapter.resume({
      agentId: record.id,
      prompt: prompt + (record.meta.schema ? '\nReturn only JSON matching this schema: ' + JSON.stringify(record.meta.schema) : ''),
      cwd: record.cwd,
      model: record.model,
      ...(resolved.modelProvider === undefined ? {} : { modelProvider: resolved.modelProvider }),
      ...(resolved.antigravityAgent === undefined ? {} : { antigravityAgent: resolved.antigravityAgent }),
      systemPrompt: resolved.systemPrompt,
      env: { ...resolved.env, SUBAGENT_MCP_DEPTH: childEnv.SUBAGENT_MCP_DEPTH ?? "1" },
      permission: intersectPermission(resolved.permission, record.meta.permission),
      ...(resolved.maxTurns === undefined ? {} : { maxTurns: resolved.maxTurns }),
      ...(timeoutSeconds === null ? {} : { timeoutMs: timeoutSeconds * 1000 }),
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    });
    this.#usage.recordResume(record.backend, record.model);
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision, message?: string): Promise<Readonly<Record<string, unknown>>> {
    const record = [...this.#agents.values()].find((candidate) => candidate.pendingApprovalId === requestId);
    if (!record) throw new SupervisorError(`No agent has pending approval ${requestId}`, { requestId });
    const adapter = this.#requireAdapter(record.backend);
    await this.#approvals.resolve(requestId, decision, message);
    delete record.pendingApprovalId;
    record.state = "running";
    record.updatedAt = new Date().toISOString();
    await this.#waitForNotableState(record);
    const settledState = this.#currentState(record);
    if (
      decision === "deny" &&
      message !== undefined &&
      !adapter.relaysDenyMessage &&
      (settledState === "completed" || settledState === "failed" || settledState === "interrupted")
    ) {
      // This backend's approval-response protocol has no field for `message` (see
      // BackendAdapter.relaysDenyMessage) — the deny just silently ended the turn, which reads
      // to the caller as a hard stop rather than feedback. Deliver `message` as a follow-up turn
      // instead of leaving the caller to notice and resend it by hand (finding #1 in
      // docs/reviews/usage-review-2026-09-05.md).
      return this.sendMessage({ agent: record.id, prompt: message });
    }
    return this.#result(record);
  }

  async stopAgent(agent: string): Promise<Readonly<Record<string, unknown>>> {
    const record = this.#requireRecord(agent);
    if (record.state === "completed" || record.state === "interrupted" || record.state === "failed") {
      return this.#result(record);
    }
    const adapter = this.#requireAdapter(record.backend);
    if (record.pendingApprovalId !== undefined) {
      try {
        this.#approvals.cancel(record.pendingApprovalId);
      } catch {
        // best-effort; the watchdog will reconcile if this races a resolution
      }
    }
    // A deliberate stop should not be undone by a message queued before it arrived.
    delete record.pendingMessage;
    record.detached = false; // this call blocks on the outcome itself
    await adapter.interrupt(record.id);
    await this.#waitForNotableState(record);
    return this.#result(record);
  }

  getAgentEvents(
    agent: string,
    since: number,
    limit?: number,
  ): {
    readonly agent_id: string;
    readonly name: string;
    readonly events: readonly AgentEvent[];
    readonly nextSequence: number;
    readonly currentSequence: number;
    readonly hasMore?: boolean;
  } {
    const record = this.#requireRecord(agent);
    const read = this.#events.read(record.id, since, limit);
    return {
      agent_id: record.id,
      name: record.name,
      events: read.events,
      nextSequence: read.nextSequence,
      currentSequence: read.currentSequence,
      ...(read.hasMore === undefined ? {} : { hasMore: read.hasMore }),
    };
  }

  async recordOutcome(agent: string, verdict: "success" | "partial" | "failure", score?: number, notes?: string): Promise<void> {
    const record = this.#requireRecord(agent);
    if (!this.#routing) return;
    await this.#routing.append({
      kind: "outcome",
      delegationId: record.id,
      recordedAt: new Date().toISOString(),
      scope: "project",
      verdict,
      ...(score === undefined ? {} : { score }),
      ...(notes === undefined ? {} : { notes }),
    });
  }

  async addNote(text: string, scope: MemoryScope = "project"): Promise<void> {
    if (!this.#routing) return;
    await this.#routing.append({
      kind: "note",
      recordedAt: new Date().toISOString(),
      scope,
      text,
    });
  }

  #pump(record: AgentRecord, adapter: BackendAdapter): void {
    void (async () => {
      try {
        for await (const event of adapter.events(record.id, { since: record.cursor })) {
          record.cursor = event.sequence;
          this.#events.append({ type: event.type, agentId: record.id, backend: event.backend, data: event.data } as never);
          const previousActivity = record.meta.checkpointAt;
          record.updatedAt = new Date().toISOString();
          record.meta.activityAt = record.updatedAt;
          if (event.type === 'tool.start') record.meta.activity = scanChildOutput(event.data.toolName).slice(0,160);
          if (event.type === 'tool.end' || event.type === 'turn.completed') delete record.meta.activity;
          if (!previousActivity || Date.parse(record.updatedAt) - Date.parse(previousActivity) >= 5000 || event.type === 'tool.start' || event.type === 'tool.end') { record.meta.checkpointAt = record.updatedAt; void this.#writeSnapshot().catch(() => {}); }
          if (event.type === "approval.requested") {
            const current = this.#registry.resolveAgent({ agent: record.agentConfig, model: record.model, backend: record.backend });
            const routed = await this.#approvals.route(event.data, intersectPermission(current.permission, record.meta.permission), record.meta.permission !== undefined);
            if (routed.status === "pending") {
              record.state = "needs_approval";
              record.pendingApprovalId = event.data.requestId;
              await this.#notify(record);
            }
            continue;
          }
          if (event.type === "usage.updated") {
            record.liveUsage = { ...event.data.usage };
            continue;
          }
          if (event.type === "turn.completed") {
            delete record.liveUsage;
            if (event.data.finalText !== undefined) record.result = scanChildOutput(event.data.finalText);
            if (event.data.usage !== undefined) record.usage = { ...event.data.usage };
            if (record.meta.history.some(h => h.turn_id === event.data.turnId)) continue;
            if (record.meta.schema && event.data.status === 'completed') {
              try {
                const value: unknown = JSON.parse(event.data.finalText ?? '');
                const validate = validator.compile(record.meta.schema);
                if (validate(value)) record.meta.structured = value;
                else record.meta.validation_errors = validate.errors;
              } catch(error) { record.meta.validation_errors = String(error); }
            }
            const outcome = { agent_id: record.id, turn: record.meta.turn, turn_id: event.data.turnId,
              status: event.data.status, result: record.result, usage: record.usage, finished_at: record.updatedAt,
              structured_result: record.meta.structured, validation_errors: record.meta.validation_errors };
            if (!record.meta.history.some(h => h.turn_id === event.data.turnId)) {
              await this.#resultsStore?.append(outcome);
              record.meta.history.push(outcome);
            }
            const pending = record.pendingMessage;
            if (pending !== undefined) {
              // A send_message arrived mid-turn and was queued (finding #5 in
              // docs/reviews/usage-review-2026-09-05.md); deliver it now instead of surfacing
              // this turn's outcome as final. record.state stays "running" throughout, so
              // #waitForNotableState callers (sendMessage/resolveApproval) keep waiting correctly.
              delete record.pendingMessage;
              record.updatedAt = new Date().toISOString();
              this.#usage.recordTurn(record.backend, record.model, event.data.usage, {
                failed: event.data.status !== "completed",
                timedOut: record.timedOut,
              });
              record.timedOut = false;
              await this.#deliverResume(record, adapter, pending.prompt, pending.effort, pending.timeout);
              continue;
            }
            record.state = event.data.status === "completed" ? "completed"
              : event.data.status === "interrupted" ? "interrupted" : "failed";
            this.#usage.recordTurn(record.backend, record.model, event.data.usage, {
              failed: event.data.status !== "completed",
              timedOut: record.timedOut,
            });
            // Free the capacity slot the moment the turn ends. The event
            // subscription below is long-lived (it stays open so a later
            // sendMessage resume can push more events), so the `finally` block
            // never runs for an agent that completes normally — without this
            // call every finished background agent leaks its slot until the
            // process exits. `release` is idempotent.
            record.release();
            await this.#notify(record);
            continue;
          }
          if (event.type === "error") {
            record.lastError = { code: event.data.code, message: scanChildOutput(event.data.message) };
            if (/TIMEOUT/.test(event.data.code)) record.timedOut = true;
            if (event.data.fatal) {
              record.state = "failed";
              record.release();
              await this.#notify(record);
            }
          }
        }
      } catch (error) {
        record.state = "failed";
        record.lastError = { code: "SUPERVISOR_STREAM_ERROR", message: error instanceof Error ? error.message : String(error) };
        await this.#notify(record);
      } finally {
        if (record.state !== "running" && record.state !== "starting" && record.state !== "needs_approval") {
          record.release();
        }
      }
    })();
  }

  /** Opaque re-read, breaking TS's narrowing of `record.state` across the preceding `await`. */
  #currentState(record: AgentRecord): ToolAgentState {
    return record.state;
  }

  async #notify(record: AgentRecord): Promise<void> {
    if (record.state !== 'running' && record.state !== 'starting') delete record.meta.activity;
    if (!['running','starting','needs_approval'].includes(record.state) && !record.meta.history.some(h => h.turn === record.meta.turn)) {
      const outcome = { agent_id: record.id, turn: record.meta.turn, status: record.state, result: record.result,
        error: record.lastError, finished_at: record.updatedAt };
      try {
        await this.#resultsStore?.append(outcome);
        record.meta.history.push(outcome);
      } catch(error) { this.#storageError = String(error); }
    }
    try { await this.#writeSnapshot(); }
    catch(error) { this.#storageError = String(error); record.lastError = { code: 'STORAGE_ERROR', message: String(error) }; }
    this.#changed();
    if (record.detached && record.state !== "running" && record.state !== "starting") {
      // Nobody is blocked on this turn, so push the outcome instead of leaving the caller to poll.
      // Cleared first: the follow-up (resolve_approval / send_message) blocks, or re-sets it.
      record.detached = false;
      try {
        this.#onDetachedSettled?.(this.#result(record));
      } catch {
        // A failing notifier must not break the event pump.
      }
    }
    const waiters = record.waiters;
    record.waiters = [];
    for (const waiter of waiters) waiter();
  }

  #waitForNotableState(record: AgentRecord): Promise<void> {
    if (record.state !== "running" && record.state !== "starting") return Promise.resolve();
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  #result(record: AgentRecord): Readonly<Record<string, unknown>> {
    const base = {
      storage_error: this.#storageError,
      turn: record.meta.turn,
      group_id: record.meta.group_id,
      worktree: record.meta.worktree,
      filesystem_boundary_enforced: false,
      structured_result: record.meta.structured,
      validation_errors: record.meta.validation_errors,
      agent_id: record.id,
      name: record.name,
      backend: record.backend,
      model: record.model,
      ...(record.effort === undefined ? {} : { effort: record.effort }),
      timeout_seconds: record.timeoutSeconds,
      ...(record.warning === undefined ? {} : { warning: record.warning }),
      ...(record.nameNote === undefined ? {} : { name_note: record.nameNote }),
    };
    if (record.state === "needs_approval") {
      return { ...base, status: "needs_approval", ...this.#approvalDetails(record) };
    }
    if (record.state === "running" || record.state === "starting") {
      return { ...base, status: "running", ...(record.pendingMessage === undefined ? {} : { queued: true }) };
    }
    return {
      ...base,
      status: record.state,
      result: record.result,
      usage: record.usage,
      cumulative_usage: this.#totalUsage(record),
      ...(record.timedOut ? { timed_out: true } : {}),
      ...(record.lastError === undefined ? {} : { error: record.lastError }),
    };
  }

  /** Completed turns plus, while one is running, the live usage of the turn in progress. */
  #totalUsage(record: AgentRecord) {
    const totals: Record<string, number | null> = {};
    const live = record.liveUsage as Record<string, unknown> | undefined;
    for (const key of ['inputTokens','outputTokens','cachedInputTokens','uncachedInputTokens','costUsd']) {
      // A live turn only adds what it already reports (cost often arrives only at turn end).
      const usages = [...record.meta.history.map(h => (h.usage as Record<string, unknown> | undefined)?.[key]),
        ...(live?.[key] === undefined ? [] : [live[key]])];
      totals[key] = usages.length && usages.every(v => typeof v === 'number') ? (usages as number[]).reduce((a,b) => a+b, 0) : null;
    }
    return totals;
  }

  /**
   * The pending approval's structured detail (command/cwd/reason/etc.), shared by `#result()`
   * and `#publicRecord()` so `list_agents` doesn't force a `get_agent_events` grep through the
   * full event log just to see what a `needs_approval` agent is waiting on (finding #4 in
   * docs/reviews/usage-review-2026-09-05.md).
   */
  #approvalDetails(record: AgentRecord): Readonly<Record<string, unknown>> {
    const approval = this.#approvals.get(record.pendingApprovalId ?? "");
    const request = approval?.request;
    return {
      request_id: record.pendingApprovalId,
      tool_name: request?.toolName,
      command: request?.command,
      input: request?.input,
      paths: request?.paths,
      cwd: request?.cwd,
      reason: request?.reason === undefined ? undefined : scanChildOutput(request.reason),
      expires_at: approval && approval.status === "pending" ? approval.expiresAt : undefined,
    };
  }

  #publicRecord(record: AgentRecord): Readonly<Record<string, unknown>> {
    return {
      turn: record.meta.turn,
      group_id: record.meta.group_id,
      worktree: record.meta.worktree,
      filesystem_boundary_enforced: false,
      result_validation: record.meta.schema ? record.meta.validation_errors ? "invalid" : record.meta.structured !== undefined ? "valid" : "pending" : undefined,
      agent_id: record.id,
      name: record.name,
      backend: record.backend,
      model: record.model,
      ...(record.effort === undefined ? {} : { effort: record.effort }),
      state: record.state,
      ...(record.state === "needs_approval" ? this.#approvalDetails(record) : {}),
      ...(record.pendingMessage === undefined ? {} : { queued: true }),
      background: record.background,
      timeout_seconds: record.timeoutSeconds,
      ...(record.timedOut ? { timed_out: true } : {}),
      ...(record.warning === undefined ? {} : { warning: record.warning }),
      last_activity_at: record.meta.activityAt,
      current_activity: record.meta.activity ?? null,
      activity_source: record.meta.activity ? 'tool_event' : null,
      cumulative_usage: this.#totalUsage(record),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  /**
   * Codex resume replays the thread uncached. Warn on every resume, and refuse once the agent
   * has been idle past the configured limit unless the caller opts in.
   */
  #codexResumeWarning(record: AgentRecord, allowExpensive: boolean): string | undefined {
    if (record.backend !== "codex") return undefined;
    const idleMs = Math.max(0, Date.now() - Date.parse(record.updatedAt));
    const limitMs = this.#codexResumeIdleMs ?? this.#registry.codexResumeIdleMs();
    const idleMinutes = Math.max(0, Math.round(idleMs / 60_000));
    const warning = `${CODEX_RESUME_WARNING} This agent has been idle for about ${idleMinutes} minute(s).`;
    if (idleMs >= limitMs && !allowExpensive) {
      const limitMinutes = Math.max(1, Math.round(limitMs / 60_000));
      throw new SupervisorError(
        `${warning} Refusing to resume after ${limitMinutes} minute(s) idle. ` +
          "Pass allow_expensive_resume: true to resume anyway, or spawn a new agent with a summary.",
        { agentId: record.id, idle_ms: idleMs, limit_ms: limitMs },
      );
    }
    return warning;
  }

  enablePersistence(path: string): void {
    this.#persistencePath = path;
    this.#resultsStore = new AppendOnlyJsonlStore(path + '.results.jsonl');
    void this.#writeSnapshot().catch(error => { this.#storageError = String(error); });
  }

  async recoverResults(): Promise<void> {
    if (!this.#persistencePath) return;
    await this.#resultsStore!.repairTail();
    const records = await this.#resultsStore!.readAll();
    for (const { value } of records) {
      const record = this.#agents.get(String(value.agent_id));
      if (!record) continue;
      if (!record.meta.history.some(h => h.turn === value.turn)) record.meta.history.push(value);
      if (Number(value.turn) >= record.meta.turn) {
        record.meta.turn = Number(value.turn);
        record.state = value.status as ToolAgentState;
        if (record.lastError?.code === 'HOST_RESTARTED') delete record.lastError;
        if (typeof value.result === 'string') record.result = value.result;
        if (value.structured_result !== undefined) record.meta.structured = value.structured_result;
        if (value.validation_errors !== undefined) record.meta.validation_errors = value.validation_errors;
        if (value.usage) record.usage = value.usage as Record<string, unknown>;
      }
    }
    for (const record of this.#agents.values()) {
      if (!['running','starting','needs_approval'].includes(record.state) && !record.meta.history.some(h => h.turn === record.meta.turn)) await this.#notify(record);
    }
  }

  restorePending(tasks: readonly PendingTask[]): void {
    for (const task of tasks) {
      if (task.state === 'starting') task.state = 'interrupted';
      this.#pending.set(task.id, task);
    }
    for (const task of tasks) if (task.state === 'queued') void this.#runTask(task);
  }

  exportSnapshot(): readonly AgentSnapshot[] {
    return [...this.#agents.values()].map((record) => this.#snapshot(record));
  }

  /** Rebuilds agent identity after a host restart. Live turns are marked interrupted; resume still works. */
  restore(agents: readonly AgentSnapshot[]): void {
    const reservedNames = new Set(
      agents.flatMap((snapshot) => snapshot.name === undefined ? [] : [snapshot.name.toLowerCase()]),
    );
    for (const snapshot of agents) {
      if (this.#agents.has(snapshot.id)) continue;
      if (snapshot.id.trim() === "" || snapshot.model.trim() === "") continue;
      const live = snapshot.state === "starting" || snapshot.state === "running" || snapshot.state === "needs_approval";
      const picked = snapshot.name !== undefined ? { name: snapshot.name } : this.#nextAgentName(reservedNames);
      const name = picked.name;
      reservedNames.add(name.toLowerCase());
      const record: AgentRecord = {
        meta: snapshot.meta ?? { turn: 1, history: [] },
        id: snapshot.id,
        name,
        backend: snapshot.backend,
        model: snapshot.model,
        ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
        agentConfig: snapshot.agentConfig,
        cwd: snapshot.cwd,
        state: live ? "interrupted" : snapshot.state,
        background: snapshot.background,
        detached: false,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        cursor: 0,
        timeoutSeconds: snapshot.timeoutSeconds,
        timedOut: snapshot.timedOut === true,
        ...(snapshot.warning === undefined ? {} : { warning: snapshot.warning }),
        ...((snapshot.nameNote ?? picked.note) === undefined ? {} : { nameNote: (snapshot.nameNote ?? picked.note)! }),
        pumping: false,
        ...(snapshot.meta?.history.at(-1)?.usage ? { usage: snapshot.meta.history.at(-1)!.usage as Record<string, unknown> } : {}),
        ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
        ...(live
          ? {
              lastError: {
                code: "HOST_RESTARTED",
                message: "The subagent host restarted while this agent was running. send_message resumes it.",
              },
            }
          : snapshot.lastError === undefined
            ? {}
            : { lastError: snapshot.lastError }),
        waiters: [],
        release: () => undefined,
      };
      if (live) delete record.meta.activity;
      this.#agents.set(record.id, record);
      this.#names.set(name, record.id);
    }
  }

  #snapshot(record: AgentRecord): AgentSnapshot {
    return {
      meta: record.meta,
      id: record.id,
      name: record.name,
      backend: record.backend,
      model: record.model,
      ...(record.effort === undefined ? {} : { effort: record.effort }),
      agentConfig: record.agentConfig,
      cwd: record.cwd,
      state: record.state,
      background: record.background,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      timeoutSeconds: record.timeoutSeconds,
      ...(record.timedOut ? { timedOut: true } : {}),
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      ...(record.warning === undefined ? {} : { warning: record.warning }),
      ...(record.nameNote === undefined ? {} : { nameNote: record.nameNote }),
    };
  }

  #writeSnapshot(): Promise<void> {
    const operation = this.#writes.then(() => this.#saveSnapshot());
    this.#writes = operation.catch(error => { this.#storageError = String(error); });
    return operation;
  }

  async #saveSnapshot(): Promise<void> {
    const path = this.#persistencePath;
    if (path === undefined) return;
    const body = `${JSON.stringify({ version: 1, agents: this.exportSnapshot(), pending: [...this.#pending.values()] }, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  #requireRecord(agentOrName: string): AgentRecord {
    const task = this.#pending.get(agentOrName);
    if (task?.result?.agent_id) return this.#requireRecord(String(task.result.agent_id));
    const id = this.#names.get(agentOrName) ?? agentOrName;
    const record = this.#agents.get(id);
    if (!record) throw new SupervisorError(`Unknown agent "${agentOrName}"`, { agent: agentOrName });
    return record;
  }

  /**
   * Random name. A name no agent has ever carried is preferred; once the pool is used up, a name held by
   * no live agent is reused and the result carries a note, so the model does not confuse the new agent with an old one
   * of the same name (old agents stay addressable by agent_id; the name resolves to the newest).
   */
  #nextAgentName(reservedNames?: ReadonlySet<string>): { name: string; note?: string } {
    const holders = new Map<string, AgentRecord[]>();
    for (const record of this.#agents.values()) {
      const key = record.name.toLowerCase();
      holders.set(key, [...(holders.get(key) ?? []), record]);
    }
    const isLive = (record: AgentRecord) => record.state === "starting" || record.state === "running" || record.state === "needs_approval";
    const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;
    const fresh = AGENT_NAMES.filter((name) => !holders.has(name.toLowerCase()) && !reservedNames?.has(name.toLowerCase()));
    if (fresh.length > 0) return { name: pick(fresh) };
    const candidates = AGENT_NAMES.filter((name) => !(holders.get(name.toLowerCase()) ?? []).some(isLive));
    if (candidates.length > 0) {
      const name = pick(candidates);
      const previous = holders.get(name.toLowerCase()) ?? [];
      const count = previous.length;
      return {
        name,
        note: `The name "${name}" was already given to ${count} earlier agent${count === 1 ? "" : "s"} (finished). This is a NEW, different agent: do not confuse it with the old one(s); address old agents by agent_id.`,
      };
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${AGENT_NAMES[0]}-${suffix}`;
      if (!holders.has(candidate.toLowerCase())) return { name: candidate };
    }
  }

  #requireAdapter(backend: Backend): BackendAdapter {
    try {
      return this.#adapters.get(backend);
    } catch {
      throw new ConfigurationError(`Backend "${backend}" is not available in this server (no adapter registered)`, { backend });
    }
  }

  #acquireCapacity(): Promise<() => void> {
    const placeholder = `pending-${randomUUID()}`;
    return this.#capacity.acquireWhenFree(placeholder);
  }
}

export function modelRosterList(entries: readonly ModelEntry[]): readonly string[] {
  return entries.map((entry) => entry.name);
}

export async function defaultProjectRouting(projectRoot: string): Promise<RoutingStore> {
  const paths = projectRoutingPaths(projectRoot);
  await ensureProjectMemoryIgnored(projectRoot);
  return new RoutingStore(paths);
}
