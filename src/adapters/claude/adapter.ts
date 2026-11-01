import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import { signalDescendants, signalProcessGroup } from "../../process-group.js";
import { once } from "node:events";

import type { ApprovalResolution } from "../../approval/types.js";
import { CLAUDE_PERMISSION_MODES, DEFAULT_CLAUDE_PERMISSION_MODE, type PermissionConfig } from "../../config/schema.js";
import { SubagentError } from "../../core/errors.js";
import type { Usage } from "../../core/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ResumeRequest, SpawnRequest } from "../adapter.js";

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERRUPT_GRACE_MS = 2_000;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ClaudeAdapterOptions {
  readonly executable?: string;
  /** Fixed argv before Claude flags. Intended for wrapped binaries and process fixtures. */
  readonly executableArgs?: readonly string[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly initTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly stderrLimitBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  readonly spawnProcess?: SpawnProcess;
}

export interface ClaudeDiagnostics {
  readonly sessionId: string;
  readonly pid?: number;
  readonly cliVersion?: string;
  readonly model?: string;
  readonly capabilities: readonly string[];
  readonly stderr: string;
  readonly unknownMessages: readonly Readonly<Record<string, unknown>>[];
  readonly processExited: boolean;
}

interface PendingApproval {
  readonly controlRequestId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface CurrentTurn {
  readonly id: string;
  readonly commandUuid: string;
  terminal: boolean;
  interruptRequested: boolean;
  timedOut: boolean;
  timeout?: NodeJS.Timeout;
  interruptPromise?: Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

interface ClaudeSession {
  agentId?: string;
  readonly expectedAgentId?: string;
  readonly requestModel: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly env: Readonly<Record<string, string>>;
  readonly permission: PermissionConfig;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Deferred<string>;
  readonly pendingBeforeInit: Readonly<Record<string, unknown>>[];
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly completedToolIds: Set<string>;
  readonly controls: Map<string, Deferred<Readonly<Record<string, unknown>>>>;
  readonly unknownMessages: Readonly<Record<string, unknown>>[];
  readonly maxTurns?: number;
  currentTurn: CurrentTurn;
  turnCount: number;
  stdoutBuffer: string;
  stderr: string;
  writeChain: Promise<void>;
  capabilities: string[];
  cliVersion?: string;
  actualModel?: string;
  exited: boolean;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  initTimer?: NodeJS.Timeout;
}

export class ClaudeAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "CLAUDE_ADAPTER_ERROR", details);
  }
}

/**
 * Persistent Claude Code stream-json adapter. One child process is kept per
 * Claude session, and each `result` closes only the current turn.
 */
