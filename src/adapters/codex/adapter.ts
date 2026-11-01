import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import { signalProcessGroup } from "../../process-group.js";

import type { ApprovalResolution } from "../../approval/types.js";
import { SubagentError } from "../../core/errors.js";
import type { Usage } from "../../core/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ResumeRequest, SpawnRequest } from "../adapter.js";

/**
 * Verified live against the installed `codex-cli 0.153.3` app-server (see the probe transcripts
 * this adapter was built from). Two findings from that verification, not from documentation:
 *
 * 1. No `jsonrpc` member appears on any wire message, matching the acceptance doc's note.
 * 2. On this host, Codex's `workspaceWrite` sandbox does not actually confine writes to
 *    `writableRoots`, and `networkAccess: false` does not block network egress — a probed
 *    command wrote outside cwd and another completed an HTTPS request with neither ever
 *    reaching `item/*\/requestApproval`. This looks like a Linux sandbox (Landlock/seccomp)
 *    that silently degrades to no enforcement rather than failing closed when the sandbox
 *    backend is unavailable (e.g. inside this container). This adapter still wires the full
 *    approval-request/response protocol correctly, but on a host with a similarly inert
 *    sandbox the bridge will only ever see approvals Codex itself decides to ask for — treat
 *    the Codex backend here as running with effectively full execution trust until sandbox
 *    enforcement is independently confirmed on the target host.
 */

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface CodexAdapterOptions {
  readonly executable?: string;
  readonly executableArgs?: readonly string[];
  readonly initTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly stderrLimitBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  readonly spawnProcess?: SpawnProcess;
}

export class CodexAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "CODEX_ADAPTER_ERROR", details);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

interface PendingApproval {
  readonly wireId: number | string;
  readonly itemId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface CodexTurn {
  id?: string;
  terminal: boolean;
  interruptRequested: boolean;
  timedOut: boolean;
  timeout?: NodeJS.Timeout;
  interruptPromise?: Promise<void>;
}

interface CodexSession {
  threadId?: string;
  readonly expectedThreadId?: string;
  readonly requestModel: string;
  readonly cwd: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Deferred<string>;
  readonly outgoing: Map<number, Deferred<Readonly<Record<string, unknown>>>>;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly startedItems: Map<string, Readonly<Record<string, unknown>>>;
  readonly completedToolIds: Set<string>;
  currentTurn: CodexTurn;
  lastUsage?: Usage;
  stdoutBuffer: string;
  stderr: string;
  exited: boolean;
  nextRequestId: number;
  initTimer?: NodeJS.Timeout;
}

/** Persistent Codex `app-server` JSON-RPC adapter. One child process per session. */
export class CodexAdapter implements BackendAdapter {
  readonly backend = "codex" as const;
  /** Codex's approval-response wire format is decision-only; a deny `message` never reaches the child. */
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly #options: Required<Pick<CodexAdapterOptions, "executable" | "executableArgs" | "initTimeoutMs" | "interruptGraceMs" | "stderrLimitBytes">> & CodexAdapterOptions;
  readonly #sessions = new Map<string, CodexSession>();
  readonly #launches = new Set<CodexSession>();
  readonly #spawnProcess: SpawnProcess;

