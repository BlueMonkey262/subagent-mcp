import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import { signalProcessGroup } from "../../process-group.js";

import type { ApprovalResolution } from "../../approval/types.js";
import type { PermissionConfig } from "../../config/schema.js";
import { SubagentError } from "../../core/errors.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ResumeRequest, SpawnRequest } from "../adapter.js";

/**
 * GitHub Copilot CLI adapter. Like Cursor, the Copilot CLI is one process per turn:
 * `copilot --output-format json --prompt=<prompt>` runs a single non-interactive turn and exits.
 * Continuation is a fresh process with `--resume <sessionId>`.
 *
 * Verified live against `copilot 1.0.109`:
 * - stdout is JSONL. `session.start` (new) or `session.resume` (resumed, no id field) opens the
 *   session; `assistant.message` carries complete assistant text; `tool.execution_start` and
 *   `tool.execution_complete` carry tool activity; `session.error` reports failures such as an
 *   unavailable model; `result` (top-level `sessionId`, `exitCode`) ends the turn.
 * - Some startup errors print a plain-text line (on stdout or stderr) and go straight to `result`
 *   with no `session.start`, so `result.sessionId` can also open the session.
 * - Copilot locks a session while its process runs, so a resume first waits for the previous
 *   turn's process to exit.
 * - Headless mode cannot prompt: a tool request that no rule allows completes with
 *   `success: false` and `error.code: "denied"`, and the model continues.
 * - `result.usage` reports premium requests, not tokens, so turns carry no token usage.
 *
 * Permission mapping (no approval channel, so `approve()` cannot be honored):
 * - `permission.default: "allow"` -> `--allow-all-tools`.
 * - Otherwise only the translated `allow` rules are passed; everything else is denied headlessly.
 * - `deny` rules always pass through as `--deny-tool`, which Copilot enforces over any allow.
 * Rules translate from the Claude-style config syntax (`Bash(git:*)`, `Read`, `Write(src/**)`) to
 * Copilot's (`shell(git:*)`, `read`, `write(src/**)`); native Copilot rules pass through unchanged
 * and untranslatable rules are dropped.
 *
 * Copilot has no system-prompt flag, so the agent config body is prepended to the first prompt.
 */

const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_GRACE_MS = 3_000;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;
/** How long a resume waits for the previous turn's process to exit; Copilot locks a session while it runs. */
const DEFAULT_EXIT_WAIT_MS = 10_000;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface CopilotAdapterOptions {
  readonly executable?: string;
  /** Fixed argv before Copilot flags. Intended for wrapped binaries and process fixtures. */
  readonly executableArgs?: readonly string[];
  readonly initTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly stderrLimitBytes?: number;
  readonly exitWaitMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  readonly spawnProcess?: SpawnProcess;
}

export class CopilotAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "COPILOT_ADAPTER_ERROR", details);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
}

interface CopilotTurn {
  readonly id: string;
  terminal: boolean;
  interruptRequested: boolean;
  timedOut: boolean;
  finalText?: string;
  errorMessage?: string;
  timeout?: NodeJS.Timeout;
  interruptPromise?: Promise<void>;
}

interface CopilotSession {
  agentId?: string;
  readonly expectedAgentId?: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Deferred<string>;
  readonly closed: Deferred<void>;
  readonly pendingBeforeInit: Readonly<Record<string, unknown>>[];
  readonly startedTools: Map<string, string>;
  readonly completedTools: Set<string>;
  currentTurn: CopilotTurn;
  stdoutBuffer: string;
  /** Non-JSON stdout lines, kept as diagnostics (Copilot prints some startup errors this way). */
  diagnostics: string;
  stderr: string;
  exited: boolean;
  initTimer?: NodeJS.Timeout;
}

/** One-turn-per-process Copilot CLI adapter; `send_message` resumes with `--resume`. */
export class CopilotAdapter implements BackendAdapter {
  readonly backend = "copilot" as const;
  /** Print mode has no approval-response channel; a deny `message` never reaches the child. */
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly #options: Required<Pick<CopilotAdapterOptions,
    "executable" | "initTimeoutMs" | "interruptGraceMs" | "stderrLimitBytes" | "exitWaitMs">> & CopilotAdapterOptions;
  readonly #sessions = new Map<string, CopilotSession>();
  readonly #launches = new Set<CopilotSession>();
  readonly #spawnProcess: SpawnProcess;