export class ClaudeAdapter implements BackendAdapter {
  readonly backend = "claude" as const;
  /** Claude's control-response carries a free-text deny reason inline; see approve() below. */
  readonly relaysDenyMessage = true;
  readonly buffer: EventBuffer;
  readonly #options: Required<Pick<ClaudeAdapterOptions,
    "executable" | "initTimeoutMs" | "interruptGraceMs" | "stderrLimitBytes">> & ClaudeAdapterOptions;
  readonly #sessions = new Map<string, ClaudeSession>();
  readonly #launches = new Set<ClaudeSession>();
  readonly #spawnProcess: SpawnProcess;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#options = {
      ...options,
      executable: options.executable ?? "claude",
      initTimeoutMs: positiveInteger(options.initTimeoutMs, "initTimeoutMs", DEFAULT_INIT_TIMEOUT_MS),
      interruptGraceMs: positiveInteger(options.interruptGraceMs, "interruptGraceMs", DEFAULT_INTERRUPT_GRACE_MS),
      stderrLimitBytes: positiveInteger(options.stderrLimitBytes, "stderrLimitBytes", DEFAULT_STDERR_LIMIT_BYTES),
    };
    this.buffer = options.buffer ?? new EventBuffer();
    this.#spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    validateRequest(request.model, request.cwd, request.maxTurns, request.timeoutMs);
    const turnId = randomUUID();
    const session = this.#launch(request, turnId);
    await this.#sendUserTurn(session, request.prompt, turnId, request.timeoutMs);
    const agentId = await session.ready.promise;
    return { agentId, turnId, backend: this.backend };
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validateRequest(request.model, request.cwd, undefined, request.timeoutMs);
    const existing = this.#sessions.get(request.agentId);
    if (existing && !existing.exited) {
      this.#assertIdentity(existing, request);
      if (!existing.currentTurn.terminal) {
        throw new ClaudeAdapterError(`Claude session ${request.agentId} already has an active turn`, {
          agentId: request.agentId,
          turnId: existing.currentTurn.id,
        });
      }
      if (existing.maxTurns !== undefined && existing.turnCount >= existing.maxTurns) {
        throw new ClaudeAdapterError(`Claude session ${request.agentId} reached maxTurns ${existing.maxTurns}`, {
          agentId: request.agentId,
          maxTurns: existing.maxTurns,
        });
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
      prompt: request.prompt,
      description: "Resume Claude session",
      model: request.model,
      cwd: request.cwd,
      systemPrompt: request.systemPrompt,
      env: request.env,
      permission: request.permission,
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    }, turnId, request.agentId);
    await this.#sendUserTurn(session, request.prompt, turnId, request.timeoutMs);
    const actualId = await session.ready.promise;
    if (actualId !== request.agentId) {
      this.#terminate(session);
      throw new ClaudeAdapterError("Claude resumed with a different session ID", {
        expected: request.agentId,
        actual: actualId,
      });
    }
    return { agentId: actualId, turnId, backend: this.backend };
  }

  async interrupt(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    const turn = session.currentTurn;
    if (turn.terminal) return;
    if (turn.interruptPromise) return turn.interruptPromise;
    turn.interruptRequested = true;
    const requestId = `interrupt-${randomUUID()}`;
    const response = deferred<Readonly<Record<string, unknown>>>();
    session.controls.set(requestId, response);
    turn.interruptPromise = (async () => {
      await this.#write(session, {
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt", cancel_queued: true },
      });
      // Reap shells the CLI already spawned. The leader stays up long enough to honor the interrupt.
      signalDescendants(session.child, "SIGTERM");
      const grace = timeoutPromise(this.#options.interruptGraceMs, "Claude interrupt receipt timed out");
      try {
        const receipt = await Promise.race([response.promise, grace.promise]);
        const body = isRecord(receipt.response) ? receipt.response : undefined;
        if (Array.isArray(body?.cancelled) && body.cancelled.includes(turn.commandUuid) && !turn.terminal) {
          this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
        }
      } catch {
        if (!turn.terminal) {
          this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
          this.#terminate(session);
        }
      } finally {
        grace.cancel();
        session.controls.delete(requestId);
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
      throw new ClaudeAdapterError(`No pending Claude approval ${resolution.requestId} for ${agentId}`, {
        agentId,
        requestId: resolution.requestId,
      });
    }
    const decision = resolution.decision === "deny"
      ? {
          behavior: "deny",
          message: resolution.message ?? "Denied by parent",
          interrupt: false,
          toolUseID: pending.toolUseId,
        }
      : {
          behavior: "allow",
          updatedInput: pending.input,
          // Session memory is enforced by ApprovalCoordinator. Never persist a
          // Claude permission update to project or user settings here.
          updatedPermissions: [],
          toolUseID: pending.toolUseId,
        };
    await this.#write(session, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: pending.controlRequestId,
        response: decision,
      },
    });
    session.pendingApprovals.delete(resolution.requestId);
  }

  diagnostics(agentId: string): ClaudeDiagnostics {
    const session = this.#requireSession(agentId);
    return {
      sessionId: agentId,
      ...(session.child.pid === undefined ? {} : { pid: session.child.pid }),
      ...(session.cliVersion === undefined ? {} : { cliVersion: session.cliVersion }),
      ...(session.actualModel === undefined ? {} : { model: session.actualModel }),
      capabilities: [...session.capabilities],
      stderr: scanChildOutput(session.stderr),
      unknownMessages: session.unknownMessages.map((message) => sanitizeUnknown(message) as Readonly<Record<string, unknown>>),
      processExited: session.exited,
    };
  }

  async close(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    if (!session.currentTurn.terminal) await this.interrupt(agentId);
    this.#terminate(session);
    if (!session.exited) await Promise.race([once(session.child, "exit"), delay(1_000)]);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map(async (agentId) => this.close(agentId)));
    for (const launch of this.#launches) this.#terminate(launch);
  }

  #launch(request: SpawnRequest, turnId: string, expectedAgentId?: string): ClaudeSession {
    const args = buildClaudeArguments(request, this.#options, expectedAgentId);
    const child = this.#spawnProcess(this.#options.executable, [
      ...(this.#options.executableArgs ?? []),
      ...args,
    ], {
      cwd: request.cwd,
      env: { ...process.env, ...this.#options.env, ...request.env },
      shell: false,
      windowsHide: true,
      // Own process group so stop and timeout can reap shells the CLI spawned.
      detached: true,
    });
    const session: ClaudeSession = {
      ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
      requestModel: request.model,
      cwd: request.cwd,
      systemPrompt: request.systemPrompt,
      env: request.env,
      permission: request.permission,
      child,
      ready: deferred<string>(),
      pendingBeforeInit: [],
      pendingApprovals: new Map(),
      completedToolIds: new Set(),
      controls: new Map(),
      unknownMessages: [],
      ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
      currentTurn: newTurn(turnId),
      turnCount: 1,
      stdoutBuffer: "",
      stderr: "",
      writeChain: Promise.resolve(),
      capabilities: [],
      exited: false,
    };
    this.#launches.add(session);
    session.initTimer = setTimeout(() => {
      const error = new ClaudeAdapterError(`Claude did not emit system/init within ${this.#options.initTimeoutMs}ms`, {
        stderr: scanChildOutput(session.stderr),
      });
      session.ready.settled = true;
      session.ready.reject(error);
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

  #onStdout(session: ClaudeSession, chunk: string): void {
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
          this.#protocolFailure(session, "Malformed JSON on Claude stdout", {
            lineLength: line.length,
            parseError: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (!isRecord(message) || typeof message.type !== "string") {
          this.#protocolFailure(session, "Claude stdout message lacks a type discriminator");
          return;
        }
        this.#onMessage(session, message);
      }
      newline = session.stdoutBuffer.indexOf("\n");
    }
  }

  #onMessage(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    if (message.type === "system" && message.subtype === "init") {
      this.#onInit(session, message);
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
      case "user":
        this.#onToolResults(session, message);
        break;
      case "control_request":
        this.#onControlRequest(session, message);
        break;
      case "control_cancel_request":
        this.#onControlCancel(session, message);
        break;
      case "control_response":
        this.#onControlResponse(session, message);
        break;
      case "command_lifecycle":
        if (message.state === "cancelled" && !session.currentTurn.terminal) {
          this.#completeTurn(session, "interrupted");
        }
        break;
      case "result":
        this.#onResult(session, message);
        break;
      default:
        boundedPush(session.unknownMessages, message, 100);
    }
  }

  #onInit(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    const sessionId = message.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      this.#protocolFailure(session, "Claude system/init lacks session_id");
      return;
    }
    if (session.agentId && session.agentId !== sessionId) {
      this.#protocolFailure(session, "Claude changed session_id during a live process", {
        expected: session.agentId,
        actual: sessionId,
      });
      return;
    }
    if (session.expectedAgentId && session.expectedAgentId !== sessionId) {
      this.#protocolFailure(session, "Claude resumed with an unexpected session_id", {
        expected: session.expectedAgentId,
        actual: sessionId,
      });
      return;
    }
    session.capabilities = Array.isArray(message.capabilities)
      ? message.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    if (typeof message.claude_code_version === "string") session.cliVersion = message.claude_code_version;
    if (typeof message.model === "string") session.actualModel = message.model;
    if (!session.agentId) {
      const collision = this.#sessions.get(sessionId);
      if (collision && collision !== session && !collision.exited) {
        this.#protocolFailure(session, `Claude session ${sessionId} is already owned by another process`);
        return;
      }
      session.agentId = sessionId;
      this.#sessions.set(sessionId, session);
      this.#launches.delete(session);
      if (session.initTimer) clearTimeout(session.initTimer);
      this.#emit(session, "thread.started", { threadId: sessionId, turnId: session.currentTurn.id });
      session.ready.settled = true;
      session.ready.resolve(sessionId);
      const queued = (session.pendingBeforeInit as Readonly<Record<string, unknown>>[]).splice(0);
      for (const queuedMessage of queued) this.#onMessage(session, queuedMessage);
    }
  }

  #onAssistant(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    const body = isRecord(message.message) ? message.message : undefined;
    const content = body?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        this.#emit(session, "message.delta", { text: scanChildOutput(block.text) });
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        this.#emit(session, "tool.start", {
          toolCallId: block.id,
          toolName: block.name,
          input: isRecord(block.input) ? block.input : {},
        });
      }
    }
  }

  #onToolResults(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    const body = isRecord(message.message) ? message.message : undefined;
    if (!Array.isArray(body?.content)) return;
    for (const block of body.content) {
      if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (session.completedToolIds.has(block.tool_use_id)) continue;
      session.completedToolIds.add(block.tool_use_id);
      this.#emit(session, "tool.end", {
        toolCallId: block.tool_use_id,
        status: block.is_error === true ? "failed" : "completed",
        ...(block.content === undefined ? {} : { output: block.content }),
      });
    }
  }

  #onControlRequest(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    const controlRequestId = message.request_id;
    const request = isRecord(message.request) ? message.request : undefined;
    if (request?.subtype !== "can_use_tool") {
      boundedPush(session.unknownMessages, message, 100);
      return;
    }
    const toolUseId = request.tool_use_id;
    const toolName = request.tool_name;
    if (typeof controlRequestId !== "string" || typeof toolUseId !== "string" || typeof toolName !== "string") {
      this.#protocolFailure(session, "Claude can_use_tool request lacks correlation IDs or tool name");
      return;
    }
    if (session.pendingApprovals.has(controlRequestId)) return;
    const input = isRecord(request.input) ? request.input : {};
    session.pendingApprovals.set(controlRequestId, { controlRequestId, toolUseId, toolName, input });
    const command = typeof input.command === "string" ? input.command : undefined;
    const paths = extractPaths(input);
    const reason = firstString(request.description, request.decision_reason, request.title);
    this.#emit(session, "approval.requested", {
      requestId: controlRequestId,
      agentId: session.agentId!,
      backend: this.backend,
      toolName,
      input,
      cwd: session.cwd,
      ...(command === undefined ? {} : { command }),
      ...(paths.length === 0 ? {} : { paths }),
      ...(reason === undefined ? {} : { reason }),
      requestedAt: new Date().toISOString(),
    });
  }

  #onControlCancel(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    const requestId = firstString(message.request_id, isRecord(message.request) ? message.request.request_id : undefined);
    if (!requestId) return;
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return;
    session.pendingApprovals.delete(requestId);
    if (!session.completedToolIds.has(pending.toolUseId)) {
      session.completedToolIds.add(pending.toolUseId);
      this.#emit(session, "tool.end", {
        toolCallId: pending.toolUseId,
        toolName: pending.toolName,
        status: "cancelled",
      });
    }
  }

  #onControlResponse(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    const response = isRecord(message.response) ? message.response : undefined;
    if (!response) return;
    const requestId = response?.request_id;
    if (typeof requestId !== "string") return;
    const pending = session.controls.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (response?.subtype === "error") {
      pending.reject(new ClaudeAdapterError(`Claude control request ${requestId} failed`, {
        error: typeof response.error === "string" ? response.error : "unknown error",
      }));
    } else {
      pending.resolve(response);
    }
  }

  #onResult(session: ClaudeSession, message: Readonly<Record<string, unknown>>): void {
    if (session.currentTurn.terminal) return;
    const sessionId = message.session_id;
    if (typeof sessionId === "string" && sessionId !== session.agentId) {
      this.#protocolFailure(session, "Claude result session_id does not match system/init", {
        expected: session.agentId,
        actual: sessionId,
      });
      return;
    }
    const permissionDenials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
    for (const denial of permissionDenials) {
      if (!isRecord(denial)) continue;
      const toolUseId = firstString(denial.tool_use_id, denial.toolUseId);
      if (!toolUseId || session.completedToolIds.has(toolUseId)) continue;
      session.completedToolIds.add(toolUseId);
      this.#emit(session, "tool.end", {
        toolCallId: toolUseId,
        ...(typeof denial.tool_name === "string" ? { toolName: denial.tool_name } : {}),
        status: "denied",
        output: denial,
      });
    }
    const failed = message.is_error === true || message.subtype !== "success";
    const interrupted = !session.currentTurn.timedOut
      && (session.currentTurn.interruptRequested || message.subtype === "interrupted");
    if (failed && !interrupted) {
      const errorText = extractErrorText(message);
      this.#emit(session, "error", {
        code: typeof message.subtype === "string" ? `CLAUDE_${message.subtype.toUpperCase()}` : "CLAUDE_RESULT_ERROR",
        message: scanChildOutput(errorText),
        fatal: false,
        details: { cliVersion: session.cliVersion ?? "unknown" },
      });
    }
    const finalText = typeof message.result === "string" ? scanChildOutput(message.result) : undefined;
    this.#completeTurn(session, interrupted ? "interrupted" : failed ? "failed" : "completed", finalText, extractUsage(message));
  }

  #completeTurn(
    session: ClaudeSession,
    status: NormalizedEventData["turn.completed"]["status"],
    finalText?: string,
    usage?: Usage,
  ): void {
    if (session.currentTurn.terminal) return;
    session.currentTurn.terminal = true;
    if (session.currentTurn.timeout) clearTimeout(session.currentTurn.timeout);
    for (const pending of session.pendingApprovals.values()) {
      if (!session.completedToolIds.has(pending.toolUseId)) {
        session.completedToolIds.add(pending.toolUseId);
        this.#emit(session, "tool.end", {
          toolCallId: pending.toolUseId,
          toolName: pending.toolName,
          status: status === "interrupted" ? "cancelled" : "denied",
        });
      }
    }
    session.pendingApprovals.clear();
    this.#emit(session, "turn.completed", {
      turnId: session.currentTurn.id,
      status,
      ...(finalText === undefined ? {} : { finalText }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  async #sendUserTurn(session: ClaudeSession, prompt: string, turnId: string, timeoutMs?: number): Promise<void> {
    await this.#write(session, {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      uuid: turnId,
    });
    const effectiveTimeout = timeoutMs;
    if (effectiveTimeout !== undefined) {
      session.currentTurn.timeout = setTimeout(() => {
        if (session.currentTurn.id !== turnId || session.currentTurn.terminal) return;
        session.currentTurn.timedOut = true;
        this.#emit(session, "error", {
          code: "CLAUDE_TURN_TIMEOUT",
          message: `Claude turn exceeded ${effectiveTimeout}ms`,
          fatal: true,
          details: { turnId },
        });
        signalProcessGroup(session.child, "SIGTERM");
        void this.interrupt(session.agentId ?? session.expectedAgentId ?? "").catch(() => this.#terminate(session));
      }, effectiveTimeout);
      session.currentTurn.timeout.unref();
    }
  }

  #write(session: ClaudeSession, value: Readonly<Record<string, unknown>>): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    const operation = session.writeChain.then(async () => {
      if (session.exited || session.child.stdin.destroyed || !session.child.stdin.writable) {
        throw new ClaudeAdapterError("Claude stdin is not writable", {
          agentId: session.agentId ?? session.expectedAgentId,
        });
      }
      if (!session.child.stdin.write(line, "utf8")) await once(session.child.stdin, "drain");
    });
    session.writeChain = operation.catch(() => undefined);
    return operation;
  }

  #onProcessError(session: ClaudeSession, error: Error): void {
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(new ClaudeAdapterError(`Failed to start Claude: ${error.message}`, {
        executable: this.#options.executable,
      }));
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", {
        code: "CLAUDE_PROCESS_ERROR",
        message: error.message,
        fatal: true,
      });
      this.#completeTurn(session, "failed");
    }
  }

  #onExit(session: ClaudeSession, code: number | null, signal: NodeJS.Signals | null): void {
    session.exited = true;
    session.exitCode = code;
    session.exitSignal = signal;
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.stdoutBuffer.trim() !== "" && !session.currentTurn.terminal) {
      this.#protocolFailure(session, "Claude stdout ended with an incomplete NDJSON line", {
        trailingBytes: Buffer.byteLength(session.stdoutBuffer),
      });
      return;
    }
    const exitError = new ClaudeAdapterError("Claude process exited before the active turn completed", {
      code,
      signal,
      stderr: scanChildOutput(session.stderr),
    });
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(exitError);
    }
    for (const control of session.controls.values()) {
      if (!control.settled) {
        control.settled = true;
        control.reject(exitError);
      }
    }
    if (session.agentId && !session.currentTurn.terminal) {
      const deliberate = session.currentTurn.timedOut || session.currentTurn.interruptRequested;
      if (!deliberate) {
        this.#emit(session, "error", {
          code: "CLAUDE_PROCESS_EXIT",
          message: exitError.message,
          fatal: true,
          details: { code, signal, stderr: scanChildOutput(session.stderr), cliVersion: session.cliVersion ?? "unknown" },
        });
      }
      this.#completeTurn(
        session,
        session.currentTurn.timedOut ? "failed" : session.currentTurn.interruptRequested ? "interrupted" : "failed",
      );
    }
  }

  #protocolFailure(session: ClaudeSession, message: string, details?: Readonly<Record<string, unknown>>): void {
    const error = new ClaudeAdapterError(message, details);
    if (!session.ready.settled) {
      session.ready.settled = true;
      session.ready.reject(error);
    }
    if (session.agentId && !session.currentTurn.terminal) {
      this.#emit(session, "error", {
        code: "CLAUDE_PROTOCOL_ERROR",
        message,
        fatal: true,
        ...(details === undefined ? {} : { details }),
      });
      this.#completeTurn(session, "failed");
    }
    this.#terminate(session);
  }

  #emit<T extends NormalizedEventType>(session: ClaudeSession, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    if (!session.agentId) throw new ClaudeAdapterError(`Cannot emit ${type} before Claude session initialization`);
    return this.buffer.append({
      type,
      agentId: session.agentId,
      backend: this.backend,
      data,
    } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #assertIdentity(session: ClaudeSession, request: ResumeRequest): void {
    if (session.requestModel !== request.model
      || session.cwd !== request.cwd
      || session.systemPrompt !== request.systemPrompt
      || !sameJson(session.env, request.env)
      || !sameJson(session.permission, request.permission)
      || session.maxTurns !== request.maxTurns) {
      throw new ClaudeAdapterError("Claude resume cannot change model, cwd, or execution config", {
        agentId: request.agentId,
        expectedModel: session.requestModel,
        requestedModel: request.model,
        expectedCwd: session.cwd,
        requestedCwd: request.cwd,
      });
    }
  }

  #requireSession(agentId: string): ClaudeSession {
    const session = this.#sessions.get(agentId);
    if (!session) throw new ClaudeAdapterError(`Unknown Claude session ${agentId}`, { agentId });
    return session;
  }

  #terminate(session: ClaudeSession): void {
    signalProcessGroup(session.child, "SIGTERM");
  }
}

