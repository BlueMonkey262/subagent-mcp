import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import { signalProcessGroup } from "../../process-group.js";
import { once } from "node:events";

import type { ApprovalResolution } from "../../approval/types.js";
import { SubagentError } from "../../core/errors.js";
import type { Usage } from "../../core/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ResumeRequest, SpawnRequest } from "../adapter.js";

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERRUPT_GRACE_MS = 2_000;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;
const ANTIGRAVITY_EFFORT_LEVELS = ["low", "medium", "high"] as const;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface AntigravityAdapterOptions {
  readonly executable?: string;
  /** Fixed argv before Antigravity flags. Intended for wrapped binaries and process fixtures. */
  readonly executableArgs?: readonly string[];
  readonly initTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly stderrLimitBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  readonly spawnProcess?: SpawnProcess;
}

export class AntigravityAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "ANTIGRAVITY_ADAPTER_ERROR", details);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
}

interface AntigravityTurn {
  readonly id: string;
  terminal: boolean;
  interruptRequested: boolean;
  timedOut: boolean;
  timeout?: NodeJS.Timeout;
  interruptPromise?: Promise<void>;
}

interface AntigravitySession {
  agentId?: string;
  readonly expectedAgentId?: string;
  readonly requestModel: string;
  readonly agentName: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly maxTurns?: number;
  turnCount: number;
  currentTurn: AntigravityTurn;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Deferred<string>;
  readonly startedTools: Set<string>;
  readonly completedTools: Set<string>;
  stdoutBuffer: string;
  stderr: string;
  writeChain: Promise<void>;
  exited: boolean;
  /** Set when stop/timeout signals the process group. `process.kill(-pid)` does not set `child.killed`. */
  terminated: boolean;
  initTimer?: NodeJS.Timeout;
}

/**
 * Persistent Antigravity CLI adapter. `agy` owns conversation persistence; this adapter retains
 * one stream-json process while it is warm and starts a new one with `--conversation` on a cold
 * resume. Headless Antigravity has no host approval-response protocol, so native CLI policy
 * determines whether tool calls run or are soft-denied.
 */
export class AntigravityAdapter implements BackendAdapter {
  readonly backend = "antigravity" as const;
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly #options: Required<Pick<AntigravityAdapterOptions,
    "executable" | "initTimeoutMs" | "interruptGraceMs" | "stderrLimitBytes">> & AntigravityAdapterOptions;
  readonly #sessions = new Map<string, AntigravitySession>();
  readonly #launches = new Set<AntigravitySession>();
  readonly #spawnProcess: SpawnProcess;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.#options = {
      ...options,
      executable: options.executable ?? "agy",
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
    await this.#sendUserTurn(session, request.prompt, turnId, request.timeoutMs);
    return { agentId, turnId, backend: this.backend };
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validateRequest(request);
    const existing = this.#sessions.get(request.agentId);
    if (existing && !existing.exited && !existing.terminated && !existing.child.killed) {
      this.#assertIdentity(existing, request);
      if (!existing.currentTurn.terminal) {
        throw new AntigravityAdapterError(`Antigravity conversation ${request.agentId} already has an active turn`, { agentId: request.agentId });
      }
      if (existing.maxTurns !== undefined && existing.turnCount >= existing.maxTurns) {
        throw new AntigravityAdapterError(`Antigravity conversation ${request.agentId} reached maxTurns ${existing.maxTurns}`, { agentId: request.agentId });
      }
      const turnId = randomUUID();
      existing.turnCount += 1;
      existing.currentTurn = newTurn(turnId);
      this.#emit(existing, "thread.started", { threadId: request.agentId, turnId });
      await this.#sendUserTurn(existing, request.prompt, turnId, request.timeoutMs);
      return { agentId: request.agentId, turnId, backend: this.backend };
    }

