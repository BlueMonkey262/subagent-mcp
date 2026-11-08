import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import { signalProcessGroup } from "../../process-group.js";

import type { ApprovalResolution } from "../../approval/types.js";
import type { PermissionConfig } from "../../config/schema.js";
import { SubagentError } from "../../core/errors.js";
import type { Usage } from "../../core/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ResumeRequest, SpawnRequest } from "../adapter.js";

/**
 * Cursor Agent CLI adapter. Unlike Claude/Codex/Antigravity, the Cursor CLI is one process per
 * turn: `agent -p --output-format stream-json ... "<prompt>"` runs a single non-interactive turn
 * and exits. Continuation is a fresh process with `--resume <session_id>`, so the durable state
 * this adapter keeps per agent is only the CLI `session_id` observed in the first `system/init`.
 *
 * Verified live against `agent 2026.10.16-e3cb207`:
 * - stdout is newline-delimited JSON. `{"type":"system","subtype":"init",...}` carries the
 *   `session_id`; `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text",...}]}}`
 *   carries assistant text; `{"type":"tool_call","subtype":"started"|"completed","call_id":...,
 *   "tool_call":{"shellToolCall"|"editToolCall":{...}}}` carries tool activity; and
 *   `{"type":"result","subtype":"success","is_error":false,"result":"...","usage":{...}}` ends the
 *   turn. `thinking` deltas are internal reasoning and are ignored.
 * - The process exits on its own after writing `result`; a non-zero exit or a `result` with
 *   `is_error: true` is a failure.
 *
 * Approval mapping (print mode has no interactive approval protocol, so a request can never be
 * parked and `approve()` cannot be honored):
 * - `permission.default: "allow"` -> `--force` with `--sandbox enabled`: the operator's common
 *   invocation, and the only configuration under which the agent may actually run commands/edits.
 * - `permission.default: "escalate"` (the default) or `"deny"` -> no `--force`, `--mode plan`: a
 *   read-only planning turn, because the bridge cannot ask the parent and answer the CLI. Deny
 *   lists are therefore not natively enforceable (the CLI has no flag for them); a config that
 *   needs execution must opt in with `permission.default: allow` and rely on the sandbox.
 */

const DEFAULT_INIT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERRUPT_GRACE_MS = 3_000;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface CursorAdapterOptions {
  readonly executable?: string;
  /** Fixed argv before Cursor flags. Intended for wrapped binaries and process fixtures. */
  readonly executableArgs?: readonly string[];
  readonly initTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly stderrLimitBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  readonly spawnProcess?: SpawnProcess;
}

export class CursorAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "CURSOR_ADAPTER_ERROR", details);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
}

interface CursorTurn {
  readonly id: string;
  terminal: boolean;
  interruptRequested: boolean;
  timedOut: boolean;
  timeout?: NodeJS.Timeout;
  interruptPromise?: Promise<void>;
}

interface CursorSession {
  agentId?: string;
  readonly expectedAgentId?: string;
  readonly requestModel: string;
  readonly cwd: string;
  readonly permission: PermissionConfig;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Deferred<string>;
  readonly pendingBeforeInit: Readonly<Record<string, unknown>>[];
  readonly startedTools: Set<string>;
  readonly completedTools: Set<string>;
  currentTurn: CursorTurn;
  stdoutBuffer: string;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  initTimer?: NodeJS.Timeout;
}

/** One-turn-per-process Cursor Agent CLI adapter; `send_message` resumes with `--resume`. */
export class CursorAdapter implements BackendAdapter {
  readonly backend = "cursor" as const;
  /** Print mode has no approval-response channel; a deny `message` never reaches the child. */
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly #options: Required<Pick<CursorAdapterOptions,
    "executable" | "initTimeoutMs" | "interruptGraceMs" | "stderrLimitBytes">> & CursorAdapterOptions;
  readonly #sessions = new Map<string, CursorSession>();
  readonly #launches = new Set<CursorSession>();
  readonly #spawnProcess: SpawnProcess;