  constructor(options: CopilotAdapterOptions = {}) {
    this.#options = {
      ...options,
      executable: options.executable ?? "copilot",
      initTimeoutMs: positiveInteger(options.initTimeoutMs, "initTimeoutMs", DEFAULT_INIT_TIMEOUT_MS),
      interruptGraceMs: positiveInteger(options.interruptGraceMs, "interruptGraceMs", DEFAULT_INTERRUPT_GRACE_MS),
      stderrLimitBytes: positiveInteger(options.stderrLimitBytes, "stderrLimitBytes", DEFAULT_STDERR_LIMIT_BYTES),
      exitWaitMs: positiveInteger(options.exitWaitMs, "exitWaitMs", DEFAULT_EXIT_WAIT_MS),
    };
    this.buffer = options.buffer ?? new EventBuffer();
    this.#spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    validateRequest(request);
    const turnId = randomUUID();
    const prompt = request.systemPrompt.trim() === ""
      ? request.prompt
      : `${request.systemPrompt.trim()}\n\n---\n\n${request.prompt}`;
    const session = this.#launch({ ...request, prompt }, turnId);
    const agentId = await session.ready.promise;
    if (request.timeoutMs !== undefined) this.#armTimeout(session, request.timeoutMs);
    return { agentId, turnId, backend: this.backend };
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validateRequest(request);
    const existing = this.#sessions.get(request.agentId);
    if (existing && !existing.exited) {
      if (!existing.currentTurn.terminal) {
        throw new CopilotAdapterError(`Copilot session ${request.agentId} already has an active turn`, { agentId: request.agentId });
      }
      // The finished turn's process is still saving the session; Copilot refuses a resume until it exits.
      await this.#awaitExit(existing);
    }
    const turnId = randomUUID();
    const session = this.#launch(request, turnId, request.agentId);
    const actualId = await session.ready.promise;
    if (actualId !== request.agentId) {
      this.#terminate(session);
      throw new CopilotAdapterError("Copilot resumed with a different session ID", {
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
    throw new CopilotAdapterError(
      `Copilot print mode does not expose approval ${resolution.requestId} to the host`,
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

  async #awaitExit(session: CopilotSession): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      session.closed.promise.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), this.#options.exitWaitMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!timedOut) return;
    this.#terminate(session);
    await Promise.race([
      session.closed.promise,
      new Promise<void>((resolve) => setTimeout(resolve, this.#options.interruptGraceMs).unref()),
    ]);
  }

  #launch(
    request: Pick<SpawnRequest, "prompt" | "model" | "cwd" | "permission" | "env" | "reasoningEffort">,
    turnId: string,
    expectedAgentId?: string,
  ): CopilotSession {
    const child = this.#spawnProcess(this.#options.executable, [
      ...(this.#options.executableArgs ?? []),
      ...buildCopilotArguments(request, expectedAgentId),
    ], {
      cwd: request.cwd,
      env: { ...process.env, ...this.#options.env, ...request.env },
      shell: false,
      windowsHide: true,
      // Own process group so stop_agent/timeout can reap the whole tree (`copilot` spawns shells).
      detached: true,
    });
    const session: CopilotSession = {
      ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
      child,
      ready: deferred<string>(),
      closed: deferred<void>(),
      pendingBeforeInit: [],
      startedTools: new Map(),
      completedTools: new Set(),
      currentTurn: newTurn(turnId),
      stdoutBuffer: "",
      diagnostics: "",
      stderr: "",
      exited: false,
    };
    this.#launches.add(session);
    session.initTimer = setTimeout(() => {
      const error = new CopilotAdapterError(`Copilot did not start a session within ${this.#options.initTimeoutMs}ms`, {
        stderr: scanChildOutput(session.stderr),
        diagnostics: scanChildOutput(session.diagnostics),
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
    // `close`, not `exit`: stdout must be drained (and its trailing line parsed) first.
    child.on("close", (code, signal) => this.#onClose(session, code, signal));
    return session;
  }

  #onStdout(session: CopilotSession, chunk: string): void {
    session.stdoutBuffer += chunk;
    let newline = session.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = session.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
      this.#handleLine(session, line);
      newline = session.stdoutBuffer.indexOf("\n");
    }
  }

  #handleLine(session: CopilotSession, line: string): void {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Copilot prints some errors as plain text on stdout; keep them for the failure report.
      session.diagnostics = boundedAppend(session.diagnostics, `${line}\n`, this.#options.stderrLimitBytes);
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      this.#protocolFailure(session, "Copilot stdout message lacks a type discriminator");
      return;
    }
    this.#onMessage(session, message);
  }

  #onMessage(session: CopilotSession, message: Readonly<Record<string, unknown>>): void {
    const data = isRecord(message.data) ? message.data : {};
    if (message.type === "session.start") {
      this.#onInit(session, data.sessionId);
      return;
    }
    if (message.type === "session.resume") {
      // The resume record has no id field; the session is the one this process was asked to resume.
      this.#onInit(session, session.expectedAgentId);
      return;
    }
    if (!session.agentId) {
      if (message.type === "result") {
        // A startup failure can skip session.start entirely; the result still names the session.
        this.#onInit(session, message.sessionId);
        if (session.agentId) this.#onMessage(session, message);
        return;
      }
      session.pendingBeforeInit.push(message);
      return;
    }
    switch (message.type) {
      case "assistant.message":
        this.#onAssistantMessage(session, data);
        break;
      case "tool.execution_start":
        this.#onToolStart(session, data);
        break;
      case "tool.execution_complete":
        this.#onToolComplete(session, data);
        break;
      case "session.error":
        this.#onSessionError(session, data);
        break;
      case "result":
        this.#onResult(session, message);
        break;
      default:
        break; // Deltas, telemetry, MCP status and usage checkpoints carry nothing the parent needs.
    }
  }

  #onInit(session: CopilotSession, sessionId: unknown): void {
    if (typeof sessionId !== "string" || sessionId === "") {
      this.#protocolFailure(session, "Copilot session record lacks a sessionId");
      return;
    }
    if (session.agentId) {
      if (session.agentId !== sessionId) {
        this.#protocolFailure(session, "Copilot changed sessionId during a live process", {
          expected: session.agentId,
          actual: sessionId,
        });
      }
      return;
    }
    if (session.expectedAgentId !== undefined && session.expectedAgentId !== sessionId) {
      this.#protocolFailure(session, "Copilot resumed with an unexpected sessionId", {
        expected: session.expectedAgentId,
        actual: sessionId,
      });
      return;
    }
    const collision = this.#sessions.get(sessionId);
    // A finished turn's process can still be exiting when its resume starts; only a live turn collides.
    if (collision && collision !== session && !collision.exited && !collision.currentTurn.terminal) {
      this.#protocolFailure(session, `Copilot session ${sessionId} is already owned by another process`);
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
    const queued = session.pendingBeforeInit.splice(0);
    for (const queuedMessage of queued) this.#onMessage(session, queuedMessage);
  }

  #onAssistantMessage(session: CopilotSession, data: Readonly<Record<string, unknown>>): void {
    if (typeof data.content !== "string" || data.content === "") return;
    const text = scanChildOutput(data.content);
    session.currentTurn.finalText = text;
    this.#emit(session, "message.delta", { text });
  }