    const turnId = randomUUID();
    const session = this.#launch({
      model: request.model,
      ...(request.antigravityAgent === undefined ? {} : { antigravityAgent: request.antigravityAgent }),
      cwd: request.cwd,
      env: request.env,
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    }, turnId, request.agentId);
    const actualId = await session.ready.promise;
    if (actualId !== request.agentId) {
      this.#terminate(session);
      throw new AntigravityAdapterError("Antigravity resumed with a different conversation ID", {
        expected: request.agentId,
        actual: actualId,
      });
    }
    await this.#sendUserTurn(session, request.prompt, turnId, request.timeoutMs);
    return { agentId: actualId, turnId, backend: this.backend };
  }

  async interrupt(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    const turn = session.currentTurn;
    if (turn.terminal) return;
    if (turn.interruptPromise) return turn.interruptPromise;
    turn.interruptRequested = true;
    turn.interruptPromise = (async () => {
      if (!session.exited) signalProcessGroup(session.child, "SIGINT");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#options.interruptGraceMs);
        const check = setInterval(() => {
          if (turn.terminal) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 20);
      });
      if (!turn.terminal) {
        this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
        this.#terminate(session);
      }
    })();
    return turn.interruptPromise;
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  async approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    this.#requireSession(agentId);
    throw new AntigravityAdapterError(
      `Antigravity headless mode does not expose approval ${resolution.requestId} to the host`,
      { agentId, requestId: resolution.requestId },
    );
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

  #launch(request: Pick<SpawnRequest, "cwd" | "model" | "antigravityAgent" | "env" | "maxTurns" | "reasoningEffort" | "timeoutMs">, turnId: string, expectedAgentId?: string): AntigravitySession {
    const child = this.#spawnProcess(this.#options.executable, [
      ...(this.#options.executableArgs ?? []),
      ...buildAntigravityArguments(request, expectedAgentId),
    ], {
      cwd: request.cwd,
      env: { ...process.env, ...this.#options.env, ...request.env },
      shell: false,
      windowsHide: true,
      // Own process group so stop and timeout can reap shells the CLI spawned.
      detached: true,
    });
    const session: AntigravitySession = {
      ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
      requestModel: request.model,
      agentName: requireAgentName(request.antigravityAgent),
      cwd: request.cwd,
      env: request.env,
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      turnCount: 1,
      currentTurn: newTurn(turnId),
      child,
      ready: deferred<string>(),
      startedTools: new Set(),
      completedTools: new Set(),
      stdoutBuffer: "",
      stderr: "",
      writeChain: Promise.resolve(),
      exited: false,
      terminated: false,
    };
    this.#launches.add(session);
    session.initTimer = setTimeout(() => {
      const error = new AntigravityAdapterError(`Antigravity did not emit init within ${this.#options.initTimeoutMs}ms`, {
        stderr: scanChildOutput(session.stderr),
      });
      if (!session.ready.settled) {
        session.ready.settled = true;
        session.ready.reject(error);
      }
      this.#terminate(session);
    }, this.#options.initTimeoutMs);
    session.initTimer.unref();
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

  #onStdout(session: AntigravitySession, chunk: string): void {
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
          this.#protocolFailure(session, "Malformed JSON on Antigravity stdout", {
            lineLength: line.length,
            parseError: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (!isRecord(message) || typeof message.event !== "string") {
          this.#protocolFailure(session, "Antigravity stdout message lacks an event discriminator");
          return;
        }
        this.#onMessage(session, message);
      }
      newline = session.stdoutBuffer.indexOf("\n");
    }
  }

  #onMessage(session: AntigravitySession, message: Readonly<Record<string, unknown>>): void {
    switch (message.event) {
      case "init":
        this.#onInit(session, message);
        break;
      case "step_update":
        if (!session.agentId) {
          this.#protocolFailure(session, "Antigravity emitted a step before init");
          return;
        }
        this.#onStepUpdate(session, message);
        break;
      case "result":
        if (!session.agentId) {
          this.#protocolFailure(session, "Antigravity emitted a result before init");
          return;
        }
        this.#onResult(session, message);
        break;
      default:
        // New informational event types should not break a session that otherwise remains valid.
        break;
    }
  }

  #onInit(session: AntigravitySession, message: Readonly<Record<string, unknown>>): void {
    const conversationId = message.conversation_id;
    if (typeof conversationId !== "string" || conversationId === "") {
      this.#protocolFailure(session, "Antigravity init lacks conversation_id");
      return;
    }
    if (session.expectedAgentId !== undefined && session.expectedAgentId !== conversationId) {
      this.#protocolFailure(session, "Antigravity resumed with an unexpected conversation_id", {
        expected: session.expectedAgentId,
        actual: conversationId,
      });
      return;
    }
    const collision = this.#sessions.get(conversationId);
    if (collision && collision !== session && !collision.exited && !collision.terminated && !collision.child.killed) {
      this.#protocolFailure(session, `Antigravity conversation ${conversationId} is already owned by another process`);
      return;
    }
    session.agentId = conversationId;
    this.#sessions.set(conversationId, session);
    this.#launches.delete(session);
    if (session.initTimer) clearTimeout(session.initTimer);
    this.#emit(session, "thread.started", { threadId: conversationId, turnId: session.currentTurn.id });
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.resolve(conversationId);
    }
  }

  #onStepUpdate(session: AntigravitySession, message: Readonly<Record<string, unknown>>): void {
    const step = isRecord(message.step_update) ? message.step_update : undefined;
    if (!step) {
      this.#protocolFailure(session, "Antigravity step_update lacks step_update payload");
      return;
    }
    if (typeof step.text_delta === "string" && step.text_delta !== "") {
      this.#emit(session, "message.delta", { text: scanChildOutput(step.text_delta) });
    }
    if (step.step_type !== "tool") return;
    const index = typeof step.step_index === "number" ? step.step_index : undefined;
    const toolCallId = index === undefined ? `tool-${session.currentTurn.id}-${session.startedTools.size}` : `tool-${session.currentTurn.id}-${index}`;
    const toolInfo = isRecord(step.tool_info) ? step.tool_info : {};
    const toolName = typeof step.tool_name === "string"
      ? step.tool_name
      : typeof toolInfo.name === "string" ? toolInfo.name : "tool";
    if (!session.startedTools.has(toolCallId)) {
      session.startedTools.add(toolCallId);
      this.#emit(session, "tool.start", {
        toolCallId,
        toolName,
        input: isRecord(toolInfo.parameters) ? toolInfo.parameters : {},
      });
    }
    // A tool step ends in DONE, or in ERROR when it failed or headless mode denied it.
    if ((step.state !== "DONE" && step.state !== "ERROR") || session.completedTools.has(toolCallId)) return;
    session.completedTools.add(toolCallId);
    const error = isRecord(toolInfo.error) ? toolInfo.error : undefined;
    const status = error === undefined && step.state === "DONE" ? "completed"
      : isPermissionDenial(error) ? "denied" : "failed";
    const output = toolInfo.output ?? error;
    this.#emit(session, "tool.end", {
      toolCallId,
      toolName,
      status,
      ...(output === undefined ? {} : { output }),
    });
  }

  #onResult(session: AntigravitySession, message: Readonly<Record<string, unknown>>): void {
    if (session.currentTurn.terminal) return;
    const result = isRecord(message.result) ? message.result : undefined;
    if (!result) {
      this.#protocolFailure(session, "Antigravity result lacks result payload");
      return;
    }
    const status = typeof result.status === "string" ? result.status : "ERROR";
    const normalized = status === "SUCCESS" ? "completed"
      : status === "CANCELED" || status === "INTERRUPTED" ? "interrupted" : "failed";
    if (normalized === "failed") {
      this.#emit(session, "error", {
        code: `ANTIGRAVITY_${status}`,
        message: scanChildOutput(typeof result.error === "string" && result.error !== "" ? result.error : `Antigravity turn ended with ${status}`),
        fatal: false,
      });
    }
    const response = typeof result.response === "string" ? scanChildOutput(result.response) : undefined;
    // Headless agy auto-denies actions no permissions.allow rule covers. The result still says
    // SUCCESS, often with an empty response, so name the denied actions instead of returning nothing.
    const denied = deniedActions(result);
    let outcome: "completed" | "interrupted" | "failed" = normalized;
    let finalText = response;
    if (denied.length > 0) {
      const message = deniedActionsMessage(denied);
      this.#emit(session, "error", {
        code: "ANTIGRAVITY_PERMISSION_DENIED",
        message,
        fatal: false,
        details: { deniedActions: denied },
      });
      if (response === undefined || response.trim() === "") {
        finalText = message;
        if (outcome === "completed") outcome = "failed";
      }
    }
    this.#completeTurn(
      session,
      session.currentTurn.timedOut ? "failed" : session.currentTurn.interruptRequested ? "interrupted" : outcome,
      finalText,
      extractUsage(result),
    );
  }

  async #sendUserTurn(session: AntigravitySession, prompt: string, turnId: string, timeoutMs?: number): Promise<void> {
    await this.#write(session, { event: "user", message: { content: prompt } });
    if (timeoutMs !== undefined) {
      session.currentTurn.timeout = setTimeout(() => {
        if (session.currentTurn.id !== turnId || session.currentTurn.terminal) return;
        session.currentTurn.timedOut = true;
        this.#emit(session, "error", {
          code: "ANTIGRAVITY_TURN_TIMEOUT",
          message: `Antigravity turn exceeded ${timeoutMs}ms`,
          fatal: true,
          details: { turnId },
        });
        session.terminated = true;
        signalProcessGroup(session.child, "SIGTERM");
        void this.interrupt(session.agentId ?? session.expectedAgentId ?? "").catch(() => this.#terminate(session));
      }, timeoutMs);
      session.currentTurn.timeout.unref();
    }
  }

  #completeTurn(session: AntigravitySession, status: "completed" | "interrupted" | "failed", finalText?: string, usage?: Usage): void {
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

  #write(session: AntigravitySession, value: Readonly<Record<string, unknown>>): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    const operation = session.writeChain.then(async () => {
      if (session.exited || session.child.stdin.destroyed || !session.child.stdin.writable) {
        throw new AntigravityAdapterError("Antigravity stdin is not writable", { agentId: session.agentId ?? session.expectedAgentId });
      }
      if (!session.child.stdin.write(line, "utf8")) await once(session.child.stdin, "drain");
    });
    session.writeChain = operation.catch(() => undefined);
    return operation;
  }

  #onProcessError(session: AntigravitySession, error: Error): void {
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(new AntigravityAdapterError(`Failed to start Antigravity: ${error.message}`, { executable: this.#options.executable }));
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", { code: "ANTIGRAVITY_PROCESS_ERROR", message: scanChildOutput(error.message), fatal: true });
      this.#completeTurn(session, session.currentTurn.interruptRequested ? "interrupted" : "failed");
    }
  }

  #onExit(session: AntigravitySession, code: number | null, signal: NodeJS.Signals | null): void {
    session.exited = true;
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.stdoutBuffer.trim() !== "" && !session.currentTurn.terminal) {
      this.#protocolFailure(session, "Antigravity stdout ended with an incomplete NDJSON line", { trailingBytes: Buffer.byteLength(session.stdoutBuffer) });
      return;
    }
    const error = new AntigravityAdapterError("Antigravity process exited before the active turn completed", {
      code,
      signal,
      stderr: scanChildOutput(session.stderr),
    });
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(error);
    }
    if (session.agentId && !session.currentTurn.terminal) {
      const deliberate = session.currentTurn.timedOut || session.currentTurn.interruptRequested;
      if (!deliberate) {
        this.#emit(session, "error", {
          code: "ANTIGRAVITY_PROCESS_EXIT",
          message: error.message,
          fatal: true,
          details: { code, signal, stderr: scanChildOutput(session.stderr) },
        });
      }
      this.#completeTurn(
        session,
        session.currentTurn.timedOut ? "failed" : session.currentTurn.interruptRequested ? "interrupted" : "failed",
      );
    }
  }

  #protocolFailure(session: AntigravitySession, message: string, details?: Readonly<Record<string, unknown>>): void {
    const error = new AntigravityAdapterError(message, details);
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(error);
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", { code: "ANTIGRAVITY_PROTOCOL_ERROR", message, fatal: true, ...(details === undefined ? {} : { details }) });
      this.#completeTurn(session, "failed");
    }
    this.#terminate(session);
  }

  #emit<T extends NormalizedEventType>(session: AntigravitySession, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    if (!session.agentId) throw new AntigravityAdapterError(`Cannot emit ${type} before Antigravity initialization`);
    return this.buffer.append({
      type,
      agentId: session.agentId,
      backend: this.backend,
      data,
    } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #assertIdentity(session: AntigravitySession, request: ResumeRequest): void {
    if (session.requestModel !== request.model
      || session.agentName !== requireAgentName(request.antigravityAgent)
      || session.cwd !== request.cwd
      || !sameJson(session.env, request.env)
      || session.maxTurns !== request.maxTurns) {
      throw new AntigravityAdapterError("Antigravity resume cannot change model, custom agent, cwd, or execution config", {
        agentId: request.agentId,
        expectedModel: session.requestModel,
        requestedModel: request.model,
        expectedAgent: session.agentName,
        requestedAgent: request.antigravityAgent,
      });
    }
  }

  #requireSession(agentId: string): AntigravitySession {
    const session = this.#sessions.get(agentId);
    if (!session) throw new AntigravityAdapterError(`Unknown Antigravity conversation ${agentId}`, { agentId });
    return session;
  }

  #terminate(session: AntigravitySession): void {
    session.terminated = true;
    signalProcessGroup(session.child, "SIGTERM");
  }
}