export function buildClaudeArguments(
  request: Pick<SpawnRequest, "model" | "systemPrompt" | "maxTurns" | "permission" | "reasoningEffort">,
  options: Pick<ClaudeAdapterOptions, "settings"> = {},
  resumeId?: string,
): string[] {
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new ClaudeAdapterError("Claude requires an explicit model");
  }
  const args = [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-prompt-tool", "stdio",
    "--permission-prompts", "host",
    "--model", request.model,
  ];
  if (request.reasoningEffort !== undefined) {
    validateEffort(request.reasoningEffort);
    args.push("--effort", request.reasoningEffort);
  }
  if (resumeId !== undefined) args.push(`--resume=${resumeId}`);
  if (request.systemPrompt !== undefined) args.push("--system-prompt", request.systemPrompt);
  if (request.maxTurns !== undefined) args.push("--max-turns", String(request.maxTurns));
  const mode = request.permission.mode ?? DEFAULT_CLAUDE_PERMISSION_MODE;
  if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new ClaudeAdapterError(`permission.mode must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
  args.push("--permission-mode", mode);
  if (options.settings !== undefined) args.push("--settings", JSON.stringify(options.settings));
  validatePermission(request.permission);
  if (request.permission.allow.length) args.push("--allowedTools", ...request.permission.allow);
  if (request.permission.deny.length) args.push("--disallowedTools", ...request.permission.deny);
  return args;
}

function validateRequest(model: string, cwd: string, maxTurns?: number, timeoutMs?: number): void {
  if (typeof model !== "string" || model.trim() === "") throw new ClaudeAdapterError("Claude requires an explicit model");
  if (typeof cwd !== "string" || cwd.trim() === "") throw new ClaudeAdapterError("Claude requires a cwd");
  if (maxTurns !== undefined) positiveInteger(maxTurns, "maxTurns", 1);
  if (timeoutMs !== undefined) positiveInteger(timeoutMs, "timeoutMs", 1);
}

function validateToolRules(rules: readonly string[], name: string): void {
  if (!rules) return;
  for (const rule of rules) {
    if (typeof rule !== "string" || rule.trim() === "" || /[\0\r\n]/.test(rule)) {
      throw new ClaudeAdapterError(`${name} entries must be non-empty single-line strings`);
    }
  }
}

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

function validateEffort(effort: string): void {
  if (!(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new ClaudeAdapterError(
      `Claude effort must be one of ${CLAUDE_EFFORT_LEVELS.join(", ")}; got "${effort}"`,
    );
  }
}

function validatePermission(permission: PermissionConfig): void {
  if (!permission || !Array.isArray(permission.allow) || !Array.isArray(permission.deny)) {
    throw new ClaudeAdapterError("Claude requires resolved permission rules");
  }
  validateToolRules(permission.allow, "permission.allow");
  validateToolRules(permission.deny, "permission.deny");
}

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function newTurn(turnId: string): CurrentTurn {
  return { id: turnId, commandUuid: turnId, terminal: false, interruptRequested: false, timedOut: false };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: false,
  };
}

function timeoutPromise(milliseconds: number, message: string): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ClaudeAdapterError(message)), milliseconds);
    timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value !== "");
}

function extractPaths(input: Readonly<Record<string, unknown>>): readonly string[] {
  const paths = new Set<string>();
  for (const key of ["path", "file_path", "filePath", "notebook_path"] as const) {
    const value = input[key];
    if (typeof value === "string") paths.add(value);
  }
  return [...paths];
}

function extractUsage(message: Readonly<Record<string, unknown>>): Usage | undefined {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const result: Usage = {
    ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage?.cache_read_input_tokens === "number" ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
    ...(typeof message.total_cost_usd === "number" ? { costUsd: message.total_cost_usd } : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function extractErrorText(message: Readonly<Record<string, unknown>>): string {
  if (Array.isArray(message.errors)) {
    const errors = message.errors.map((value) => typeof value === "string" ? value : JSON.stringify(value));
    if (errors.length > 0) return errors.join("; ");
  }
  if (typeof message.result === "string" && message.result !== "") return message.result;
  return `Claude turn failed with ${String(message.subtype ?? "unknown result subtype")}`;
}

function boundedAppend(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= limit) return combined;
  const bytes = Buffer.from(combined);
  return `[stderr truncated]\n${bytes.subarray(Math.max(0, bytes.length - limit)).toString("utf8")}`;
}

function boundedPush<T>(values: T[], value: T, limit: number): void {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return scanChildOutput(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitizeUnknown(nested)]));
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