  constructor(options: CodexAdapterOptions = {}) {
    this.#options = {
      ...options,
      executable: options.executable ?? "codex",
      executableArgs: options.executableArgs ?? ["app-server"],
      initTimeoutMs: positiveInteger(options.initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS),
      interruptGraceMs: positiveInteger(options.interruptGraceMs, DEFAULT_INTERRUPT_GRACE_MS),
      stderrLimitBytes: positiveInteger(options.stderrLimitBytes, DEFAULT_STDERR_LIMIT_BYTES),
    };
    this.buffer = options.buffer ?? new EventBuffer();
    this.#spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    validateRequest(request.model, request.cwd);
    const session = this.#launch(request);
    await this.#handshake(session);
    const threadStart = await this.#request(session, "thread/start", {
      cwd: request.cwd,
      model: request.model,
      ...(request.modelProvider === undefined ? {} : { modelProvider: request.modelProvider }),
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [request.cwd] },
    });
    const threadId = requireString(get(threadStart, "thread", "id"), "thread/start response thread.id");
    session.threadId = threadId;
    this.#sessions.set(threadId, session);
    this.#launches.delete(session);
    this.#emit(session, "thread.started", { threadId });
    await this.#startTurn(session, request.prompt, request.timeoutMs, request.reasoningEffort);
    return { agentId: threadId, turnId: requireString(session.currentTurn.id, "turn id"), backend: this.backend };
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validateRequest(request.model, request.cwd);
    const existing = this.#sessions.get(request.agentId);
    if (existing && !existing.exited) {
      if (!existing.currentTurn.terminal) {
        throw new CodexAdapterError(`Codex thread ${request.agentId} already has an active turn`, { agentId: request.agentId });
      }
      await this.#startTurn(existing, request.prompt, request.timeoutMs, request.reasoningEffort);
      return { agentId: request.agentId, turnId: requireString(existing.currentTurn.id, "turn id"), backend: this.backend };
    }
    const session = this.#launch({ cwd: request.cwd, model: request.model }, request.agentId);
    await this.#handshake(session);
    const resumed = await this.#request(session, "thread/resume", {
      threadId: request.agentId,
      excludeTurns: true,
      ...(request.modelProvider === undefined ? {} : { modelProvider: request.modelProvider }),
    });
    const threadId = requireString(get(resumed, "thread", "id"), "thread/resume response thread.id");
    if (threadId !== request.agentId) {
      this.#terminate(session);
      throw new CodexAdapterError("Codex resumed with a different thread ID", { expected: request.agentId, actual: threadId });
    }
    session.threadId = threadId;
    this.#sessions.set(threadId, session);
    this.#launches.delete(session);
    await this.#startTurn(session, request.prompt, request.timeoutMs, request.reasoningEffort);
    return { agentId: threadId, turnId: requireString(session.currentTurn.id, "turn id"), backend: this.backend };
  }

  async interrupt(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    const turn = session.currentTurn;
    if (turn.terminal) return;
    if (turn.interruptPromise) return turn.interruptPromise;
    turn.interruptRequested = true;
    // turn/interrupt does not reap shells Codex already spawned (cargo, check_task).
    // Signal the whole process group first; the protocol interrupt is best-effort after that.
    this.#signalGroup(session, "SIGTERM");
    turn.interruptPromise = (async () => {
      try {
        await this.#request(session, "turn/interrupt", { threadId: agentId, turnId: turn.id });
      } catch {
        // The process group is already dying.
      }
      await new Promise<void>((resolve) => {
        if (turn.terminal) return resolve();
        const timer = setTimeout(() => resolve(), this.#options.interruptGraceMs);
        timer.unref();
        const check = setInterval(() => {
          if (turn.terminal) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 20);
        check.unref();
      });
      if (!turn.terminal) {
        this.#signalGroup(session, "SIGKILL");
        this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
      }
    })();
    return turn.interruptPromise;
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  async approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    const session = this.#requireSession(agentId);
    const pending = session.pendingApprovals.get(resolution.requestId);
    if (!pending) {
      throw new CodexAdapterError(`No pending Codex approval ${resolution.requestId} for ${agentId}`, { agentId, requestId: resolution.requestId });
    }
    const decision = resolution.decision === "allow" ? "accept"
      : resolution.decision === "allow_for_session" ? "acceptForSession"
      : "decline";
    this.#send(session, { id: pending.wireId, result: { decision } });
    session.pendingApprovals.delete(resolution.requestId);
  }

  async close(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    if (!session.currentTurn.terminal) await this.interrupt(agentId);
    this.#terminate(session);
  }

  async closeAll(): Promise<void> {
    for (const session of this.#sessions.values()) this.#terminate(session);
    for (const launch of this.#launches) this.#terminate(launch);
  }

  #launch(request: Pick<SpawnRequest, "cwd" | "model">, expectedThreadId?: string): CodexSession {
    const child = this.#spawnProcess(this.#options.executable, [...this.#options.executableArgs], {
      cwd: request.cwd,
      env: { ...process.env, ...this.#options.env },
      shell: false,
      windowsHide: true,
      // Own process group so stop and timeout can reap shells Codex spawned.
      detached: true,
    });
    const session: CodexSession = {
      ...(expectedThreadId === undefined ? {} : { expectedThreadId }),
      requestModel: request.model,
      cwd: request.cwd,
      child,
      ready: deferred<string>(),
      outgoing: new Map(),
      pendingApprovals: new Map(),
      startedItems: new Map(),
      completedToolIds: new Set(),
      currentTurn: { terminal: false, interruptRequested: false, timedOut: false },
      stdoutBuffer: "",
      stderr: "",
      nextRequestId: 1,
      exited: false,
    };
    this.#launches.add(session);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(session, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderr = boundedAppend(session.stderr, chunk, this.#options.stderrLimitBytes);
    });
    child.on("error", (error) => this.#onProcessError(session, error));
    child.on("exit", (code, signal) => this.#onExit(session, code, signal));
    return session;
  }

  async #handshake(session: CodexSession): Promise<void> {
    const timer = setTimeout(() => {
      this.#terminate(session);
    }, this.#options.initTimeoutMs);
    timer.unref();
    try {
      await this.#request(session, "initialize", { clientInfo: { name: "subagent-mcp", version: "0.1.0" } });
      this.#send(session, { method: "initialized" });
    } finally {
      clearTimeout(timer);
    }
  }

  async #startTurn(session: CodexSession, prompt: string, timeoutMs?: number, reasoningEffort?: string): Promise<void> {
    if (!session.threadId) throw new CodexAdapterError("Cannot start a Codex turn before thread/start resolves");
    session.currentTurn = { terminal: false, interruptRequested: false, timedOut: false };
    const started = await this.#request(session, "turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text: prompt }],
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
    const turnId = requireString(get(started, "turn", "id"), "turn/start response turn.id");
    session.currentTurn.id = turnId;
    if (timeoutMs !== undefined) {
      session.currentTurn.timeout = setTimeout(() => {
        if (session.currentTurn.id !== turnId || session.currentTurn.terminal) return;
        session.currentTurn.timedOut = true;
        this.#emit(session, "error", { code: "CODEX_TURN_TIMEOUT", message: `Codex turn exceeded ${timeoutMs}ms`, fatal: true, details: { turnId } });
        this.#signalGroup(session, "SIGTERM");
        void this.interrupt(session.threadId ?? "").catch(() => this.#terminate(session));
      }, timeoutMs);
      session.currentTurn.timeout.unref();
    }
  }

  #onStdout(session: CodexSession, chunk: string): void {
    session.stdoutBuffer += chunk;
    let newline = session.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = session.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
      if (line.trim() !== "") {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch (error) {
          this.#protocolFailure(session, "Malformed JSON on Codex stdout", {
            parseError: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (!isRecord(message)) {
          this.#protocolFailure(session, "Codex stdout message is not an object");
          return;
        }
        this.#onMessage(session, message);
      }
      newline = session.stdoutBuffer.indexOf("\n");
    }
  }

  #onMessage(session: CodexSession, message: Readonly<Record<string, unknown>>): void {
    const id = message.id;
    const method = message.method;
    if (typeof method !== "string") {
      // response to one of our outgoing requests
      if (typeof id !== "number" && typeof id !== "string") return;
      const pending = session.outgoing.get(Number(id));
      if (!pending || pending.settled) return;
      pending.settled = true;
      if (isRecord(message.error)) {
        pending.reject(new CodexAdapterError(`Codex request ${String(id)} failed`, { error: message.error }));
      } else {
        pending.resolve(isRecord(message.result) ? message.result : {});
      }
      return;
    }
    if (id !== undefined) {
      this.#onServerRequest(session, method, id, isRecord(message.params) ? message.params : {});
      return;
    }
    this.#onNotification(session, method, isRecord(message.params) ? message.params : {});
  }

  #onServerRequest(session: CodexSession, method: string, id: unknown, params: Readonly<Record<string, unknown>>): void {
    const wireId = typeof id === "number" || typeof id === "string" ? id : undefined;
    if (wireId === undefined) return;
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"].includes(method)) {
      return; // unhandled server request kinds (e.g. requestUserInput) are out of scope for now
    }
    if (!session.threadId) return;
    const itemId = requireString(params.itemId, "approval request itemId");
    const requestId = String(wireId);
    if (session.pendingApprovals.has(requestId)) return;
    const relatedItem = session.startedItems.get(itemId);
    const toolName = method.includes("fileChange") || method === "applyPatchApproval" ? "fileChange" : "commandExecution";
    const command = typeof params.command === "string" ? params.command : extractCommandFromItem(relatedItem);
    const paths = extractPathsFromItem(relatedItem);
    const reason = typeof params.reason === "string" ? params.reason : undefined;
    session.pendingApprovals.set(requestId, { wireId, itemId, toolName, input: params });
    this.#emit(session, "approval.requested", {
      requestId,
      agentId: session.threadId,
      backend: this.backend,
      toolName,
      input: params,
      cwd: typeof params.cwd === "string" ? params.cwd : session.cwd,
      ...(command === undefined ? {} : { command }),
      ...(paths.length === 0 ? {} : { paths }),
      ...(reason === undefined ? {} : { reason }),
      requestedAt: new Date().toISOString(),
    });
  }

  #onNotification(session: CodexSession, method: string, params: Readonly<Record<string, unknown>>): void {
    switch (method) {
      case "item/started": {
        const item = isRecord(params.item) ? params.item : undefined;
        if (!item || typeof item.id !== "string") return;
        session.startedItems.set(item.id, item);
        if (item.type === "commandExecution" || item.type === "fileChange") {
          this.#emit(session, "tool.start", { toolCallId: item.id, toolName: String(item.type), input: item });
        }
        return;
      }
      case "item/agentMessage/delta": {
        if (typeof params.delta === "string" && params.delta !== "") {
          this.#emit(session, "message.delta", { text: scanChildOutput(params.delta) });
        }
        return;
      }
      case "item/completed": {
        const item = isRecord(params.item) ? params.item : undefined;
        if (!item || typeof item.id !== "string") return;
        session.startedItems.set(item.id, item);
        if ((item.type === "commandExecution" || item.type === "fileChange") && !session.completedToolIds.has(item.id)) {
          session.completedToolIds.add(item.id);
          this.#emit(session, "tool.end", {
            toolCallId: item.id,
            toolName: String(item.type),
            status: item.status === "failed" ? "failed" : "completed",
            output: item,
          });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        if (session.currentTurn.id !== undefined && params.turnId === session.currentTurn.id) {
          const usage = extractUsage(params);
          if (usage !== undefined) session.lastUsage = usage;
        }
        return;
      }
      case "turn/completed": {
        this.#onTurnCompleted(session, params);
        return;
      }
      default:
        return; // additive/unknown notifications are tolerated
    }
  }

  #onTurnCompleted(session: CodexSession, params: Readonly<Record<string, unknown>>): void {
    if (session.currentTurn.terminal) return;
    const turn = isRecord(params.turn) ? params.turn : undefined;
    if (!turn || typeof turn.status !== "string") {
      this.#protocolFailure(session, "Codex turn/completed lacks a turn.status");
      return;
    }
    const status = session.currentTurn.timedOut ? "failed"
      : turn.status === "completed" ? "completed"
      : turn.status === "interrupted" ? "interrupted"
      : "failed";
    if (status === "failed" && turn.status === "failed" && isRecord(turn.error)) {
      this.#emit(session, "error", {
        code: "CODEX_TURN_FAILED",
        message: scanChildOutput(typeof turn.error.message === "string" ? turn.error.message : "Codex turn failed"),
        fatal: false,
      });
    }
    const items = Array.isArray(turn.items) ? turn.items : [];
    const finalMessage = [...items].reverse().find(
      (item): item is Readonly<Record<string, unknown>> => isRecord(item) && item.type === "agentMessage" && typeof item.text === "string",
    );
    const finalText = typeof finalMessage?.text === "string" ? scanChildOutput(finalMessage.text) : undefined;
    this.#completeTurn(session, status, finalText, session.lastUsage);
  }

  #completeTurn(session: CodexSession, status: NormalizedEventData["turn.completed"]["status"], finalText?: string, usage?: Usage): void {
    if (session.currentTurn.terminal) return;
    session.currentTurn.terminal = true;
    if (session.currentTurn.timeout) clearTimeout(session.currentTurn.timeout);
    for (const [requestId, pending] of session.pendingApprovals) {
      if (!session.completedToolIds.has(pending.itemId)) {
        session.completedToolIds.add(pending.itemId);
        this.#emit(session, "tool.end", { toolCallId: pending.itemId, toolName: pending.toolName, status: status === "interrupted" ? "cancelled" : "denied" });
      }
      session.pendingApprovals.delete(requestId);
    }
    this.#emit(session, "turn.completed", {
      turnId: requireString(session.currentTurn.id, "turn id"),
      status,
      ...(finalText === undefined ? {} : { finalText }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  #request(session: CodexSession, method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const id = session.nextRequestId++;
    const pending = deferred<Readonly<Record<string, unknown>>>();
    session.outgoing.set(id, pending);
    this.#send(session, { id, method, params });
    return pending.promise;
  }

  #send(session: CodexSession, value: Readonly<Record<string, unknown>>): void {
    if (session.exited || session.child.stdin.destroyed || !session.child.stdin.writable) {
      throw new CodexAdapterError("Codex stdin is not writable", { threadId: session.threadId ?? session.expectedThreadId });
    }
    session.child.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
  }

  #onProcessError(session: CodexSession, error: Error): void {
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(new CodexAdapterError(`Failed to start Codex: ${error.message}`, { executable: this.#options.executable }));
    }
    if (session.threadId && !session.currentTurn.terminal) {
      this.#emit(session, "error", { code: "CODEX_PROCESS_ERROR", message: error.message, fatal: true });
      this.#completeTurn(session, "failed");
    }
  }

  #onExit(session: CodexSession, code: number | null, signal: NodeJS.Signals | null): void {
    session.exited = true;
    for (const pending of session.outgoing.values()) {
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(new CodexAdapterError("Codex process exited before responding", { code, signal }));
      }
    }
    if (session.threadId && !session.currentTurn.terminal) {
      const deliberate = session.currentTurn.timedOut || session.currentTurn.interruptRequested;
      if (!deliberate) {
        this.#emit(session, "error", {
          code: "CODEX_PROCESS_EXIT",
          message: "Codex process exited before the active turn completed",
          fatal: true,
          details: { code, signal, stderr: scanChildOutput(session.stderr) },
        });
      }
      this.#completeTurn(session, session.currentTurn.timedOut ? "failed" : session.currentTurn.interruptRequested ? "interrupted" : "failed");
    }
  }

  #protocolFailure(session: CodexSession, message: string, details?: Readonly<Record<string, unknown>>): void {
    const error = new CodexAdapterError(message, details);
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(error);
    }
    if (session.threadId && !session.currentTurn.terminal) {
      this.#emit(session, "error", { code: "CODEX_PROTOCOL_ERROR", message, fatal: true, ...(details === undefined ? {} : { details }) });
      this.#completeTurn(session, "failed");
    }
    this.#terminate(session);
  }

  #emit<T extends NormalizedEventType>(session: CodexSession, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    if (!session.threadId) throw new CodexAdapterError(`Cannot emit ${type} before Codex thread is known`);
    return this.buffer.append({ type, agentId: session.threadId, backend: this.backend, data } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #requireSession(agentId: string): CodexSession {
    const session = this.#sessions.get(agentId);
    if (!session) throw new CodexAdapterError(`Unknown Codex thread ${agentId}`, { agentId });
    return session;
  }

  #signalGroup(session: CodexSession, signal: NodeJS.Signals): void {
    signalProcessGroup(session.child, signal);
  }

  #terminate(session: CodexSession): void {
    this.#signalGroup(session, "SIGTERM");
  }
}