  #onToolStart(session: CopilotSession, data: Readonly<Record<string, unknown>>): void {
    const callId = toolCallId(session, data);
    if (session.startedTools.has(callId)) return;
    const toolName = typeof data.toolName === "string" && data.toolName !== "" ? data.toolName : "tool";
    session.startedTools.set(callId, toolName);
    this.#emit(session, "tool.start", {
      toolCallId: callId,
      toolName,
      input: isRecord(data.arguments) ? data.arguments : {},
    });
  }

  #onToolComplete(session: CopilotSession, data: Readonly<Record<string, unknown>>): void {
    const callId = toolCallId(session, data);
    if (session.completedTools.has(callId)) return;
    if (!session.startedTools.has(callId)) this.#onToolStart(session, data);
    session.completedTools.add(callId);
    const error = isRecord(data.error) ? data.error : undefined;
    const status = data.success === true ? "completed" : error?.code === "denied" ? "denied" : "failed";
    const output = data.success === true ? data.result : error ?? data.result;
    this.#emit(session, "tool.end", {
      toolCallId: callId,
      toolName: session.startedTools.get(callId) ?? "tool",
      status,
      ...(output === undefined ? {} : { output }),
    });
  }

  #onSessionError(session: CopilotSession, data: Readonly<Record<string, unknown>>): void {
    const message = typeof data.message === "string" && data.message !== "" ? data.message : "Copilot reported an error";
    session.currentTurn.errorMessage = message;
    this.#emit(session, "error", {
      code: "COPILOT_SESSION_ERROR",
      message: scanChildOutput(message),
      fatal: false,
      ...(typeof data.errorType === "string" ? { details: { errorType: data.errorType } } : {}),
    });
  }

  #onResult(session: CopilotSession, message: Readonly<Record<string, unknown>>): void {
    const turn = session.currentTurn;
    if (turn.terminal) return;
    if (typeof message.sessionId === "string" && message.sessionId !== session.agentId) {
      this.#protocolFailure(session, "Copilot result sessionId does not match the session", {
        expected: session.agentId,
        actual: message.sessionId,
      });
      return;
    }
    const exitCode = typeof message.exitCode === "number" ? message.exitCode : 0;
    const failed = exitCode !== 0 || turn.errorMessage !== undefined;
    let failureText = turn.errorMessage === undefined ? undefined : scanChildOutput(turn.errorMessage);
    if (failed && failureText === undefined && !turn.interruptRequested && !turn.timedOut) {
      // Startup errors land on stdout as plain text or on stderr, depending on the error.
      const detail = session.diagnostics.trim() || session.stderr.trim();
      failureText = scanChildOutput(detail !== "" ? detail : `Copilot turn exited with code ${exitCode}`);
      this.#emit(session, "error", {
        code: "COPILOT_TURN_FAILED",
        message: failureText,
        fatal: false,
        details: { exitCode, sessionId: session.agentId },
      });
    }
    const status = turn.timedOut ? "failed"
      : turn.interruptRequested ? "interrupted"
      : failed ? "failed"
      : "completed";
    // A failed turn with no assistant text reports why it failed, so the parent never gets an empty result.
    this.#completeTurn(session, status, turn.finalText ?? (status === "failed" ? failureText : undefined));
  }

  #armTimeout(session: CopilotSession, timeoutMs: number): void {
    const turn = session.currentTurn;
    if (turn.terminal) return;
    turn.timeout = setTimeout(() => {
      if (turn.terminal) return;
      turn.timedOut = true;
      this.#emit(session, "error", {
        code: "COPILOT_TURN_TIMEOUT",
        message: `Copilot turn exceeded ${timeoutMs}ms`,
        fatal: true,
        details: { turnId: turn.id },
      });
      void this.#interruptSession(session).catch(() => this.#terminate(session));
    }, timeoutMs);
    turn.timeout.unref();
  }

  #interruptSession(session: CopilotSession): Promise<void> {
    const turn = session.currentTurn;
    if (turn.terminal) return Promise.resolve();
    if (turn.interruptPromise) return turn.interruptPromise;
    turn.interruptRequested = true;
    turn.interruptPromise = (async () => {
      signalProcessGroup(session.child, "SIGTERM");
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
        signalProcessGroup(session.child, "SIGKILL");
        this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
      }
    })();
    return turn.interruptPromise;
  }

  #completeTurn(
    session: CopilotSession,
    status: NormalizedEventData["turn.completed"]["status"],
    finalText?: string,
  ): void {
    const turn = session.currentTurn;
    if (turn.terminal) return;
    turn.terminal = true;
    if (turn.timeout) clearTimeout(turn.timeout);
    this.#emit(session, "turn.completed", {
      turnId: turn.id,
      status,
      ...(finalText === undefined ? {} : { finalText }),
    });
  }

  #onProcessError(session: CopilotSession, error: Error): void {
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(new CopilotAdapterError(`Failed to start Copilot: ${error.message}`, {
        executable: this.#options.executable,
      }));
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", {
        code: "COPILOT_PROCESS_ERROR",
        message: scanChildOutput(error.message),
        fatal: true,
      });
      this.#completeTurn(session, "failed");
    }
  }

  #onClose(session: CopilotSession, code: number | null, signal: NodeJS.Signals | null): void {
    session.exited = true;
    if (!session.closed.settled) {
      session.closed.settled = true;
      session.closed.resolve();
    }
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.stdoutBuffer.trim() !== "" && !session.currentTurn.terminal) {
      const trailing = session.stdoutBuffer;
      session.stdoutBuffer = "";
      this.#handleLine(session, trailing);
    }
    if (!session.agentId) {
      if (!session.ready.settled) {
        session.ready.settled = true;
        session.ready.reject(new CopilotAdapterError("Copilot exited before starting a session", {
          code,
          signal,
          stderr: scanChildOutput(session.stderr),
          diagnostics: scanChildOutput(session.diagnostics),
        }));
      }
      return;
    }
    const turn = session.currentTurn;
    if (turn.terminal) return;
    if (turn.interruptRequested) {
      this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
      return;
    }
    this.#emit(session, "error", {
      code: "COPILOT_PROCESS_EXIT",
      message: "Copilot process exited before the turn completed",
      fatal: true,
      details: {
        code,
        signal,
        stderr: scanChildOutput(session.stderr),
        diagnostics: scanChildOutput(session.diagnostics),
      },
    });
    this.#completeTurn(session, "failed");
  }

  #protocolFailure(session: CopilotSession, message: string, details?: Readonly<Record<string, unknown>>): void {
    const error = new CopilotAdapterError(message, details);
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(error);
    }
    if (session.currentTurn.interruptRequested || session.currentTurn.timedOut) {
      this.#completeTurn(session, session.currentTurn.timedOut ? "failed" : "interrupted");
      return;
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", {
        code: "COPILOT_PROTOCOL_ERROR",
        message,
        fatal: true,
        ...(details === undefined ? {} : { details }),
      });
      this.#completeTurn(session, "failed");
    }
    this.#terminate(session);
  }

  #emit<T extends NormalizedEventType>(session: CopilotSession, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    if (!session.agentId) throw new CopilotAdapterError(`Cannot emit ${type} before the Copilot session starts`);
    return this.buffer.append({
      type,
      agentId: session.agentId,
      backend: this.backend,
      data,
    } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #requireSession(agentId: string): CopilotSession {
    const session = this.#sessions.get(agentId);
    if (!session) throw new CopilotAdapterError(`Unknown Copilot session ${agentId}`, { agentId });
    return session;
  }

  #terminate(session: CopilotSession): void {
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.currentTurn.timeout) clearTimeout(session.currentTurn.timeout);
    signalProcessGroup(session.child, "SIGTERM");
  }
}