export function buildAntigravityArguments(
  request: Pick<SpawnRequest, "model" | "antigravityAgent" | "reasoningEffort" | "timeoutMs">,
  resumeId?: string,
): string[] {
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new AntigravityAdapterError("Antigravity requires an explicit model");
  }
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", request.model,
    "--agent", requireAgentName(request.antigravityAgent),
  ];
  if (request.reasoningEffort !== undefined) {
    if (!(ANTIGRAVITY_EFFORT_LEVELS as readonly string[]).includes(request.reasoningEffort)) {
      throw new AntigravityAdapterError(`Antigravity effort must be one of ${ANTIGRAVITY_EFFORT_LEVELS.join(", ")}; got "${request.reasoningEffort}"`);
    }
    args.push("--effort", request.reasoningEffort);
  }
  if (resumeId !== undefined) args.push("--conversation", resumeId);
  if (request.timeoutMs !== undefined) args.push("--print-timeout", `${Math.ceil(request.timeoutMs / 1000)}s`);
  return args;
}

function validateRequest(request: Pick<SpawnRequest, "model" | "cwd" | "antigravityAgent" | "maxTurns" | "timeoutMs" | "reasoningEffort">): void {
  buildAntigravityArguments(request);
  if (typeof request.cwd !== "string" || request.cwd.trim() === "") throw new AntigravityAdapterError("Antigravity requires a cwd");
  if (request.maxTurns !== undefined) positiveInteger(request.maxTurns, "maxTurns", 1);
  if (request.timeoutMs !== undefined) positiveInteger(request.timeoutMs, "timeoutMs", 1);
}