function validateRequest(model: string, cwd: string): void {
  if (typeof model !== "string" || model.trim() === "") throw new CodexAdapterError("Codex requires an explicit model");
  if (typeof cwd !== "string" || cwd.trim() === "") throw new CodexAdapterError("Codex requires a cwd");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("value must be a positive integer");
  return value;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise, settled: false };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(record: Readonly<Record<string, unknown>>, ...path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new CodexAdapterError(`Codex response is missing ${what}`);
  return value;
}

function extractCommandFromItem(item: Readonly<Record<string, unknown>> | undefined): string | undefined {
  return typeof item?.command === "string" ? item.command : undefined;
}

function extractPathsFromItem(item: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  if (!item) return [];
  const paths = new Set<string>();
  const changes = item.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (isRecord(change) && typeof change.path === "string") paths.add(change.path);
    }
  }
  if (typeof item.path === "string") paths.add(item.path);
  return [...paths];
}

function extractUsage(tokenUsageNotification: Readonly<Record<string, unknown>>): Usage | undefined {
  const total = get(tokenUsageNotification, "tokenUsage", "total");
  if (!isRecord(total)) return undefined;
  const result: Usage = {
    ...(typeof total.inputTokens === "number" ? { inputTokens: total.inputTokens } : {}),
    ...(typeof total.outputTokens === "number" ? { outputTokens: total.outputTokens } : {}),
    ...(typeof total.cachedInputTokens === "number" ? { cachedInputTokens: total.cachedInputTokens } : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function boundedAppend(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= limit) return combined;
  const bytes = Buffer.from(combined);
  return `[stderr truncated]\n${bytes.subarray(Math.max(0, bytes.length - limit)).toString("utf8")}`;
}