export function buildCopilotArguments(
  request: Pick<SpawnRequest, "prompt" | "model" | "cwd" | "permission" | "reasoningEffort">,
  resumeId?: string,
): string[] {
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new CopilotAdapterError("Copilot requires an explicit model");
  }
  if (typeof request.cwd !== "string" || request.cwd.trim() === "") {
    throw new CopilotAdapterError("Copilot requires a cwd");
  }
  validatePermission(request.permission);
  const args = [
    "--output-format", "json",
    "--no-auto-update",
    "--no-ask-user",
    "--model", request.model,
  ];
  if (request.reasoningEffort !== undefined) args.push("--reasoning-effort", request.reasoningEffort);
  if (resumeId !== undefined) args.push("--resume", resumeId);
  if (request.permission.default === "allow") {
    args.push("--allow-all-tools");
  } else {
    for (const rule of translateRules(request.permission.allow)) args.push("--allow-tool", rule);
  }
  for (const rule of translateRules(request.permission.deny)) args.push("--deny-tool", rule);
  // `=` form so a prompt that starts with `-` is never parsed as a flag.
  args.push(`--prompt=${request.prompt}`);
  return args;
}

const NATIVE_RULE = /^(shell|write|read|url|memory)(\(.*\))?$/;
const CLAUDE_RULE = /^(Bash|Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit)(?:\((.*)\))?$/;