function requireAgentName(value: string | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AntigravityAdapterError("Antigravity requires a configured antigravityAgent custom-agent name");
  }
  return value;
}

function newTurn(id: string): AntigravityTurn {
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

/** agy reports a headless permission denial as a TOOL_ERROR whose message says so. */
function isPermissionDenial(error: Readonly<Record<string, unknown>> | undefined): boolean {
  return typeof error?.message === "string" && /permission check failed|denied permission/i.test(error.message);
}

function deniedActions(result: Readonly<Record<string, unknown>>): { action: string; displayName?: string }[] {
  if (!Array.isArray(result.denied_actions)) return [];
  return result.denied_actions.filter(isRecord).flatMap((entry) => typeof entry.action === "string"
    ? [{ action: entry.action, ...(typeof entry.display_name === "string" ? { displayName: entry.display_name } : {}) }]
    : []);
}

function deniedActionsMessage(denied: readonly { action: string; displayName?: string }[]): string {
  const names = denied.map((entry) => entry.displayName === undefined ? entry.action : `${entry.action} (${entry.displayName})`);
  const rules = [...new Set(denied.map((entry) => `${entry.action}(...)`))].join(", ");
  return `Antigravity headless mode auto-denied: ${names.join(", ")}. Headless runs cannot ask for approval; `
    + `add allow rules such as ${rules} under permissions.allow in ~/.gemini/antigravity-cli/settings.json.`;
}

function extractUsage(result: Readonly<Record<string, unknown>>): Usage | undefined {
  const usage = isRecord(result.usage) ? result.usage : undefined;
  const normalized: Usage = {
    ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage?.cache_read_tokens === "number" ? { cachedInputTokens: usage.cache_read_tokens } : {}),
  };
  return Object.keys(normalized).length === 0 ? undefined : normalized;
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