  constructor(options: CursorAdapterOptions = {}) {
    this.#options = {
      ...options,
      executable: options.executable ?? "agent",
      initTimeoutMs: positiveInteger(options.initTimeoutMs, "initTimeoutMs", DEFAULT_INIT_TIMEOUT_MS),
      interruptGraceMs: positiveInteger(options.interruptGraceMs, "interruptGraceMs", DEFAULT_INTERRUPT_GRACE_MS),
      stderrLimitBytes: positiveInteger(options.stderrLimitBytes, "stderrLimitBytes", DEFAULT_STDERR_LIMIT_BYTES),
    };
    this.buffer = options.buffer ?? new EventBuffer();
    this.#spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    validateRequest(request);
    const turnId = randomUUID();
    const session = this.#launch(request, turnId);
    const agentId = await session.ready.promise;
    if (request.timeoutMs !== undefined) this.#armTimeout(session, request.timeoutMs);
    return { agentId, turnId, backend: this.backend };
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validateRequest(request);
    const existing = this.#sessions.get(request.agentId);
    if (existing && !existing.exited) {
      if (!existing.currentTurn.terminal) {
        throw new CursorAdapterError(`Cursor session ${request.agentId} already has an active turn`, { agentId: request.agentId });
      }
      // A finished turn's process should already have exited; reap it before launching the resume.
      this.#terminate(existing);
    }
    const turnId = randomUUID();
    const session = this.#launch(request, turnId, request.agentId);
    const actualId = await session.ready.promise;
    if (actualId !== request.agentId) {
      this.#terminate(session);
      throw new CursorAdapterError("Cursor resumed with a different session ID", {
        expected: request.agentId,
        actual: actualId,
      });
    }
    if (request.timeoutMs !== undefined) this.#armTimeout(session, request.timeoutMs);
    return { agentId: actualId, turnId, backend: this.backend };
  }

  async interrupt(agentId: string): Promise<void> {
    return this.#interruptSession(this.#requireSession(agentId));
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  async approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    this.#requireSession(agentId);
    throw new CursorAdapterError(
      `Cursor print mode does not expose approval ${resolution.requestId} to the host`,
      { agentId, requestId: resolution.requestId },
    );
  }

  async close(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    if (!session.currentTurn.terminal) await this.#interruptSession(session);
    this.#terminate(session);
  }

  async closeAll(): Promise<void> {
    for (const session of this.#sessions.values()) this.#terminate(session);
    for (const launch of this.#launches) this.#terminate(launch);
  }

  #launch(
    request: Pick<SpawnRequest, "prompt" | "model" | "cwd" | "permission" | "env">,
    turnId: string,
    expectedAgentId?: string,
  ): CursorSession {
    const child = this.#spawnProcess(this.#options.executable, [
      ...(this.#options.executableArgs ?? []),
      ...buildCursorArguments(request, expectedAgentId),
    ], {
      cwd: request.cwd,
      env: { ...process.env, ...this.#options.env, ...request.env },
      shell: false,
      windowsHide: true,
      // Own process group so stop_agent/timeout can reap the whole tree (`agent` spawns shells).
      detached: true,
    });
    const session: CursorSession = {
      ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
      requestModel: request.model,
      cwd: request.cwd,
      permission: request.permission,
      child,
      ready: deferred<string>(),
      pendingBeforeInit: [],
      startedTools: new Set(),
      completedTools: new Set(),
      currentTurn: newTurn(turnId),
      stdoutBuffer: "",
      stderr: "",
      exited: false,
      exitCode: null,
      exitSignal: null,
    };
    this.#launches.add(session);
    session.initTimer = setTimeout(() => {
      const error = new CursorAdapterError(`Cursor did not emit system/init within ${this.#options.initTimeoutMs}ms`, {
        stderr: scanChildOutput(session.stderr),
      });
      if (!session.ready.settled) {
        session.ready.settled = true;
        session.ready.reject(error);
      }
      this.#terminate(session);
    }, this.#options.initTimeoutMs);
    session.initTimer.unref();
    // The prompt is passed on argv; stdin is unused, so close it to rule out any wait for EOF.
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(session, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderr = boundedAppend(session.stderr, chunk, this.#options.stderrLimitBytes);
    });
    child.on("error", (error) => this.#onProcessError(session, error));
    // `close`, not `exit`: this process exits at the end of every turn, so stdout must be drained
    // (and its trailing line parsed) before the turn is reconciled.
    child.on("close", (code, signal) => this.#onClose(session, code, signal));
    return session;
  }

  #onStdout(session: CursorSession, chunk: string): void {
    session.stdoutBuffer += chunk;
    let newline = session.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = session.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
      this.#handleLine(session, line);
      newline = session.stdoutBuffer.indexOf("\n");
    }
  }

  #handleLine(session: CursorSession, line: string): void {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#protocolFailure(session, "Malformed JSON on Cursor stdout", {
        lineLength: line.length,
        parseError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      this.#protocolFailure(session, "Cursor stdout message lacks a type discriminator");
      return;
    }
    this.#onMessage(session, message);
  }

  #onMessage(session: CursorSession, message: Readonly<Record<string, unknown>>): void {
    if (message.type === "system") {
      if (message.subtype === "init") this.#onInit(session, message);
      return;
    }
    if (!session.agentId) {
      (session.pendingBeforeInit as Readonly<Record<string, unknown>>[]).push(message);
      return;
    }
    switch (message.type) {
      case "assistant":
        this.#onAssistant(session, message);
        break;
      case "tool_call":
        this.#onToolCall(session, message);
        break;
      case "result":
        this.#onResult(session, message);
        break;
      default:
        break; // `user` echoes and `thinking` deltas carry nothing the parent needs.
    }
  }

  #onInit(session: CursorSession, message: Readonly<Record<string, unknown>>): void {
    const sessionId = message.session_id;
    if (typeof sessionId !== "string" || sessionId === "") {
      this.#protocolFailure(session, "Cursor system/init lacks session_id");
      return;
    }
    if (session.agentId && session.agentId !== sessionId) {
      this.#protocolFailure(session, "Cursor changed session_id during a live process", {
        expected: session.agentId,
        actual: sessionId,
      });
      return;
    }
    if (session.expectedAgentId !== undefined && session.expectedAgentId !== sessionId) {
      this.#protocolFailure(session, "Cursor resumed with an unexpected session_id", {
        expected: session.expectedAgentId,
        actual: sessionId,
      });
      return;
    }
    const collision = this.#sessions.get(sessionId);
    if (collision && collision !== session && !collision.exited) {
      this.#protocolFailure(session, `Cursor session ${sessionId} is already owned by another process`);
      return;
    }
    session.agentId = sessionId;
    this.#sessions.set(sessionId, session);
    this.#launches.delete(session);
    if (session.initTimer) clearTimeout(session.initTimer);
    this.#emit(session, "thread.started", { threadId: sessionId, turnId: session.currentTurn.id });
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.resolve(sessionId);
    }
    const queued = (session.pendingBeforeInit as Readonly<Record<string, unknown>>[]).splice(0);
    for (const queuedMessage of queued) this.#onMessage(session, queuedMessage);
  }

  #onAssistant(session: CursorSession, message: Readonly<Record<string, unknown>>): void {
    const body = isRecord(message.message) ? message.message : undefined;
    const content = Array.isArray(body?.content) ? body.content : [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text !== "") {
        this.#emit(session, "message.delta", { text: scanChildOutput(block.text) });
      }
    }
  }

  #onToolCall(session: CursorSession, message: Readonly<Record<string, unknown>>): void {
    const subtype = message.subtype;
    if (subtype !== "started" && subtype !== "completed") return;
    const rawToolCall = isRecord(message.tool_call) ? message.tool_call : {};
    const described = describeToolCall(rawToolCall);
    const callId = typeof message.call_id === "string" && message.call_id !== ""
      ? message.call_id
      : described.callId ?? `${session.currentTurn.id}-tool-${session.startedTools.size}`;
    if (!session.startedTools.has(callId)) {
      session.startedTools.add(callId);
      this.#emit(session, "tool.start", { toolCallId: callId, toolName: described.toolName, input: described.input });
    }
    if (subtype !== "completed") return;
    if (session.completedTools.has(callId)) return;
    session.completedTools.add(callId);
    this.#emit(session, "tool.end", {
      toolCallId: callId,
      toolName: described.toolName,
      status: toolStatus(described.result),
      ...(isRecord(described.result) ? { output: described.result } : {}),
    });
  }

  #onResult(session: CursorSession, message: Readonly<Record<string, unknown>>): void {
    const turn = session.currentTurn;
    if (turn.terminal) return;
    const sessionId = message.session_id;
    if (typeof sessionId === "string" && sessionId !== session.agentId) {
      this.#protocolFailure(session, "Cursor result session_id does not match system/init", {
        expected: session.agentId,
        actual: sessionId,
      });
      return;
    }
    const subtype = typeof message.subtype === "string" ? message.subtype : "success";
    const failed = message.is_error === true || subtype !== "success";
    if (failed && !turn.interruptRequested && !turn.timedOut) {
      const text = typeof message.result === "string" && message.result !== ""
        ? message.result
        : `Cursor turn ended with ${subtype}`;
      this.#emit(session, "error", {
        code: "CURSOR_TURN_FAILED",
        message: scanChildOutput(text),
        fatal: false,
        details: { subtype, sessionId: session.agentId },
      });
    }
    const status = turn.timedOut ? "failed"
      : turn.interruptRequested || subtype === "interrupted" || subtype === "cancelled" || subtype === "canceled" ? "interrupted"
      : failed ? "failed"
      : "completed";
    const finalText = typeof message.result === "string" && message.result !== ""
      ? scanChildOutput(message.result)
      : undefined;
    this.#completeTurn(session, status, finalText, extractUsage(message));
  }

  #armTimeout(session: CursorSession, timeoutMs: number): void {
    const turn = session.currentTurn;
    if (turn.terminal) return;
    turn.timeout = setTimeout(() => {
      if (turn.terminal) return;
      turn.timedOut = true;
      this.#emit(session, "error", {
        code: "CURSOR_TURN_TIMEOUT",
        message: `Cursor turn exceeded ${timeoutMs}ms`,
        fatal: true,
        details: { turnId: turn.id },
      });
      void this.#interruptSession(session).catch(() => this.#terminate(session));
    }, timeoutMs);
    turn.timeout.unref();
  }

  #interruptSession(session: CursorSession): Promise<void> {
    const turn = session.currentTurn;
    if (turn.terminal) return Promise.resolve();
    if (turn.interruptPromise) return turn.interruptPromise;
    turn.interruptRequested = true;
    turn.interruptPromise = (async () => {
      this.#signalGroup(session, "SIGTERM");
      await new Promise<void>((resolve) => {
        if (turn.terminal) return resolve();
        const timer = setTimeout(() => resolve(), this.#options.interruptGraceMs);
        const check = setInterval(() => {
          if (turn.terminal) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 20);
      });
      if (!turn.terminal) {
        this.#signalGroup(session, "SIGKILL");
        this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
      }
    })();
    return turn.interruptPromise;
  }

  #completeTurn(
    session: CursorSession,
    status: NormalizedEventData["turn.completed"]["status"],
    finalText?: string,
    usage?: Usage,
  ): void {
    const turn = session.currentTurn;
    if (turn.terminal) return;
    turn.terminal = true;
    if (turn.timeout) clearTimeout(turn.timeout);
    this.#emit(session, "turn.completed", {
      turnId: turn.id,
      status,
      ...(finalText === undefined ? {} : { finalText }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  #onProcessError(session: CursorSession, error: Error): void {
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(new CursorAdapterError(`Failed to start Cursor: ${error.message}`, {
        executable: this.#options.executable,
      }));
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", {
        code: "CURSOR_PROCESS_ERROR",
        message: scanChildOutput(error.message),
        fatal: true,
      });
      this.#completeTurn(session, "failed");
    }
  }

  #onClose(session: CursorSession, code: number | null, signal: NodeJS.Signals | null): void {
    session.exited = true;
    session.exitCode = code;
    session.exitSignal = signal;
    if (session.initTimer) clearTimeout(session.initTimer);
    // Parse any complete final line that arrived without a trailing newline before the pipe closed.
    if (session.stdoutBuffer.trim() !== "" && !session.currentTurn.terminal) {
      const trailing = session.stdoutBuffer;
      session.stdoutBuffer = "";
      this.#handleLine(session, trailing);
    }
    if (!session.agentId) {
      if (!session.ready.settled) {
        session.ready.settled = true;
        session.ready.reject(new CursorAdapterError("Cursor exited before emitting system/init", {
          code,
          signal,
          stderr: scanChildOutput(session.stderr),
        }));
      }
      return;
    }
    const turn = session.currentTurn;
    if (turn.terminal) return;
    if (turn.interruptRequested) {
      // A deliberate stop (or a timeout) is not a process fault.
      this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
      return;
    }
    const error = new CursorAdapterError("Cursor process exited before the turn completed", {
      code,
      signal,
      stderr: scanChildOutput(session.stderr),
    });
    this.#emit(session, "error", {
      code: "CURSOR_PROCESS_EXIT",
      message: error.message,
      fatal: true,
      details: { code, signal, exitCode: code, stderr: scanChildOutput(session.stderr) },
    });
    this.#completeTurn(session, "failed");
  }

  #protocolFailure(session: CursorSession, message: string, details?: Readonly<Record<string, unknown>>): void {
    const error = new CursorAdapterError(message, details);
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(error);
    }
    if (session.currentTurn.interruptRequested || session.currentTurn.timedOut) {
      // A killed process can leave a torn final line; that is expected, not a protocol violation.
      this.#completeTurn(session, session.currentTurn.timedOut ? "failed" : "interrupted");
      return;
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", {
        code: "CURSOR_PROTOCOL_ERROR",
        message,
        fatal: true,
        ...(details === undefined ? {} : { details }),
      });
      this.#completeTurn(session, "failed");
    }
    this.#terminate(session);
  }

  #emit<T extends NormalizedEventType>(session: CursorSession, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    if (!session.agentId) throw new CursorAdapterError(`Cannot emit ${type} before Cursor initialization`);
    return this.buffer.append({
      type,
      agentId: session.agentId,
      backend: this.backend,
      data,
    } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #requireSession(agentId: string): CursorSession {
    const session = this.#sessions.get(agentId);
    if (!session) throw new CursorAdapterError(`Unknown Cursor session ${agentId}`, { agentId });
    return session;
  }

  /** SIGTERM the whole process group; fall back to the direct child if the group signal fails. */
  #signalGroup(session: CursorSession, signal: NodeJS.Signals): void {
    signalProcessGroup(session.child, signal);
  }

  #terminate(session: CursorSession): void {
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.currentTurn.timeout) clearTimeout(session.currentTurn.timeout);
    this.#signalGroup(session, "SIGTERM");
  }
}