/** Translate config permission rules to Copilot `kind(argument)` patterns; drop what has no equivalent. */
export function translateRules(rules: readonly string[]): string[] {
  const translated: string[] = [];
  for (const rule of rules) {
    const result = translateRule(rule.trim());
    if (result !== undefined && !translated.includes(result)) translated.push(result);
  }
  return translated;
}

function translateRule(rule: string): string | undefined {
  if (NATIVE_RULE.test(rule)) return rule;
  const match = CLAUDE_RULE.exec(rule);
  if (!match) return undefined;
  const [, tool, argument] = match;
  const arg = argument === undefined || argument === "" || argument === "*" ? undefined : argument;
  switch (tool) {
    case "Bash":
      // Claude's `git *:*` and `git:*` both mean "git and anything after it"; Copilot spells it `git:*`.
      return arg === undefined ? "shell" : `shell(${arg.replace(/\s+\*:\*$/, ":*")})`;
    case "Read":
    case "Grep":
    case "Glob":
      return arg === undefined ? "read" : `read(${arg})`;
    default:
      return arg === undefined ? "write" : `write(${arg})`;
  }
}

function toolCallId(session: CopilotSession, data: Readonly<Record<string, unknown>>): string {
  return typeof data.toolCallId === "string" && data.toolCallId !== ""
    ? data.toolCallId
    : `${session.currentTurn.id}-tool-${session.startedTools.size}`;
}

function validateRequest(request: Pick<SpawnRequest, "prompt" | "model" | "cwd" | "permission" | "reasoningEffort">): void {
  buildCopilotArguments(request);
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw new CopilotAdapterError("Copilot requires a non-empty prompt");
  }
}

function validatePermission(permission: PermissionConfig): void {
  if (!permission || !Array.isArray(permission.allow) || !Array.isArray(permission.deny)) {
    throw new CopilotAdapterError("Copilot requires resolved permission rules");
  }
}

function newTurn(id: string): CopilotTurn {
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
  return `[output truncated]\n${bytes.subarray(Math.max(0, bytes.length - limit)).toString("utf8")}`;
}
