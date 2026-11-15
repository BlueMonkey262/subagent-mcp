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
  /** Captured Antigravity custom-agent definition used for this conversation. */
  agentDefinition?: AgentDefinitionMetadata;
  /** Set when the agent was started from a queued task: the task's id and creation time, which fix its list position. */
  queued_from?: string;
  queued_at?: string;
  /** Scheduled start of the queued task that produced this agent, when it was delayed. */
  start_at?: string;
  /** Completion ping policy; defaults to always. */
  notify?: NotifyMode;
}

interface AgentDefinitionMetadata {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: "explicit" | "project" | "global";
  readonly portable: boolean;
  readonly sha256: string;
  readonly description?: string;
  readonly tools?: readonly string[];
  readonly permission?: unknown;
  readonly capturedAt: string;
  /** Project-local copy of the exact definition, when persistence is enabled. */
  readonly snapshotPath?: string;
  /** Antigravity owns tool policy; this bridge only passes --agent. */
  readonly bridge_enforced: false;
}
type Row = Readonly<Record<string, unknown>>;
/** Position of a listed row. An agent started from a queued task keeps that task's position, so the task turning into an agent never moves it between pages. */
const listKey = (r: Row) => ({ at: String(r.queued_at ?? r.created_at), id: String(r.queued_from ?? r.agent_id) });
const newestFirst = (a: Row, b: Row) => listKey(b).at.localeCompare(listKey(a).at) || listKey(b).id.localeCompare(listKey(a).id);
export interface ListAgentsInput {
  states?: string[] | undefined; backend?: Backend | undefined; updated_since?: string | undefined;
  limit?: number | undefined; cursor?: string | undefined;
}
export type NotifyMode = 'always' | 'on_failure' | 'never';

/** One prerequisite of a queued task: the pinned turn's result, or why it can never arrive. */
interface DependencyCheck {
  readonly agent: string;
  readonly turn: number;
  readonly result?: Row;
  readonly error?: FailureInfo;
}

interface PendingTask {
  id: string; created_at: string; updated_at?: string; input: SpawnAgentInput; dependencies: { agent: string; turn: number }[];
  state: 'queued' | 'starting' | 'blocked' | 'interrupted' | 'completed'; result?: Record<string, unknown>;
  /** ISO time before which the task must not start, fixed when it was scheduled so it survives restart. */
  start_at?: string;
  /** Completion ping policy; defaults to always. */
  notify?: NotifyMode;
}


import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AdapterRegistry, type AdapterLiveness, type BackendAdapter } from "./adapters/adapter.js";
import {
  AntigravityAgentDefinitionError,
  FileAntigravityAgentResolver,
  type AntigravityAgentDefinition,
  type AntigravityAgentResolver,
} from "./adapters/antigravity/agent-definition.js";import { ApprovalCoordinator } from "./approval/coordinator.js";
import type { ApprovalDecision } from "./approval/types.js";
import { AGENT_NAMES } from "./agent-names.js";
import type { AgentConfigSource } from "./config/registry.js";
import type { Backend, Usage } from "./core/types.js";
import { BACKENDS } from "./core/types.js";
import type { ModelConcurrencyRule, ModelEntry, ResolvedAgentConfig } from "./config/schema.js";
import { AgentCapacity, childDepthEnv, DEFAULT_SCHEDULED_GRACE_MS } from "./core/limits.js";
import { blockReason, describeBlock, isRestrictive, matchesModelPattern, ModelBlockedError } from "./core/model-policy.js";
import { ConfigInvalidError, ConfigurationError, SubagentError } from "./core/errors.js";
import { classifyFailure, normalizeFailure, type FailureInfo } from "./core/failure.js";
import { EventBuffer } from "./events/buffer.js";
import type { EventReadOptions } from "./events/buffer.js";
import type { AgentEvent, NormalizedEventData } from "./events/schema.js";
import { scanChildOutput } from "./safety/output.js";
import { describeToolInput } from "./tool-describe.js";
import { remainingAllowances, UsageLedger } from "./usage.js";
import { MAX_CONTENT_CHARS, truncateText } from "./truncate.js";
import { compareVersions, currentVersion, updateCheckDisabled } from "./update-check.js";

/** Cap on one backend's live `providerInfo` query, so `list_models` never hangs on it. */
const LIVE_INFO_TIMEOUT_MS = 30_000;
/** Longest a delayed spawn may be scheduled ahead. */
const MAX_SCHEDULE_MS = 7 * 24 * 60 * 60 * 1000;
/** Node's setTimeout limit; longer waits are re-armed in chunks. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Bound on persisted completion pings waiting for a client to attach. */
const MAX_UNDELIVERED_PINGS = 100;

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
  /** Last event observed from the adapter, separate from user-visible activity. */
  heartbeatAt: string;
  /** Consecutive authoritative stale probes; two transitions the agent to failed. */
  staleProbes: number;
  staleSince?: string;
  cursor: number;
  /** Adapter turn id for the turn in progress, when known. */
  currentTurnId?: string;
  pendingApprovalId?: string;
  /** One queued send_message, delivered once the current turn reaches turn.completed. */
  pendingMessage?: {
    readonly prompt: string;
    readonly effort?: string;
    readonly timeout?: number;
    /** Carried so a queued Antigravity resume can accept a changed agent definition. */
    readonly allowDefinitionChange?: boolean;
  };
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
  lastError?: FailureInfo;
  /** Supervisor turn number that produced `lastError`, so a stale error cannot label a later turn. */
  lastErrorTurn?: number;
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
  readonly lastError?: FailureInfo;
  readonly warning?: string;
  readonly nameNote?: string;
}

export interface SpawnAgentInput {
  readonly isolation?: 'none' | 'worktree' | undefined;
  readonly permission?: PermissionConfig | undefined;
  readonly result_schema?: Record<string, unknown> | undefined;
  readonly group_id?: string | undefined;
  readonly depends_on?: readonly string[] | undefined;
  /** ISO datetime at which a queued spawn may start. Mutually exclusive with delay_seconds. */
  readonly start_at?: string | undefined;
  /** Positive seconds from now at which a queued spawn may start. Mutually exclusive with start_at. */
  readonly delay_seconds?: number | undefined;
  /** When to push a completion ping: always (default), on_failure, or never. */
  readonly notify?: NotifyMode | undefined;
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
  readonly max_result_chars?: number | undefined;
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
  readonly max_result_chars?: number | undefined;
  /** When to push a completion ping for this and later turns: always (default), on_failure, or never. */
  readonly notify?: NotifyMode | undefined;
  /** Seconds to wait before returning a running receipt instead of blocking for the whole turn. */
  readonly wait_seconds?: number | undefined;
  /** Resume an Antigravity conversation even though its custom-agent file changed. */
  readonly allow_agent_definition_change?: boolean | undefined;
}

export interface SupervisorOptions {
  readonly registry: AgentConfigSource;
  readonly adapters: AdapterRegistry;
  readonly cwd: string;
  /** Called once when a turn whose caller did not block (run_in_background) settles or needs approval. */
  readonly onDetachedSettled?: (result: Readonly<Record<string, unknown>>) => void;
  /** Overrides the registry cap. Calls wait in FIFO order once this many agents are active. */
  readonly maxConcurrent?: number;
  /** Overrides the registry's Codex resume idle limit. */
  readonly codexResumeIdleMs?: number;
  /** Overrides the registry's stale-agent heartbeat threshold. */
  readonly staleAgentMs?: number;
  /** Overrides the default send_message wait budget. */
  readonly sendMessageWaitMs?: number;
  /** Overrides how late a restored scheduled task may start before it is blocked. */
  readonly scheduledGraceMs?: number;
  /** Resolves Antigravity custom-agent definitions for audit and drift checks. */
  readonly antigravityResolver?: AntigravityAgentResolver;
  readonly usage?: UsageLedger;
  /** Update cache written by the host's background release check. */
  readonly updateCachePath?: string;
}

export class SupervisorError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "SUPERVISOR_ERROR", details);
  }
}

/** Shutdown began before a child launched: a queued task must stay queued for the next host. */
class HostShutdownError extends SupervisorError {
  constructor() {
    super("The host began shutting down before the task launched", { reason: "shutting_down" });
  }
}

function resolveNotify(value: unknown, fallback: NotifyMode = 'always'): NotifyMode {
  if (value === undefined) return fallback;
  if (value === 'always' || value === 'on_failure' || value === 'never') return value;
  throw new SupervisorError('notify must be "always", "on_failure", or "never"', { notify: value });
}