export function buildCursorArguments(
  request: Pick<SpawnRequest, "prompt" | "model" | "cwd" | "permission">,
  resumeId?: string,
): string[] {
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new CursorAdapterError("Cursor requires an explicit model");
  }
  if (typeof request.cwd !== "string" || request.cwd.trim() === "") {
    throw new CursorAdapterError("Cursor requires a cwd");
  }
  validatePermission(request.permission);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--trust",
    "--sandbox", "enabled",
    "--workspace", request.cwd,
    "--model", request.model,
  ];
  if (resumeId !== undefined) args.push("--resume", resumeId);
  if (permitsExecution(request.permission)) {
    args.push("--force");
  } else {
    args.push("--mode", "plan");
  }
  args.push(request.prompt);
  return args;
}

/** Only an explicit `allow` default opts into command execution; everything else runs read-only. */
function permitsExecution(permission: PermissionConfig): boolean {
  return permission.default === "allow";
}

function describeToolCall(toolCall: Readonly<Record<string, unknown>>): {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly callId?: string;
} {
  const entry = Object.entries(toolCall).find(([, value]) => isRecord(value));
  if (!entry) return { toolName: "tool", input: {}, result: undefined };
  const [key, value] = entry as [string, Readonly<Record<string, unknown>>];
  const toolName = key.replace(/ToolCall$/, "") || key;
  return {
    toolName,
    input: isRecord(value.args) ? value.args : {},
    result: value.result,
    ...(typeof value.toolCallId === "string" && value.toolCallId !== "" ? { callId: value.toolCallId } : {}),
  };
}

function toolStatus(result: unknown): "completed" | "failed" {
  if (!isRecord(result)) return "completed";
  if (result.isError === true || "failure" in result || "error" in result || "rejected" in result) return "failed";
  return "completed";
}

function extractUsage(message: Readonly<Record<string, unknown>>): Usage | undefined {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  if (!usage) return undefined;
  const result: Usage = {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
    ...(typeof usage.cacheReadTokens === "number" ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    // inputTokens excludes cache reads (recorded turns show cacheReadTokens far above it); writes were fresh.
    ...(typeof usage.inputTokens === "number"
      ? { uncachedInputTokens: usage.inputTokens + (typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0) }
      : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function validateRequest(request: Pick<SpawnRequest, "prompt" | "model" | "cwd" | "permission">): void {
  buildCursorArguments(request);
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw new CursorAdapterError("Cursor requires a non-empty prompt");
  }
}

function validatePermission(permission: PermissionConfig): void {
  if (!permission || !Array.isArray(permission.allow) || !Array.isArray(permission.deny)) {
    throw new CursorAdapterError("Cursor requires resolved permission rules");
  }
}

function newTurn(id: string): CursorTurn {
  return { id, terminal: false, interruptRequested: false, timedOut: false };
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

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedAppend(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= limit) return combined;
  const bytes = Buffer.from(combined);
  return `[stderr truncated]\n${bytes.subarray(Math.max(0, bytes.length - limit)).toString("utf8")}`;
}