/** Resolve start_at/delay_seconds to one fixed ISO start time, rejecting both, the past, and >7 days. */
function resolveStartAt(input: { readonly start_at?: string | undefined; readonly delay_seconds?: number | undefined }, now = Date.now()): string | undefined {
  if (input.start_at !== undefined && input.delay_seconds !== undefined) {
    throw new SupervisorError('Provide exactly one of start_at or delay_seconds, not both');
  }
  if (input.delay_seconds !== undefined) {
    const seconds = input.delay_seconds;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new SupervisorError('delay_seconds must be a positive integer', { delay_seconds: seconds });
    }
    if (seconds * 1000 > MAX_SCHEDULE_MS) {
      throw new SupervisorError('delay_seconds must be at most 7 days (604800 seconds)', { delay_seconds: seconds });
    }
    return new Date(now + seconds * 1000).toISOString();
  }
  if (input.start_at === undefined) return undefined;
  const start = Date.parse(input.start_at);
  if (!Number.isFinite(start)) {
    throw new SupervisorError('start_at must be a valid ISO datetime', { start_at: input.start_at });
  }
  if (start <= now) {
    throw new SupervisorError('start_at must be in the future', { start_at: input.start_at });
  }
  if (start - now > MAX_SCHEDULE_MS) {
    throw new SupervisorError('start_at must be at most 7 days in the future', { start_at: input.start_at });
  }
  return new Date(start).toISOString();
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
  readonly #onDetachedSettled: ((result: Readonly<Record<string, unknown>>) => void) | undefined;
  readonly #codexResumeIdleMs: number | undefined;
  readonly #antigravityResolver: AntigravityAgentResolver;
  #staleAgentMs: number;
  #sendMessageWaitMs: number;
  #scheduledGraceMs: number;
  readonly #usage: UsageLedger;
  readonly #updateCachePath: string | undefined;
  #persistencePath: string | undefined;
  #persistenceClosed = false;
  #resultsStore: AppendOnlyJsonlStore<Record<string, unknown>> | undefined;
  #nameCursor = 0;
  #writes: Promise<void> = Promise.resolve();
  #storageError: string | undefined;
  #pending = new Map<string, PendingTask>();
  #taskTimers = new Map<string, NodeJS.Timeout>();
  #taskRuns = new Set<Promise<void>>();
  #stopping = false;
  #undeliveredPings: Record<string, unknown>[] = [];
  #pingFlush: Promise<void> = Promise.resolve();
  #changes = new Set<() => void>();

  constructor(options: SupervisorOptions) {
    this.#registry = options.registry;
    this.#adapters = options.adapters;
    this.#cwd = options.cwd;
    this.#onDetachedSettled = options.onDetachedSettled;
    this.#codexResumeIdleMs = options.codexResumeIdleMs;
    this.#antigravityResolver = options.antigravityResolver ?? new FileAntigravityAgentResolver();
    this.#staleAgentMs = options.staleAgentMs ?? options.registry.staleAgentMs();
    this.#sendMessageWaitMs = options.sendMessageWaitMs ?? options.registry.sendMessageWaitMs();
    this.#scheduledGraceMs = options.scheduledGraceMs ?? options.registry.scheduledGraceMs();
    this.#usage = options.usage ?? new UsageLedger();
    this.#updateCachePath = options.updateCachePath;
    this.#capacity = new AgentCapacity(options.maxConcurrent ?? options.registry.maxConcurrent());
    this.setCapacityConfig(options.registry.perBackendConcurrency(), options.registry.perModelConcurrency());
    this.#approvals = new ApprovalCoordinator({
      adapterFor: (request) => this.#adapters.get(request.backend),
    });
  }

  setMaxConcurrent(limit: number): void {
    this.#capacity.setLimit(limit);
  }

  setStaleAgentMs(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigurationError("staleAgentMs must be a positive integer", { value });
    this.#staleAgentMs = value;
  }

  setSendMessageWaitMs(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new ConfigurationError("sendMessageWaitMs must be a non-negative integer", { value });
    this.#sendMessageWaitMs = value;
  }

  setScheduledGraceMs(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new ConfigurationError("scheduledGraceMs must be a non-negative integer", { value });
    this.#scheduledGraceMs = value;
  }

  /** True while queued work (including a time-delayed task) still needs this host alive. */
  hasPendingWork(): boolean {
    return [...this.#pending.values()].some(task => task.state === 'queued' || task.state === 'starting');
  }

  /**
   * Stop launching queued work before the host exits: clear scheduled timers and refuse new
   * starts, then wait (bounded) for tasks already launching. Queued tasks stay queued so the
   * next host starts them exactly once instead of this one racing the final snapshot.
   */
  async quiesce(timeoutMs = 5_000): Promise<void> {
    this.#stopping = true;
    for (const id of [...this.#taskTimers.keys()]) this.#clearTaskTimer(id);
    if (this.#taskRuns.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#taskRuns]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Replace the per-backend and per-model pools after a live config reload. */
  setCapacityConfig(
    perBackend: Readonly<Partial<Record<Backend, number>>>,
    perModel: readonly ModelConcurrencyRule[],
  ): void {
    const limits: Record<string, number> = {};
    for (const backend of BACKENDS) {
      const limit = perBackend[backend];
      if (limit !== undefined) limits[`backend:${backend}`] = limit;
    }
    for (const rule of perModel) limits[`model:${rule.pattern}`] = rule.limit;
    this.#capacity.setPoolLimits(limits);
  }

  concurrency(): {
    readonly limit: number;
    readonly active: number;
    readonly waiting: number;
    /** Queued tasks with a future `start_at`; they persist across a host replacement. */
    readonly scheduled: number;
    readonly per_backend: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly per_model: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  } {
    const perBackend: Record<string, Readonly<Record<string, unknown>>> = {};
    const perModel: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const pool of this.#capacity.poolViews()) {
      const view = {
        ...(pool.limit === undefined ? {} : { limit: pool.limit }),
        active: pool.active,
        waiting: pool.waiting,
      };
      if (pool.key.startsWith("backend:")) perBackend[pool.key.slice("backend:".length)] = view;
      else if (pool.key.startsWith("model:")) perModel[pool.key.slice("model:".length)] = view;
    }
    return {
      limit: this.#capacity.limit,
      active: this.#capacity.activeCount,
      waiting: this.#capacity.waitingCount,
      scheduled: [...this.#pending.values()].filter(task =>
        task.start_at !== undefined && (task.state === 'queued' || task.state === 'starting')).length,
      per_backend: perBackend,
      per_model: perModel,
    };
  }

  /**
   * Roster, local usage, allowances and concurrency. With `live` (default: on when one `backend` is
   * named), also asks each backend that has a live API (`providerInfo`: OpenCode, Codex) for the
   * models it can run and its own plan usage, and flags roster entries the backend does not offer.
   */
  async listModels(backend?: Backend, live: boolean = backend !== undefined): Promise<Readonly<Record<string, unknown>>> {
    const local = { ...this.#localModels(backend), ...await this.#updateNotice() };
    if (!live) return local;
    const disabled = this.#registry.modelPolicy().disabledBackends;
    if (backend !== undefined && disabled.includes(backend)) return { ...local, live: { disabled: true } };
    // A disabled backend is not queried: that would start its CLI or server for nothing.
    const adapters = this.#adapters.list().filter((adapter) => adapter.providerInfo !== undefined
      && !disabled.includes(adapter.backend) && (backend === undefined || adapter.backend === backend));
    const entries = await Promise.all(adapters.map(async (adapter) =>
      [adapter.backend, await this.#liveInfo(adapter)] as const));
    if (entries.length === 0) return local;
    const byBackend = Object.fromEntries(entries);
    return { ...local, live: backend === undefined ? byBackend : byBackend[backend] };
  }

  async #updateNotice(): Promise<Readonly<Record<string, unknown>>> {
    if (this.#updateCachePath === undefined || updateCheckDisabled()) return {};
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#updateCachePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || !("available" in parsed) || parsed.available !== true
          || !("current" in parsed) || typeof parsed.current !== "string"
          || !("latest" in parsed) || typeof parsed.latest !== "string"
          || !("url" in parsed) || typeof parsed.url !== "string") return {};
      // Only a notice computed for the version that is running, and only if it really is newer.
      if (parsed.current !== currentVersion() || compareVersions(parsed.latest, parsed.current) <= 0) return {};
      return { update: { current: parsed.current, latest: parsed.latest, url: parsed.url } };
    } catch {
      return {};
    }
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
      const policy = this.#registry.modelPolicy();
      const models = info.models.map((model) => {
        const reason = blockReason(policy, adapter.backend, model.id);
        return reason === undefined ? model : { ...model, blocked: true, blocked_by: describeBlock(reason) };
      });
      const offered = new Set(models.map((model) => model.id));
      const roster = this.#registry.listModels(adapter.backend) as readonly ModelEntry[];
      // Entries routed to a custom provider (e.g. endpoint models) are outside the backend's own catalog.
      const missing = roster.filter((entry) => entry.provider === undefined && !offered.has(entry.name)).map((entry) => entry.name);
      return { ...info, models, ...(missing.length === 0 ? {} : { roster_not_offered: missing }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Refuse what models.yaml or the environment blocks (see core/model-policy.ts). */
  #assertModelAllowed(backend: Backend, model: string): void {
    const entries = this.#registry.listModels(backend) as readonly ModelEntry[];
    const upstream = entries.find((entry) => entry.name === model)?.upstreamModel;
    const reason = blockReason(this.#registry.modelPolicy(), backend, model, upstream);
    if (reason !== undefined) throw new ModelBlockedError(reason, backend, model);
  }

  #assertConfigValid(): void {
    const warning = this.#registry.configWarning();
    if (warning !== undefined) throw new ConfigInvalidError(warning);
  }

  /** The roster, with `blocked: true` and `blocked_by` on entries the model policy refuses. */
  #roster(backend?: Backend): unknown {
    const roster = this.#registry.listModels(backend);
    const policy = this.#registry.modelPolicy();
    if (!isRestrictive(policy)) return roster;
    const mark = (owner: Backend, entries: readonly ModelEntry[]) => entries.map((entry) => {
      const reason = blockReason(policy, owner, entry.name, entry.upstreamModel);
      return reason === undefined ? entry : { ...entry, blocked: true, blocked_by: describeBlock(reason) };
    });
    if (backend !== undefined) return mark(backend, roster as readonly ModelEntry[]);
    return Object.fromEntries(Object.entries(roster as Readonly<Record<Backend, readonly ModelEntry[]>>)
      .map(([owner, entries]) => [owner, mark(owner as Backend, entries)]));
  }

  #policyView(): Readonly<Record<string, unknown>> {
    const policy = this.#registry.modelPolicy();
    return {
      claude_models_blocked: policy.blockClaudeModels,
      disabled_backends: policy.disabledBackends,
      block_models: policy.blockModels,
    };
  }

  #localModels(backend?: Backend): Readonly<Record<string, unknown>> {
    const usage = this.#usage.snapshot();
    const allowances = this.#registry.allowances();
    const remaining = remainingAllowances(allowances, usage);
    const warning = this.#registry.configWarning();
    const filteredAllowance = backend === undefined ? allowances : allowances[backend];
    const filteredRemaining = backend === undefined ? remaining : remaining[backend];
    return {
      models: this.#roster(backend),
      ...(isRestrictive(this.#registry.modelPolicy()) ? { model_policy: this.#policyView() } : {}),
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
      (!input.updated_since || Date.parse(String(r.updated_at)) >= Date.parse(input.updated_since)));
    let after: { created_at: string; agent_id: string } | undefined;
    if (input.cursor) {
      try { after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
      catch { throw new SupervisorError('Invalid cursor'); }
      if (!after || typeof after.created_at !== 'string' || typeof after.agent_id !== 'string') throw new SupervisorError('Invalid cursor');
    }
    // newest first on an immutable key (created_at never changes, unlike updated_at), so pages never skip or repeat
    const sorted = records.sort(newestFirst);
    const filtered = after ? sorted.filter(r => { const k = listKey(r); return k.at < after!.created_at || (k.at === after!.created_at && k.id < after!.agent_id); }) : sorted;
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    return { agents: page,
      next_cursor: filtered.length > limit && last ? Buffer.from(JSON.stringify({ created_at: listKey(last).at, agent_id: listKey(last).id })).toString('base64url') : null,
      concurrency: this.concurrency(), liveness: this.#livenessSummary(), config_warning: this.#registry.configWarning(), storage_error: this.#storageError };
  }

  listAgents(): readonly Readonly<Record<string, unknown>>[] {
    this.checkLiveness();
    const started = new Set([...this.#agents.values()].map(record => record.meta.queued_from));
    return [...this.#agents.values()].map(record => this.#publicRecord(record))
      .concat([...this.#pending.values()].filter(task => !task.result?.agent_id && !started.has(task.id)).map(task => ({
        agent_id: task.id, state: task.state, backend: task.input.backend, created_at: task.created_at,
        updated_at: task.updated_at ?? task.created_at, group_id: task.input.group_id,
        ...(task.start_at === undefined ? {} : { start_at: task.start_at }),
        notify: task.notify ?? 'always',
      })))
      .sort(newestFirst);
  }

  /** A config is blocked when its whole backend is, or when the model it pins is. */
  #configBlock(backend: Backend, model: string | undefined): Readonly<Record<string, unknown>> {
    const policy = this.#registry.modelPolicy();
    const reason = policy.disabledBackends.includes(backend) ? { kind: "backend" as const }
      : model === undefined ? undefined : blockReason(policy, backend, model);
    return reason === undefined ? {} : { blocked: true, blocked_by: describeBlock(reason) };
  }

  async listAgentConfigs() {
    const configs = await Promise.all(this.#registry.listAgents().map(async config => {
      const base = { name: config.name, source_path: config.sourcePath,
        backend: config.backend, model: config.model, effort: config.reasoningEffort, capabilities: capabilities(config.backend),
        ...(config.antigravityAgent === undefined ? {} : { antigravity_agent: config.antigravityAgent }),
        ...(config.antigravityAgentFile === undefined ? {} : { antigravity_agent_file: config.antigravityAgentFile }),
        ...this.#configBlock(config.backend, config.model) };
      if (config.backend !== "antigravity" || config.antigravityAgent === undefined) return base;
      try {
        const definition = await this.#resolveAntigravityDefinition({
          backend: config.backend,
          antigravityAgent: config.antigravityAgent,
          ...(config.antigravityAgentFile === undefined ? {} : { antigravityAgentFile: config.antigravityAgentFile }),
        }, this.#cwd);
        return {
          ...base,
          ...(definition === undefined ? {} : {
            agent_definition: {
              name: definition.name,
              source_path: definition.sourcePath,
              source: definition.source,
              portable: definition.portable,
              sha256: definition.sha256,
              ...(definition.description === undefined ? {} : { description: definition.description }),
              ...(definition.tools === undefined ? {} : { tools: definition.tools }),
              ...(definition.permission === undefined ? {} : { permission: definition.permission }),
              bridge_enforced: false,
              project_owned: definition.source === "project"
                || (definition.source === "explicit" && definition.portable),
            },
          }),
        };
      } catch (error) {
        return { ...base, agent_definition_error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return { configs, config_warning: this.#registry.configWarning() };
  }

  async waitForAgents(agents: readonly string[], mode: 'any' | 'all' = 'all', timeout = 60, since?: string, maxResultChars?: number) {
    if (!agents.length) throw new SupervisorError('At least one agent is required');
    this.checkLiveness();
    const statuses = () => agents.map(identifier => {
      const task = this.#pending.get(identifier);
      if (task && !task.result?.agent_id) return { identifier, state: task.state, updated_at: task.updated_at ?? task.created_at };
      const record = this.#requireRecord(identifier);
      return { identifier, state: record.state, updated_at: record.updatedAt };
    });
    const isSettled = (state: string) => !['starting','running','queued'].includes(state);
    // Compare as instants: `since` may be "…:00Z" while stored times carry milliseconds
    const sinceMs = since === undefined ? undefined : Date.parse(since);
    const newlySettled = () => statuses().filter(status =>
      isSettled(status.state) && (sinceMs === undefined || Date.parse(status.updated_at) > sinceMs));
    const ready = () => {
      const fresh = newlySettled();
      if (fresh.some(status => status.state === 'needs_approval')) return true;
      if (mode === 'any') return fresh.length > 0;
      // 'all': everything has settled; with `since`, at least one must have settled after it
      return statuses().every(status => isSettled(status.state)) && (sinceMs === undefined || fresh.length > 0);
    };
    let timed_out = false;
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const cleanup = () => { clearTimeout(timer); this.#changes.delete(check); };
      const check = () => { try { this.checkLiveness(); if (ready()) { cleanup(); resolve(); } } catch(error) { cleanup(); reject(error); } };
      this.#changes.add(check);
      timer = setTimeout(() => { timed_out = true; cleanup(); resolve(); }, Math.max(0, Math.min(60, timeout)) * 1000);
      check();
    });
    await this.#writes;
    return { timed_out, newly_settled: newlySettled().map(status => status.identifier),
      agents: agents.map(agent => this.#pending.has(agent) && !this.#pending.get(agent)!.result?.agent_id ? this.#pending.get(agent) : this.#cappedResult(this.#requireRecord(agent), maxResultChars)) };
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
      try { const task = this.#pending.get(id); if (task) { if (task.result?.agent_id) await this.stopAgent(String(task.result.agent_id)); this.#setTaskState(task, 'interrupted'); await this.#writeSnapshot(); this.#changed(); return task; }
        return await this.stopAgent(id);
      } catch(error) { return { agent_id: id, error: String(error) }; }
    }));
  }

  #changed() { for (const listener of this.#changes) listener(); }

  async #schedule(input: SpawnAgentInput) {
    const dependencies = (input.depends_on ?? []).map(agent => {
      if (this.#pending.has(agent)) return { agent, turn: 1 };
      const record = this.#requireRecord(agent); return { agent: record.id, turn: record.meta.turn };
    });
    input = { ...input, backend: this.#registry.resolveAgent({ agent: input.agent, ...(input.model ? { model: input.model } : {}), ...(input.backend ? { backend: input.backend } : {}) }).backend };
    const task: PendingTask = {
      id: `task-${randomUUID()}`, created_at: new Date().toISOString(), input, dependencies, state: 'queued',
      ...(input.start_at === undefined ? {} : { start_at: input.start_at }),
      notify: input.notify ?? 'always',
    };
    this.#pending.set(task.id, task);
    await this.#writeSnapshot();
    void this.#runTask(task);
    return { task_id: task.id, agent_id: task.id, status: task.state,
      ...(task.start_at === undefined ? {} : { start_at: task.start_at }) };
  }

  /** Every state change stamps updated_at, so `since` / `updated_since` see when a queued task settled. */
  #setTaskState(task: PendingTask, state: PendingTask['state']): void {
    const previous = task.state;
    task.state = state;
    task.updated_at = new Date().toISOString();
    if (state !== 'queued') this.#clearTaskTimer(task.id);
    if (state === 'blocked' && previous !== 'blocked') this.#emitTaskPing(task);
  }

  /** Arm the next readiness check for a delayed task, re-arming in chunks beyond Node's timer limit. */
  #armTaskTimer(task: PendingTask, check: () => void): void {
    this.#clearTaskTimer(task.id);
    const due = Date.parse(task.start_at!);
    const delay = Math.min(Math.max(0, due - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.#taskTimers.delete(task.id);
      check();
    }, delay);
    (timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
    this.#taskTimers.set(task.id, timer);
  }

  #clearTaskTimer(id: string): void {
    const timer = this.#taskTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#taskTimers.delete(id);
  }

  /**
   * Why a scheduled task is too late to start, or undefined when it may run now (or was not
   * scheduled). Shared by restorePending() and live timers, including a timer that fires late
   * because the host was suspended.
   */
  #missedStart(task: PendingTask, now = Date.now()): FailureInfo | undefined {
    if (task.start_at === undefined) return undefined;
    const due = Date.parse(task.start_at);
    if (!Number.isFinite(due)) return undefined;
    const lateMs = now - due;
    if (lateMs <= this.#scheduledGraceMs) return undefined;
    return classifyFailure({
      code: 'MISSED_START',
      message: `Scheduled start ${task.start_at} was missed by ${Math.round(lateMs / 1000)}s ` +
        `(grace ${Math.round(this.#scheduledGraceMs / 1000)}s). The host was probably asleep or stopped.`,
      ...(task.input.backend === undefined ? {} : { backend: task.input.backend }),
      source: 'supervisor',
      details: {
        start_at: task.start_at,
        late_by_seconds: Math.round(lateMs / 1000),
        grace_seconds: Math.round(this.#scheduledGraceMs / 1000),
      },
    });
  }

  /** Block a task whose start is beyond the grace window; #setTaskState emits its ping. */
  #blockMissedStart(task: PendingTask, now = Date.now()): boolean {
    const error = this.#missedStart(task, now);
    if (error === undefined) return false;
    task.result = { error, missed_start: true };
    this.#setTaskState(task, 'blocked');
    return true;
  }

  #dependencyError(
    dependency: { readonly agent: string; readonly turn: number },
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ): FailureInfo {
    return classifyFailure({
      code,
      message,
      source: 'supervisor',
      details: { agent: dependency.agent, turn: dependency.turn, ...details },
    });
  }

  /** An existing turn outcome that failed or produced invalid structured output. */
  #dependencyResultError(dependency: { readonly agent: string; readonly turn: number }, result: Row): FailureInfo {
    const invalid = result.validation_errors !== undefined;
    const persisted = normalizeFailure(result.error, { failed: result.status !== 'completed' || invalid });
    if (persisted !== undefined) return persisted;
    return this.#dependencyError(
      dependency,
      invalid ? 'DEPENDENCY_INVALID_RESULT' : 'DEPENDENCY_FAILED',
      invalid
        ? `Prerequisite ${dependency.agent} turn ${dependency.turn} returned invalid structured output`
        : `Prerequisite ${dependency.agent} turn ${dependency.turn} ended ${String(result.status)}`,
      { status: result.status, ...(invalid ? { validation_errors: result.validation_errors } : {}) },
    );
  }

  /**
   * Resolve one pinned prerequisite. Undefined result and error means it may still produce the
   * turn. A terminal agent or task without the pinned turn can never produce it: waiting would
   * keep the dependent queued, and the host alive, forever.
   */
  #checkDependency(dependency: { readonly agent: string; readonly turn: number }): DependencyCheck {
    const base = { agent: dependency.agent, turn: dependency.turn };
    const task = this.#pending.get(dependency.agent);
    if (task !== undefined) {
      if (task.state === 'blocked' || task.state === 'interrupted') {
        return {
          ...base,
          error: this.#dependencyError(dependency, 'DEPENDENCY_FAILED',
            `Prerequisite task ${task.id} is ${task.state}`, { state: task.state }),
        };
      }
      if (task.state === 'queued' || task.state === 'starting') return base;
      const agentId = task.result?.agent_id;
      if (typeof agentId !== 'string') {
        return {
          ...base,
          error: this.#dependencyError(dependency, 'DEPENDENCY_UNAVAILABLE',
            `Prerequisite task ${task.id} completed without a linked agent`),
        };
      }
      return this.#checkDependencyAgent(dependency, agentId);
    }
    return this.#checkDependencyAgent(dependency, dependency.agent);
  }

  #checkDependencyAgent(
    dependency: { readonly agent: string; readonly turn: number },
    agentId: string,
  ): DependencyCheck {
    const record = this.#requireRecord(agentId);
    const result = record.meta.history.find(item => item.turn === dependency.turn);
    if (result !== undefined) {
      return result.status !== 'completed' || result.validation_errors
        ? { agent: dependency.agent, turn: dependency.turn, result, error: this.#dependencyResultError(dependency, result) }
        : { agent: dependency.agent, turn: dependency.turn, result };
    }
    if (isActiveState(record.state)) return { agent: dependency.agent, turn: dependency.turn };
    return {
      agent: dependency.agent,
      turn: dependency.turn,
      error: this.#dependencyError(dependency, 'DEPENDENCY_UNAVAILABLE',
        `Prerequisite agent ${agentId} is ${record.state} and has no result for pinned turn ${dependency.turn}; ` +
          'it can no longer produce one.',
        { agent_id: agentId, state: record.state }),
    };
  }

  async #runTask(task: PendingTask) {
    const run = async () => {
      if (this.#stopping) { this.#changes.delete(check); this.#clearTaskTimer(task.id); return; }
      if (task.state !== 'queued') { this.#changes.delete(check); this.#clearTaskTimer(task.id); return; }
      if (task.start_at !== undefined) {
        const due = Date.parse(task.start_at);
        if (Number.isFinite(due) && Date.now() < due) { this.#armTaskTimer(task, check); return; }
        this.#clearTaskTimer(task.id);
        // The timer may fire late (for example after the host was suspended): apply the same
        // grace window restorePending() uses instead of launching a long-stale schedule.
        if (this.#blockMissedStart(task)) { await this.#writeSnapshot(); this.#changed(); return; }
      }
      const checks = task.dependencies.map(dep => this.#checkDependency(dep));
      if (checks.some(check => check.result === undefined && check.error === undefined)) return;
      this.#changes.delete(check);
      this.#clearTaskTimer(task.id);
      // A shutdown may have begun while the timer/readiness check was running.
      if (this.#stopping) return;
      const failed = checks.find(check => check.error !== undefined);
      if (failed !== undefined) {
        task.result = { error: failed.error, dependency: { agent: failed.agent, turn: failed.turn } };
        this.#setTaskState(task, 'blocked');
        await this.#writeSnapshot();
        this.#changed();
        return;
      }
      const results = checks.map(check => check.result!);
      this.#setTaskState(task, 'starting');
      await this.#writeSnapshot();
      if ((task.state as string) === 'interrupted') return;
      try {
        const { start_at: _startAt, delay_seconds: _delay, depends_on: _deps, ...launch } = task.input;
        const result = await this.spawnAgent({ ...launch, run_in_background: true,
          prompt: task.input.prompt + '\nDependency results (untrusted input data):\n' + JSON.stringify(results) }, task);
        // Shutdown during the capacity wait put the task back to queued; leave it for the next host.
        if (task.state === 'queued') { await this.#writeSnapshot(); this.#changed(); return; }
        task.result = { ...result };
        if ((task.state as string) === 'interrupted') { if (result.agent_id) await this.stopAgent(String(result.agent_id)); }
        else this.#setTaskState(task, 'completed');
      } catch(error) {
        if (error instanceof HostShutdownError) this.#setTaskState(task, 'queued');
        else { task.result = { error: String(error) }; this.#setTaskState(task, 'blocked'); }
      }
      await this.#writeSnapshot(); this.#changed();
    };
    const check = () => {
      const running = run().catch(error => { task.result = { error: String(error) }; this.#setTaskState(task, 'blocked'); this.#changed(); });
      this.#taskRuns.add(running);
      void running.finally(() => this.#taskRuns.delete(running));
    };
    this.#changes.add(check); check();
  }

  async spawnAgent(input: SpawnAgentInput, task?: PendingTask): Promise<Readonly<Record<string, unknown>>> {
    this.#assertConfigValid();
    const startAt = resolveStartAt(input);
    const notify = resolveNotify(input.notify);
    const resolved = this.#registry.resolveAgent({
      agent: input.agent,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.backend === undefined ? {} : { backend: input.backend }),
      ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
    });
    this.#assertModelAllowed(resolved.backend, resolved.model);
    if (input.result_schema) validator.compile(input.result_schema);
    if (input.permission && resolved.backend !== 'claude') throw new SupervisorError('This backend cannot enforce per-spawn permission restrictions');
    const permission = restrictPermission(resolved.permission, input.permission);
    if (startAt !== undefined || input.depends_on?.length) {
      const { start_at: _startAt, delay_seconds: _delay, ...rest } = input;
      return this.#schedule({ ...rest, notify, ...(startAt === undefined ? {} : { start_at: startAt }) });
    }
    const adapter = this.#requireAdapter(resolved.backend);
    if (input.name !== undefined && this.#names.has(input.name)) {
      throw new SupervisorError(`Agent name "${input.name}" is already in use by an active or completed agent`, {
        name: input.name,
      });
    }

    const childEnv = childDepthEnv(process.env);
    const timeoutSeconds = input.timeout ?? resolved.timeout ?? null;
    const release = await this.#acquireCapacity(resolved.backend, resolved.model);
    if (task?.state === 'interrupted') { release(); return { status: 'interrupted' }; }
    // Shutdown may have begun while this spawn waited for a slot. Do not launch after the
    // host's adapters have closed; leave a queued task for the replacement host.
    if (this.#stopping) {
      release();
      if (task !== undefined) {
        this.#setTaskState(task, 'queued');
        return { status: 'queued', task_id: task.id };
      }
      throw new HostShutdownError();
    }
    // The policy can change while a spawn waits for a slot (models.yaml is hot-reloaded).
    try { this.#assertModelAllowed(resolved.backend, resolved.model); } catch (error) { release(); throw error; }
    let worktree: Worktree | undefined;
    let launched = false;
    let agentDefinition: AgentDefinitionMetadata | undefined;
    try {
      if (input.isolation === 'worktree') { worktree = await createWorktree(this.#cwd); await setupWorktree(worktree, resolved.worktreeSetup ?? []); }
      // Config can hot-reload while worktree setup commands run.
      this.#assertConfigValid();
      this.#assertModelAllowed(resolved.backend, resolved.model);
      agentDefinition = await this.#captureAgentDefinition(resolved, worktree?.path ?? this.#cwd);
      // The last point at which no child exists: config resolution, worktree setup and agent
      // definition capture are all async, so shutdown may have started meanwhile.
      if (this.#stopping) throw new HostShutdownError();
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
        meta: { turn: 1, history: [], notify, ...(input.permission ? { permission } : {}), ...(worktree ? { worktree } : {}),
          ...(input.group_id ? { group_id: input.group_id } : {}), ...(input.result_schema ? { schema: input.result_schema } : {}),
          ...(agentDefinition ? { agentDefinition } : {}),
          ...(task ? { queued_from: task.id, queued_at: task.created_at } : {}),
          ...(task?.start_at === undefined ? {} : { start_at: task.start_at }) },
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
        heartbeatAt: now,
        staleProbes: 0,
        cursor: 0,
        currentTurnId: turn.turnId,
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
      return this.#cappedResult(record, input.max_result_chars);
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
    this.#assertConfigValid();
    this.checkLiveness();
    const record = this.#requireRecord(input.agent);
    if (input.notify !== undefined) {
      record.meta.notify = resolveNotify(input.notify);
      record.updatedAt = new Date().toISOString();
      void this.#writeSnapshot().catch(error => { this.#storageError = String(error); });
    }
    const waitSeconds = input.wait_seconds ?? this.#sendMessageWaitMs / 1000;
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
      throw new SupervisorError("wait_seconds must be a non-negative number", { wait_seconds: input.wait_seconds });
    }
    if (record.meta.cleaned) throw new SupervisorError("Worktree was removed; spawn a new agent");
    this.#assertModelAllowed(record.backend, record.model);
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
        ...(input.allow_agent_definition_change === true ? { allowDefinitionChange: true } : {}),
      };
      if (input.timeout !== undefined) record.timeoutSeconds = input.timeout;
      record.updatedAt = new Date().toISOString();
      void this.#writeSnapshot().catch(error => { this.#storageError = String(error); });
      if (input.run_in_background === true) record.detached = true;
      let settled = true;
      if (input.run_in_background !== true) settled = await this.#waitWithBudget(record, waitSeconds);
      if (!settled && record.state !== "running" && record.state !== "starting") settled = true;
      if (!settled) record.detached = true;
      return {
        ...this.#cappedResult(record, input.max_result_chars),
        ...(settled ? {} : { wait_expired: true, wait_seconds: waitSeconds,
          hint: "The turn is still running. Use wait_for_agents or get_agent_events; it was not cancelled." }),
      };
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
    record.release = await this.#acquireCapacity(record.backend, record.model);
    try { this.#assertModelAllowed(record.backend, record.model); } catch (error) { record.release(); throw error; }
    const previousState = record.state;
    record.state = "running";
    record.timedOut = false;
    this.#clearLastError(record);
    record.detached = input.run_in_background === true;
    delete record.result;
    record.updatedAt = new Date().toISOString();
    record.heartbeatAt = record.updatedAt;
    record.staleProbes = 0;
    delete record.staleSince;
    if (!record.pumping) {
      record.pumping = true;
      this.#pump(record, adapter);
    }
    try {
      await this.#deliverResume(record, adapter, input.prompt, input.effort ?? record.effort, input.timeout,
        input.allow_agent_definition_change === true);
    } catch (error) {
      record.release();
      record.state = previousState;
      record.updatedAt = new Date().toISOString();
      void this.#writeSnapshot().catch(() => undefined);
      throw error;
    }
    if (input.run_in_background !== true) {
      const settled = await this.#waitWithBudget(record, waitSeconds);
      if (!settled && record.state !== "running" && record.state !== "starting") {
        return this.#cappedResult(record, input.max_result_chars);
      }
      if (!settled) {
        record.detached = true;
        return {
          ...this.#cappedResult(record, input.max_result_chars),
          wait_expired: true,
          wait_seconds: waitSeconds,
          hint: "The turn is still running. Use wait_for_agents or get_agent_events; it was not cancelled.",
        };
      }
    }
    return this.#cappedResult(record, input.max_result_chars);
  }

  /** Shared by sendMessage() and the queued-message delivery inside #pump(). */
  async #deliverResume(record: AgentRecord, adapter: BackendAdapter, prompt: string, effort?: string, timeout?: number, allowDefinitionChange = false): Promise<void> {
    // Checked here too, not only when send_message is called: a queued message is delivered after
    // the current turn ends, by which time the policy may have changed.
    this.#assertConfigValid();
    this.#assertModelAllowed(record.backend, record.model);
    this.#clearLastError(record);
    const resolved = this.#registry.resolveAgent({
      agent: record.agentConfig,
      model: record.model,
      backend: record.backend,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
    const definition = await this.#captureAgentDefinition(resolved, record.cwd, record.meta.agentDefinition, allowDefinitionChange);
    if (definition !== undefined) record.meta.agentDefinition = definition;
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
    const turn = await adapter.resume({
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
    record.currentTurnId = turn.turnId;
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
    options?: EventReadOptions,
  ): {
    readonly agent_id: string;
    readonly name: string;
    readonly events: readonly AgentEvent[];
    readonly nextSequence: number;
    readonly currentSequence: number;
    readonly hasMore?: boolean;
  } {
    const record = this.#requireRecord(agent);
    const read = this.#events.read(record.id, since, limit, options);
    return {
      agent_id: record.id,
      name: record.name,
      events: read.events,
      nextSequence: read.nextSequence,
      currentSequence: read.currentSequence,
      ...(read.hasMore === undefined ? {} : { hasMore: read.hasMore }),
    };
  }

  /**
   * Compact digest of an agent's event log: counts, tool histogram, the last few tool calls and
   * the tail of its latest message. Meant to replace reading the whole log just to see progress.
   * `since`, when given, scopes the digest to events after that sequence (e.g. a previous call's
   * `currentSequence`), so repeat polling only reports what's new; `currentSequence` is always
   * returned so the caller can pass it back next time.
   */
  summarizeAgentEvents(agent: string, recent = 5, since = 0): Record<string, unknown> {
    const record = this.#requireRecord(agent);
    const read = this.#events.read(record.id, since);
    const tools: Record<string, number> = {};
    type Call = { sequence: number; tool: string; status: string; target?: string; preview?: string };
    const calls: Call[] = [];
    const byId = new Map<string, Call>();
    let message = "";
    let messageClosed = false;
    let errors = 0;
    let turns = 0;
    for (const event of read.events) {
      if (event.type === "tool.start") {
        tools[event.data.toolName] = (tools[event.data.toolName] ?? 0) + 1;
        const call: Call = { sequence: event.sequence, tool: event.data.toolName, status: "running", ...describeToolInput(event.data.input) };
        byId.set(event.data.toolCallId, call);
        calls.push(call);
      } else if (event.type === "tool.end") {
        const call = byId.get(event.data.toolCallId);
        if (call) call.status = event.data.status;
        else {
          // its tool.start was before `since`: still report that it ended
          const ended: Call = { sequence: event.sequence, tool: event.data.toolName ?? "tool", status: event.data.status };
          byId.set(event.data.toolCallId, ended);
          calls.push(ended);
          tools[ended.tool] = (tools[ended.tool] ?? 0) + 1;
        }
      } else if (event.type === "message.delta") {
        if (messageClosed) { message = ""; messageClosed = false; }
        message += event.data.text;
        if (message.length > 4000) message = message.slice(-2000);
      } else if (event.type === "turn.completed") {
        turns += 1;
        // keep the finished turn's text as the latest message; a later delta starts a new one
        if (typeof event.data.finalText === "string" && event.data.finalText !== "") message = event.data.finalText;
        messageClosed = true;
      } else if (event.type === "error") {
        errors += 1;
      }
    }
    return {
      agent_id: record.id,
      name: record.name,
      state: record.state,
      events: read.events.length,
      currentSequence: read.currentSequence,
      turns_completed: turns,
      errors,
      tool_calls: calls.length,
      tools,
      recent_tools: calls.slice(-recent).map(c => ({ ...c, tool: scanChildOutput(c.tool).slice(0, 80) })),
      current_activity: record.meta.activity ?? null,
      latest_message: scanChildOutput(message.trim()).slice(-300),
    };
  }

  #pump(record: AgentRecord, adapter: BackendAdapter): void {
    void (async () => {
      try {
        for await (const event of adapter.events(record.id, { since: record.cursor })) {
          record.cursor = event.sequence;
          const errorData = event.type === "error" ? this.#classifiedError(record, event.data) : undefined;
          this.#events.append({ type: event.type, agentId: record.id, backend: event.backend, data: errorData ?? event.data } as never);
          const previousActivity = record.meta.checkpointAt;
          record.updatedAt = new Date().toISOString();
          record.heartbeatAt = record.updatedAt;
          record.meta.activityAt = record.updatedAt;
          if (event.type === 'tool.start') record.meta.activity = scanChildOutput([event.data.toolName, describeToolInput(event.data.input).target].filter(Boolean).join(' ')).slice(0,160);
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
            // Only the turn in progress has live usage; a late update for a finished turn would count it twice.
            const finished = event.data.turnId !== undefined && record.meta.history.some(h => h.turn_id === event.data.turnId);
            if (!finished && (record.state === "running" || record.state === "needs_approval" || record.state === "starting")) {
              record.liveUsage = { ...event.data.usage };
            }
            continue;
          }
          if (event.type === "turn.completed") {
            // The final usage wins; without one (an interrupt or crash), keep what was observed live.
            const turnUsage = event.data.usage ?? record.liveUsage;
            delete record.liveUsage;
            if (event.data.finalText !== undefined) record.result = scanChildOutput(event.data.finalText);
            if (turnUsage !== undefined) record.usage = { ...turnUsage };
            else delete record.usage;
            if (event.data.status === "failed") this.#ensureFailure(record, event.data.finalText);
            else if (event.data.status === "completed") this.#clearLastError(record);
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
              structured_result: record.meta.structured, validation_errors: record.meta.validation_errors,
              ...(record.lastError === undefined ? {} : { error: record.lastError }) };
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
              record.heartbeatAt = record.updatedAt;
              record.staleProbes = 0;
              delete record.staleSince;
              this.#usage.recordTurn(record.backend, record.model, turnUsage, {
                failed: event.data.status !== "completed",
                timedOut: record.timedOut,
              });
              record.timedOut = false;
              try {
                await this.#deliverResume(record, adapter, pending.prompt, pending.effort, pending.timeout,
                  pending.allowDefinitionChange === true);
              } catch (error) {
                // Every supervisor error (a blocked model/config, an Antigravity definition change,
                // etc.) is a real refusal for the queued message, not a broken event stream. The
                // agent ends on the turn that just finished, carrying the classified error.
                if (!(error instanceof SubagentError)) throw error;
                this.#setLastError(record, classifyFailure({
                  code: error.code,
                  message: error.message,
                  backend: record.backend,
                  source: "supervisor",
                  ...(error.details === undefined ? {} : { details: error.details }),
                }));
                if (event.data.status === "failed") this.#ensureFailure(record, event.data.finalText);
                record.state = event.data.status === "completed" ? "completed"
                  : event.data.status === "interrupted" ? "interrupted" : "failed";
                record.release();
                await this.#notify(record);
              }
              continue;
            }
            record.state = event.data.status === "completed" ? "completed"
              : event.data.status === "interrupted" ? "interrupted" : "failed";
            this.#usage.recordTurn(record.backend, record.model, turnUsage, {
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
            this.#setLastError(record, this.#failureFromEvent(record, event.data));
            if (/TIMEOUT/.test(event.data.code)) record.timedOut = true;
            if (event.data.fatal) {
              record.state = "failed";
              this.#ensureFailure(record, undefined);
              record.release();
              await this.#notify(record);
            }
          }
        }
      } catch (error) {
        const failure = classifyFailure({
          code: "SUPERVISOR_STREAM_ERROR",
          message: error instanceof Error ? error.message : String(error),
          backend: record.backend,
          source: "supervisor",
        });
        this.#setLastError(record, failure);
        this.#appendSyntheticError(record, failure, true);
        record.state = "failed";
        record.release();
        await this.#notify(record);
      } finally {
        if (record.state !== "running" && record.state !== "starting" && record.state !== "needs_approval") {
          record.release();
        }
      }
    })();
  }

  #classifiedError(record: AgentRecord, data: NormalizedEventData["error"]): NormalizedEventData["error"] {
    const info = this.#failureFromEvent(record, data);
    return {
      code: info.code,
      message: info.message,
      fatal: data.fatal,
      category: info.category,
      retryable: info.retryable,
      recommended_action: info.recommended_action,
      ...(info.retry_after_seconds === undefined ? {} : { retry_after_seconds: info.retry_after_seconds }),
      source: "adapter",
      ...(data.turnId === undefined ? {} : { turnId: data.turnId }),
      ...(info.subtype === undefined ? {} : { subtype: info.subtype }),
      ...(info.details === undefined ? {} : { details: info.details }),
    };
  }

  #failureFromEvent(record: AgentRecord, data: NormalizedEventData["error"]): FailureInfo {
    const details = data.details;
    const subtype = data.subtype ?? (typeof details?.["subtype"] === "string" ? details["subtype"] : undefined);
    return classifyFailure({
      code: data.code,
      message: scanChildOutput(data.message),
      backend: record.backend,
      source: "adapter",
      ...(subtype === undefined ? {} : { subtype }),
      ...(details === undefined ? {} : { details }),
    });
  }

  #setLastError(record: AgentRecord, info: FailureInfo): void {
    record.lastError = info;
    record.lastErrorTurn = record.meta.turn;
  }

  #clearLastError(record: AgentRecord): void {
    delete record.lastError;
    delete record.lastErrorTurn;
  }

  /**
   * Every failed turn must carry an actionable error, even when a backend only sent
   * `turn.completed {status: "failed"}` with no accompanying error record.
   */
  #ensureFailure(record: AgentRecord, finalText?: string): void {
    const current = record.lastError !== undefined && record.lastErrorTurn === record.meta.turn ? record.lastError : undefined;
    if (current !== undefined && !(record.timedOut && !/TIMEOUT/.test(current.code))) return;
    const info = classifyFailure({
      code: record.timedOut ? "TURN_TIMEOUT" : "TURN_FAILED",
      message: record.timedOut
        ? record.timeoutSeconds === null
          ? "The turn exceeded its time limit"
          : `The turn exceeded its ${record.timeoutSeconds}s time limit`
        : "The backend reported a failed turn without an error record",
      backend: record.backend,
      source: "supervisor",
      ...(finalText === undefined || finalText.trim() === "" ? {} : { details: { result_preview: scanChildOutput(finalText).slice(0, 500) } }),
    });
    this.#setLastError(record, info);
    this.#appendSyntheticError(record, info, true);
  }

  #appendSyntheticError(record: AgentRecord, info: FailureInfo, fatal: boolean): void {
    this.#events.append({
      type: "error",
      agentId: record.id,
      backend: record.backend,
      data: {
        code: info.code,
        message: info.message,
        fatal,
        category: info.category,
        retryable: info.retryable,
        recommended_action: info.recommended_action,
        ...(info.retry_after_seconds === undefined ? {} : { retry_after_seconds: info.retry_after_seconds }),
        source: "supervisor",
        ...(info.subtype === undefined ? {} : { subtype: info.subtype }),
      },
    });
  }

  /**
   * Probe active agents and fail one whose backend has authoritatively disappeared. A single stale
   * probe only marks it; two probes are required so a process exit racing its terminal event does
   * not turn an otherwise normal completion into a failure.
   */
  checkLiveness(now = Date.now()): void {
    for (const record of this.#agents.values()) {
      if (!isActiveState(record.state)) continue;
      const probe = this.#adapterLiveness(record);
      if (probe?.state === "stale") {
        record.staleProbes += 1;
        if (record.staleSince === undefined) record.staleSince = new Date(now).toISOString();
        if (record.staleProbes >= 2) this.#failUnresponsive(record, probe.reason);
        continue;
      }
      if (probe?.state === "live") {
        record.staleProbes = 0;
        delete record.staleSince;
        continue;
      }
      // Without an adapter probe, only age can suggest a problem; report it but do not kill work
      // that may be a legitimate long-running tool call.
      const heartbeatAge = Math.max(0, now - Date.parse(record.heartbeatAt));
      if (heartbeatAge >= this.#staleAgentMs) {
        if (record.staleSince === undefined) record.staleSince = new Date(now).toISOString();
      } else {
        delete record.staleSince;
      }
    }
  }

  #adapterLiveness(record: AgentRecord): AdapterLiveness | undefined {
    try {
      return this.#adapters.get(record.backend).liveness?.(record.id);
    } catch {
      return { state: "unknown", reason: "backend adapter is unavailable" };
    }
  }

  #failUnresponsive(record: AgentRecord, reason: string): void {
    if (!isActiveState(record.state)) return;
    if (record.pendingApprovalId !== undefined) {
      try { this.#approvals.cancel(record.pendingApprovalId); } catch { /* already settled */ }
      delete record.pendingApprovalId;
    }
    const queued = record.pendingMessage !== undefined;
    if (queued) delete record.pendingMessage;
    const info = classifyFailure({
      code: "AGENT_UNRESPONSIVE",
      message: `The ${record.backend} backend is no longer reporting for this agent: ${reason}`,
      backend: record.backend,
      source: "supervisor",
      details: { reason, ...(queued ? { queued_message_dropped: true } : {}) },
    });
    this.#setLastError(record, info);
    this.#appendSyntheticError(record, info, true);
    record.state = "failed";
    record.updatedAt = new Date().toISOString();
    record.release();
    void this.#notify(record).catch(() => undefined);
  }

  #livenessView(record: AgentRecord, now = Date.now()): Readonly<Record<string, unknown>> {
    const checkedAt = new Date(now).toISOString();
    const base = {
      liveness_checked_at: checkedAt,
      last_heartbeat_at: record.heartbeatAt,
      heartbeat_age_seconds: Math.max(0, Math.round((now - Date.parse(record.heartbeatAt)) / 1000)),
    };
    if (!isActiveState(record.state)) return { ...base, liveness: "settled" };
    const probe = this.#adapterLiveness(record);
    if (probe?.state === "stale") {
      if (record.staleSince === undefined) record.staleSince = checkedAt;
      return { ...base, liveness: "stale", liveness_reason: probe.reason, stale_since: record.staleSince };
    }
    if (probe?.state === "live") return { ...base, liveness: "live" };
    const ageMs = Math.max(0, now - Date.parse(record.heartbeatAt));
    if (ageMs >= this.#staleAgentMs) {
      if (record.staleSince === undefined) record.staleSince = checkedAt;
      return {
        ...base,
        liveness: "stale",
        liveness_reason: `no heartbeat for ${Math.round(ageMs / 1000)}s`,
        stale_since: record.staleSince,
      };
    }
    return { ...base, liveness: "unknown", ...(probe?.reason === undefined ? {} : { liveness_reason: probe.reason }) };
  }

  #livenessSummary(now = Date.now()): Readonly<Record<string, unknown>> {
    let live = 0;
    let stale = 0;
    let unresponsive = 0;
    for (const record of this.#agents.values()) {
      const view = this.#livenessView(record, now);
      if (view["liveness"] === "live") live += 1;
      else if (view["liveness"] === "stale") stale += 1;
      if (record.state === "failed" && record.lastError?.code === "AGENT_UNRESPONSIVE") unresponsive += 1;
    }
    return { checked_at: new Date(now).toISOString(), live, stale, unresponsive };
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
    catch(error) {
      this.#storageError = String(error);
      if (record.state === "failed") {
        this.#setLastError(record, classifyFailure({ code: 'STORAGE_ERROR', message: String(error), backend: record.backend, source: 'supervisor' }));
      }
    }
    this.#changed();
    if (record.detached && record.state !== "running" && record.state !== "starting") {
      // Nobody is blocked on this turn, so push the outcome instead of leaving the caller to poll.
      // needs_approval is not terminal: keep detached armed so the turn's eventual outcome still
      // pings once. A terminal outcome clears it first; the follow-up re-sets it if it blocks.
      const terminal = record.state !== "needs_approval";
      if (this.#shouldNotify(record)) {
        try {
          this.#onDetachedSettled?.(this.#result(record));
        } catch {
          // A failing notifier must not break the event pump.
        }
      }
      if (terminal) record.detached = false;
    }
    const waiters = record.waiters;
    record.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** needs_approval always pings (the agent is blocked); otherwise the job's notify policy decides. */
  #shouldNotify(record: AgentRecord): boolean {
    if (record.state === "needs_approval") return true;
    const notify = record.meta.notify ?? "always";
    if (notify === "never") return false;
    if (notify === "on_failure" && record.state === "completed") return false;
    return true;
  }

  #waitForNotableState(record: AgentRecord): Promise<void> {
    if (record.state !== "running" && record.state !== "starting") return Promise.resolve();
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  /** Wait at most `seconds`; false means the turn is still active and was left running. */
  async #waitWithBudget(record: AgentRecord, seconds: number): Promise<boolean> {
    if (record.state !== "running" && record.state !== "starting") return true;
    if (seconds <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#waitForNotableState(record).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.min(seconds, 86_400) * 1000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
      ...(record.currentTurnId === undefined ? {} : { turn_id: record.currentTurnId }),
      ...(record.meta.agentDefinition === undefined ? {} : { agent_definition: record.meta.agentDefinition }),
      ...(record.meta.start_at === undefined ? {} : { start_at: record.meta.start_at }),
      notify: record.meta.notify ?? "always",
      last_activity_at: record.meta.activityAt,
      current_activity: record.meta.activity ?? null,
      ...this.#livenessView(record),
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

  #cappedResult(record: AgentRecord, maxResultChars?: number): Readonly<Record<string, unknown>> {
    const full = this.#result(record);
    const cap = maxResultChars ?? MAX_CONTENT_CHARS;
    let result = full;
    // Parsed JSON is the point of result_schema, so it gets a roomier cap (4x); past that it is left out here.
    const structured = full.structured_result === undefined ? undefined : JSON.stringify(full.structured_result);
    if (structured !== undefined && structured.length > cap * 4) {
      result = { ...result, structured_result: null, structured_result_truncated: true, structured_result_chars: structured.length,
        result_hint: "Use get_agent_result to retrieve the full result." };
    }
    if (typeof result.result !== "string") return result;
    const truncated = truncateText(result.result, cap);
    if (truncated.truncatedChars === 0) return result;
    return {
      ...result,
      result: `${truncated.text}\n[truncated ${truncated.truncatedChars} characters]`,
      result_truncated: true,
      result_hint: "Use get_agent_result to retrieve the full result.",
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
      ...(record.lastError === undefined ? {} : { error: record.lastError }),
      last_activity_at: record.meta.activityAt,
      current_activity: record.meta.activity ?? null,
      activity_source: record.meta.activity ? 'tool_event' : null,
      ...(record.meta.agentDefinition === undefined ? {} : { agent_definition: record.meta.agentDefinition }),
      ...(record.meta.start_at === undefined ? {} : { start_at: record.meta.start_at }),
      notify: record.meta.notify ?? "always",
      ...this.#livenessView(record),
      cumulative_usage: this.#totalUsage(record),
      created_at: record.createdAt,
      ...(record.meta.queued_from === undefined ? {} : { queued_from: record.meta.queued_from, queued_at: record.meta.queued_at }),
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

  /** Wait for all queued writes, then persist the current snapshot (used before the host exits). */
  async flushSnapshot(): Promise<void> {
    await this.#writeSnapshot();
  }

  /**
   * Make later snapshot writes no-ops. Called after the host's final flush so a task that
   * outlived quiesce cannot overwrite a replacement host's state when it finally settles.
   */
  closePersistence(): void {
    this.#persistenceClosed = true;
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
        if (record.lastError?.code === 'HOST_RESTARTED') this.#clearLastError(record);
        const persistedError = normalizeFailure(value.error, { failed: value.status === 'failed' });
        if (persistedError !== undefined) {
          this.#setLastError(record, persistedError);
        } else if (record.state === 'failed') {
          this.#ensureFailure(record);
        }
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
    const rerun = new Set<string>();
    for (const task of tasks) {
      if (task.state === 'starting') {
        const record = [...this.#agents.values()].find(agent => agent.meta.queued_from === task.id);
        if (record !== undefined) {
          // The agent launched before the snapshot, so the task did settle even if its own state
          // update never made it to disk.
          this.#setTaskState(task, 'completed');
          task.result = { agent_id: record.id };
        } else {
          // No agent record means spawnAgent never launched; run the task instead of losing it.
          this.#setTaskState(task, 'queued');
          rerun.add(task.id);
        }
      }
      this.#pending.set(task.id, task);
    }
    let changed = rerun.size > 0;
    for (const task of tasks) {
      if (task.state !== 'queued') continue;
      // This also applies to a rerun `starting` task: its original start is still the schedule,
      // so a restart long after that time must not launch it as if nothing happened.
      if (this.#blockMissedStart(task)) { changed = true; continue; }
      void this.#runTask(task);
    }
    if (changed) void this.#writeSnapshot();
  }

  /** Persist a completion ping that had no connected client; the oldest is dropped past the bound. */
  async enqueueUndeliveredPing(result: Readonly<Record<string, unknown>>): Promise<void> {
    this.#undeliveredPings.push({ ...result });
    if (this.#undeliveredPings.length > MAX_UNDELIVERED_PINGS) {
      this.#undeliveredPings.splice(0, this.#undeliveredPings.length - MAX_UNDELIVERED_PINGS);
    }
    await this.#writeSnapshot();
  }

  /** How many completion pings are still waiting for an attached consumer. */
  undeliveredPingCount(): number {
    return this.#undeliveredPings.length;
  }

  /**
   * Deliver queued pings, removing each entry only after its write reports success. Failed entries
   * stay queued. A crash between a successful write and the snapshot can redeliver that ping.
   * Flushes are serialized so concurrent attaches cannot both deliver the same entry.
   */
  flushUndeliveredPings(
    deliver: (result: Readonly<Record<string, unknown>>) => boolean | void | Promise<boolean | void>,
  ): Promise<number> {
    const run = this.#pingFlush.then(() => this.#flushUndeliveredPings(deliver));
    this.#pingFlush = run.then(() => undefined, () => undefined);
    return run;
  }

  async #flushUndeliveredPings(
    deliver: (result: Readonly<Record<string, unknown>>) => boolean | void | Promise<boolean | void>,
  ): Promise<number> {
    if (this.#undeliveredPings.length === 0) return 0;
    const queued = [...this.#undeliveredPings];
    const delivered = new Set<Record<string, unknown>>();
    for (const result of queued) {
      try {
        if (await deliver(result) !== false) delivered.add(result);
      } catch {
        // A failing notifier leaves this ping queued for the next attach.
      }
    }
    if (delivered.size === 0) return 0;
    // Remove exactly the entries that were delivered (by identity), keeping any added meanwhile.
    this.#undeliveredPings = this.#undeliveredPings.filter(ping => !delivered.has(ping));
    await this.#writeSnapshot().catch(() => undefined);
    return delivered.size;
  }

  restoreUndeliveredPings(pings: unknown): void {
    if (!Array.isArray(pings)) return;
    this.#undeliveredPings = pings
      .filter((ping): ping is Record<string, unknown> => typeof ping === 'object' && ping !== null && !Array.isArray(ping))
      .slice(-MAX_UNDELIVERED_PINGS)
      .map(ping => ({ ...ping }));
  }

  /** Emit a queued task's settlement ping when it transitions to blocked. */
  #emitTaskPing(task: PendingTask): void {
    if ((task.notify ?? 'always') === 'never') return;
    try {
      this.#onDetachedSettled?.({
        agent_id: task.id, task_id: task.id, status: task.state, backend: task.input.backend,
        ...(task.start_at === undefined ? {} : { start_at: task.start_at }),
        ...(task.result ?? {}),
      });
    } catch {
      // A failing notifier must not break restore.
    }
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
      const restoredFailure = live
        ? classifyFailure({
            code: "HOST_RESTARTED",
            message: "The subagent host restarted while this agent was running. send_message resumes it.",
            backend: snapshot.backend,
            source: "supervisor",
          })
        : normalizeFailure(snapshot.lastError, { failed: snapshot.state === "failed" });
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
        heartbeatAt: snapshot.updatedAt,
        staleProbes: 0,
        cursor: 0,
        timeoutSeconds: snapshot.timeoutSeconds,
        timedOut: snapshot.timedOut === true,
        ...(snapshot.warning === undefined ? {} : { warning: snapshot.warning }),
        ...((snapshot.nameNote ?? picked.note) === undefined ? {} : { nameNote: (snapshot.nameNote ?? picked.note)! }),
        pumping: false,
        ...(snapshot.meta?.history.at(-1)?.usage ? { usage: snapshot.meta.history.at(-1)!.usage as Record<string, unknown> } : {}),
        ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
        ...(restoredFailure === undefined ? {} : { lastError: restoredFailure }),
        waiters: [],
        release: () => undefined,
      };
      if (restoredFailure !== undefined) record.lastErrorTurn = record.meta.turn;
      if (!live && record.state === "failed" && record.lastError === undefined) {
        this.#ensureFailure(record);
      }
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
    if (this.#persistenceClosed) return Promise.resolve();
    const operation = this.#writes.then(() => this.#saveSnapshot());
    this.#writes = operation.catch(error => { this.#storageError = String(error); });
    return operation;
  }

  async #saveSnapshot(): Promise<void> {
    if (this.#persistenceClosed) return;
    const path = this.#persistencePath;
    if (path === undefined) return;
    const body = `${JSON.stringify({
      version: 1,
      agents: this.exportSnapshot(),
      pending: [...this.#pending.values()],
      ...(this.#undeliveredPings.length === 0 ? {} : { undeliveredPings: this.#undeliveredPings }),
    }, null, 2)}\n`;
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

  async #resolveAntigravityDefinition(
    resolved: Pick<ResolvedAgentConfig, "backend" | "antigravityAgent" | "antigravityAgentFile">,
    cwd: string,
  ): Promise<AntigravityAgentDefinition | undefined> {
    if (resolved.backend !== "antigravity" || resolved.antigravityAgent === undefined) return undefined;
    return this.#antigravityResolver.resolve({
      name: resolved.antigravityAgent,
      cwd,
      ...(resolved.antigravityAgentFile === undefined ? {} : { file: resolved.antigravityAgentFile }),
    });
  }

  async #captureAgentDefinition(
    resolved: Pick<ResolvedAgentConfig, "backend" | "antigravityAgent" | "antigravityAgentFile">,
    cwd: string,
    existing?: AgentDefinitionMetadata,
    allowChange = false,
  ): Promise<AgentDefinitionMetadata | undefined> {
    const definition = await this.#resolveAntigravityDefinition(resolved, cwd);
    if (definition === undefined) return undefined;
    if (existing !== undefined) {
      if (existing.sha256 === definition.sha256) return existing;
      if (!allowChange) {
        throw new AntigravityAgentDefinitionError(
          `Antigravity agent "${definition.name}" changed since this conversation started ` +
            `(${existing.sha256.slice(0, 12)} -> ${definition.sha256.slice(0, 12)}). ` +
            "Pass allow_agent_definition_change: true to resume anyway, or spawn a new agent.",
          "ANTIGRAVITY_AGENT_CHANGED",
          {
            agent: definition.name,
            previousSha256: existing.sha256,
            currentSha256: definition.sha256,
            previousSourcePath: existing.sourcePath,
            currentSourcePath: definition.sourcePath,
          },
        );
      }
    }
    return this.#storeAgentDefinition(definition);
  }

  async #storeAgentDefinition(definition: AntigravityAgentDefinition): Promise<AgentDefinitionMetadata> {
    let snapshotPath: string | undefined;
    if (this.#persistencePath !== undefined) {
      const directory = join(dirname(this.#persistencePath), "antigravity-agents");
      try {
        await mkdir(directory, { recursive: true });
        snapshotPath = join(directory, `${definition.sha256}.md`);
        await writeFile(snapshotPath, definition.content, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        this.#storageError = `Unable to snapshot Antigravity agent definition: ${String(error)}`;
        snapshotPath = undefined;
      }
    }
    return {
      name: definition.name,
      sourcePath: definition.sourcePath,
      source: definition.source,
      portable: definition.portable,
      sha256: definition.sha256,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(definition.tools === undefined ? {} : { tools: definition.tools }),
      ...(definition.permission === undefined ? {} : { permission: definition.permission }),
      capturedAt: new Date().toISOString(),
      ...(snapshotPath === undefined ? {} : { snapshotPath }),
      bridge_enforced: false,
    };
  }

  #capacityKeys(backend: Backend, model: string): readonly string[] {
    const keys: string[] = [];
    if (this.#registry.perBackendConcurrency()[backend] !== undefined) keys.push(`backend:${backend}`);
    for (const rule of this.#registry.perModelConcurrency()) {
      if (matchesModelPattern(rule.pattern, backend, model)) keys.push(`model:${rule.pattern}`);
    }
    return keys;
  }

  #acquireCapacity(backend: Backend, model: string): Promise<() => void> {
    const placeholder = `pending-${randomUUID()}`;
    return this.#capacity.acquireWhenFree(placeholder, this.#capacityKeys(backend, model));
  }
}

export function modelRosterList(entries: readonly ModelEntry[]): readonly string[] {
  return entries.map((entry) => entry.name);
}

function isActiveState(state: ToolAgentState): boolean {
  return state === "starting" || state === "running" || state === "needs_approval";
}
