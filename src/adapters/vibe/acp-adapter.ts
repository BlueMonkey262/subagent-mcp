import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import type { ApprovalRequest, ApprovalResolution } from "../../approval/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { signalProcessGroup } from "../../process-group.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ResumeRequest, SpawnRequest } from "../adapter.js";
import { AcpClient, AcpRequestError, type AcpIncomingRequest } from "./acp-client.js";
import {
  cumulativeFromPromptUsage,
  cumulativeFromUsageUpdate,
  toolCallFromUpdate,
  toolEndStatus,
  toolOutputText,
  turnUsage,
  type AcpCumulativeUsage,
  type AcpToolCall,
} from "./acp-events.js";
import { parsePermissionOptions, selectPermissionOption, supportedDecisions, vibeAcpToolEnv, type PermissionOption } from "./acp-permissions.js";
import { composeVibePrompt, VibeAdapterError } from "./arguments.js";

/**
 * Mistral Vibe over the Agent Client Protocol (`vibe-acp`, verified against 3.1.2;
 * docs/protocol/vibe-acp.md). Unlike the headless CLI, ACP asks its client before running a
 * tool, so this transport bridges each `session/request_permission` into subagent-mcp's
 * approval flow: the supervisor applies the agent's allow/deny rules and default, and anything
 * it escalates waits for `resolve_approval`.
 *
 * One `vibe-acp` process per agent, kept warm between turns and closed after an idle period;
 * the next turn then starts a new process and reattaches with `session/resume`. The model is
 * set per process with `VIBE_ACTIVE_MODEL`, never with ACP's model option, which Vibe writes
 * into the user's global `~/.vibe/config.toml`. Agent ids carry an `acp:` prefix, so an agent
 * keeps the transport it started on even if its config changes.
 */

export const ACP_AGENT_PREFIX = "acp:";

export function isAcpAgentId(agentId: string): boolean {
  return agentId.startsWith(ACP_AGENT_PREFIX);
}

/** Every tool call goes through the bridge: the supervisor's policy decides, not a Vibe mode. */
const ASK_MODE = "ask";

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_GRACE_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_USAGE_BASELINE_WAIT_MS = 3_000;
const METHOD_NOT_FOUND = -32601;

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface VibeAcpAdapterOptions {
  readonly executable?: string;
  readonly executableArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  readonly spawnProcess?: SpawnProcess;
  /** Process start, `initialize` and session creation together. */
  readonly startupTimeoutMs?: number;
  /** Control requests (`set_mode`, `set_config_option`). */
  readonly requestTimeoutMs?: number;
  /** After `session/cancel`, how long before the process group is killed. */
  readonly interruptGraceMs?: number;
  /** A warm process with no turn is closed after this long; the next turn resumes the session. */
  readonly idleTimeoutMs?: number;
  /** How long to wait for Vibe's first usage report, which is the baseline for per-turn usage. */
  readonly usageBaselineWaitMs?: number;
  /** Upstream provider of a model alias (from the CLI transport's catalog). */
  readonly providerFor?: (model: string) => Promise<string | undefined>;
}

type TurnRequest = Pick<SpawnRequest, "model" | "cwd" | "env" | "permission" | "maxTurns" | "timeoutMs" | "vibeMaxTokens" | "vibeMaxPriceUsd">;

interface AcpTurn {
  readonly id: string;
  terminal: boolean;
  interruptRequested: boolean;
  timedOut: boolean;
  timer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  readonly baseline: AcpCumulativeUsage | undefined;
  readonly texts: Map<string, string>;
  lastMessageId?: string;
  emittedText: boolean;
  readonly tools: Map<string, AcpToolCall>;
  readonly ended: Set<string>;
}

interface PendingPermission {
  readonly rpcId: number | string;
  readonly toolCallId: string;
  readonly options: readonly PermissionOption[];
}

interface AcpSession {
  readonly agentId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly cwd: string;
  readonly client: AcpClient;
  provider?: string;
  turn?: AcpTurn;
  /** Latest cumulative usage Vibe reported for the session. */
  usage?: AcpCumulativeUsage;
  latestCost?: number;
  readonly permissions: Map<string, PendingPermission>;
  idleTimer?: NodeJS.Timeout;
  /** True while `session/load` replays history: those updates are not this turn's. */
  replaying: boolean;
  closing: boolean;
  usageSeen: () => void;
  readonly firstUsage: Promise<void>;
}

export class VibeAcpAdapter implements BackendAdapter {
  readonly backend = "vibe" as const;
  /** Vibe answers a denial with its own fixed feedback; a deny `message` never reaches the model. */
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly #options: VibeAcpAdapterOptions;
  readonly #sessions = new Map<string, AcpSession>();
  /** Processes still inside #open: not in #sessions yet, but closeAll() must not leave them running. */
  readonly #launching = new Set<ReturnType<SpawnProcess>>();
  readonly #spawnProcess: SpawnProcess;

  constructor(options: VibeAcpAdapterOptions = {}) {
    this.#options = options;
    this.buffer = options.buffer ?? new EventBuffer();
    this.#spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    validateRequest(request);
    const session = await this.#open(request, undefined);
    try {
      return this.#startTurn(session, composeVibePrompt(request.systemPrompt, request.prompt), request.timeoutMs);
    } catch (error) {
      this.#terminate(session);
      throw error;
    }
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validateRequest(request);
    if (!isAcpAgentId(request.agentId)) throw new VibeAdapterError(`${request.agentId} is not a Vibe ACP agent`, { agentId: request.agentId });
    let session = this.#sessions.get(request.agentId);
    if (session !== undefined && !session.client.closed && !session.closing) {
      if (session.turn !== undefined && !session.turn.terminal) {
        throw new VibeAdapterError(`Vibe session ${request.agentId} already has an active turn`, { agentId: request.agentId });
      }
    } else {
      session = await this.#open(request, request.agentId.slice(ACP_AGENT_PREFIX.length));
    }
    return this.#startTurn(session, request.prompt, request.timeoutMs);
  }

  async interrupt(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    const turn = session.turn;
    if (turn === undefined || turn.terminal) return;
    turn.interruptRequested = true;
    this.#cancel(session, turn);
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  async approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    const session = this.#requireSession(agentId);
    const pending = session.permissions.get(resolution.requestId);
    if (pending === undefined) {
      throw new VibeAdapterError(`No pending Vibe approval ${resolution.requestId}`, { agentId, requestId: resolution.requestId });
    }
    const outcome = selectPermissionOption(resolution.decision, pending.options);
    if (outcome === undefined) {
      // Fail closed: the request stays pending so another decision can still answer it.
      throw new VibeAdapterError(
        `Vibe did not offer a safe option for "${resolution.decision}" on this request; answer with one of: ${supportedDecisions(pending.options).join(", ")}`,
        { agentId, requestId: resolution.requestId, offered: pending.options.map((option) => option.optionId) },
      );
    }
    session.permissions.delete(resolution.requestId);
    session.client.respond(pending.rpcId, { outcome });
  }

  async closeAll(): Promise<void> {
    for (const session of this.#sessions.values()) this.#terminate(session);
    for (const child of this.#launching) signalProcessGroup(child, "SIGKILL");
  }

  // ------------------------------------------------------------------ process and session

  async #open(request: TurnRequest, resumeSessionId: string | undefined): Promise<AcpSession> {
    const child = this.#spawnProcess(this.#options.executable ?? "vibe-acp", [...(this.#options.executableArgs ?? [])], {
      cwd: request.cwd,
      // The model is per process: ACP's own model option would rewrite the user's global Vibe config.
      // Tool overrides last, so an agent's env cannot reopen what its deny rules need to see.
      env: { ...process.env, ...this.#options.env, ...request.env, VIBE_ACTIVE_MODEL: request.model, ...vibeAcpToolEnv(request.permission.deny) },
      shell: false,
      windowsHide: true,
      detached: true,
    });
    this.#launching.add(child);
    let session: AcpSession | undefined;
    const early: { method: string; params: Readonly<Record<string, unknown>> }[] = [];
    const client = new AcpClient(child, {
      onRequest: (incoming) => session === undefined ? client.respondError(incoming.id, METHOD_NOT_FOUND, "no session yet") : this.#onRequest(session, incoming),
      onNotification: (method, params) => session === undefined ? early.push({ method, params }) : this.#onNotification(session, method, params),
      onProtocolNoise: (line) => session && this.#emit(session, "error", {
        code: "VIBE_ACP_PROTOCOL_WARNING", message: "Skipped a non-JSON-RPC line on vibe-acp stdout", fatal: false, details: { lineLength: line.length },
      }),
      onClose: (code, signal) => session && this.#onClose(session, code, signal),
    });
    const startup = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    try {
      await client.request("initialize", {
        protocolVersion: 1,
        // No fs or terminal delegation: Vibe does its own I/O in the session cwd. No elicitation,
        // so Vibe disables its ask-the-user tool instead of blocking on a question.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "subagent-mcp", version: "1" },
      }, startup);
      let sessionId: string;
      let replayed = false;
      if (resumeSessionId === undefined) {
        const created = await client.request<Record<string, unknown>>("session/new", { cwd: request.cwd, mcpServers: [] }, startup);
        if (typeof created?.sessionId !== "string" || created.sessionId === "") throw new VibeAdapterError("vibe-acp returned no session id");
        sessionId = created.sessionId;
        assertModel(created, request.model);
      } else {
        sessionId = resumeSessionId;
        try {
          await client.request("session/resume", { sessionId, cwd: request.cwd, mcpServers: [] }, startup);
        } catch (error) {
          if (!(error instanceof AcpRequestError) || error.error.code !== METHOD_NOT_FOUND) throw error;
          // Older agents without resume: load replays the history as updates, which are skipped.
          replayed = true;
          session = this.#newSession(sessionId, request, client, true);
          await client.request("session/load", { sessionId, cwd: request.cwd, mcpServers: [] }, startup);
          session.replaying = false;
        }
      }
      session ??= this.#newSession(sessionId, request, client, false);
      for (const notification of early) this.#onNotification(session, notification.method, notification.params);
      const control = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      await client.request("session/set_mode", { sessionId, modeId: ASK_MODE }, control);
      if (request.maxTurns !== undefined) {
        await client.request("session/set_config_option", { sessionId, configId: "max_turns", value: String(request.maxTurns) }, control);
      }
      if (request.vibeMaxTokens !== undefined) {
        await client.request("session/set_config_option", { sessionId, configId: "max_tokens", value: String(request.vibeMaxTokens) }, control);
      }
      // The first usage report is the baseline that keeps earlier turns out of this one's usage.
      if (session.usage === undefined && !replayed) {
        await raceTimeout(session.firstUsage, this.#options.usageBaselineWaitMs ?? DEFAULT_USAGE_BASELINE_WAIT_MS);
      }
      if (session.usage === undefined && resumeSessionId === undefined) session.usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      const provider = await this.#options.providerFor?.(request.model).catch(() => undefined);
      if (provider !== undefined) session.provider = provider;
      this.#sessions.set(session.agentId, session);
      return session;
    } catch (error) {
      signalProcessGroup(child, "SIGKILL");
      const detail = scanChildOutput(client.stderr.trim()).slice(-2_000);
      const message = error instanceof Error ? error.message : String(error);
      throw new VibeAdapterError(`vibe-acp could not ${resumeSessionId === undefined ? "start a session" : `resume session ${resumeSessionId}`}: ${message}`, {
        ...(detail === "" ? {} : { stderr: detail }),
      });
    } finally {
      this.#launching.delete(child);
    }
  }

  #newSession(sessionId: string, request: TurnRequest, client: AcpClient, replaying: boolean): AcpSession {
    let usageSeen: () => void = () => undefined;
    const firstUsage = new Promise<void>((resolve) => { usageSeen = resolve; });
    return {
      agentId: `${ACP_AGENT_PREFIX}${sessionId}`,
      sessionId,
      model: request.model,
      cwd: request.cwd,
      client,
      permissions: new Map(),
      replaying,
      closing: false,
      usageSeen,
      firstUsage,
    };
  }

  #startTurn(session: AcpSession, prompt: string, timeoutMs: number | undefined): AdapterTurn {
    if (session.idleTimer) { clearTimeout(session.idleTimer); delete session.idleTimer; }
    const turn: AcpTurn = {
      id: randomUUID(),
      terminal: false,
      interruptRequested: false,
      timedOut: false,
      baseline: session.usage,
      texts: new Map(),
      emittedText: false,
      tools: new Map(),
      ended: new Set(),
    };
    session.turn = turn;
    this.#emit(session, "thread.started", { threadId: session.agentId, turnId: turn.id });
    if (timeoutMs !== undefined) {
      turn.timer = setTimeout(() => {
        if (turn.terminal) return;
        turn.timedOut = true;
        this.#cancel(session, turn);
      }, timeoutMs);
    }
    session.client.request<Record<string, unknown>>("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] })
      .then((response) => this.#finishTurn(session, turn, response))
      .catch((error) => {
        if (turn.terminal || session.client.closed) return; // the close handler settles it
        this.#emit(session, "error", {
          code: "VIBE_ACP_PROMPT_FAILED",
          message: scanChildOutput(error instanceof Error ? error.message : String(error)),
          fatal: true,
        });
        this.#completeTurn(session, turn, "failed");
      });
    return { agentId: session.agentId, turnId: turn.id, backend: this.backend };
  }

  #finishTurn(session: AcpSession, turn: AcpTurn, response: Record<string, unknown> | undefined): void {
    if (turn.terminal) return;
    const stopReason = typeof response?.stopReason === "string" ? response.stopReason : "end_turn";
    const cumulative = cumulativeFromPromptUsage(response?.usage, session.latestCost);
    if (cumulative !== undefined) session.usage = cumulative;
    let usage = cumulative === undefined ? undefined : turnUsage(cumulative, turn.baseline, session.provider);
    // A cancelled turn's counters may not have caught up yet: an all-zero share is unknown, not free.
    if (stopReason === "cancelled" && usage !== undefined && !usage.inputTokens && !usage.outputTokens) usage = undefined;
    let status: NormalizedEventData["turn.completed"]["status"] = "completed";
    if (stopReason === "cancelled") {
      if (turn.timedOut) {
        this.#emit(session, "error", { code: "VIBE_TURN_TIMEOUT", message: "Vibe turn exceeded its time limit", fatal: true });
        status = "failed";
      } else {
        status = "interrupted";
      }
    } else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      this.#emit(session, "error", { code: "VIBE_LIMIT_REACHED", message: `Vibe stopped the turn: ${stopReason}`, fatal: false, details: { stopReason } });
      status = "failed";
    } else if (stopReason === "refusal") {
      this.#emit(session, "error", { code: "VIBE_REFUSAL", message: "The model refused to continue", fatal: false, details: { stopReason } });
      status = "failed";
    }
    this.#completeTurn(session, turn, status, usage);
  }

  #completeTurn(session: AcpSession, turn: AcpTurn, status: NormalizedEventData["turn.completed"]["status"], usage?: NormalizedEventData["turn.completed"]["usage"]): void {
    if (turn.terminal) return;
    turn.terminal = true;
    if (turn.timer) clearTimeout(turn.timer);
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    this.#abandonPermissions(session);
    for (const toolCallId of turn.tools.keys()) {
      if (!turn.ended.has(toolCallId)) {
        turn.ended.add(toolCallId);
        this.#emit(session, "tool.end", { toolCallId, toolName: turn.tools.get(toolCallId)!.toolName, status: "cancelled" });
      }
    }
    const finalText = turn.lastMessageId === undefined ? undefined : turn.texts.get(turn.lastMessageId);
    this.#emit(session, "turn.completed", {
      turnId: turn.id,
      status,
      ...(finalText === undefined || finalText === "" ? {} : { finalText: scanChildOutput(finalText) }),
      ...(usage === undefined ? {} : { usage }),
    });
    if (!session.client.closed) this.#armIdle(session);
  }

  /** Ask Vibe to stop; kill the process group if it has not settled the turn after the grace period. */
  #cancel(session: AcpSession, turn: AcpTurn): void {
    session.client.notify("session/cancel", { sessionId: session.sessionId });
    // ACP: a client that cancels must answer its open permission requests as cancelled.
    this.#abandonPermissions(session);
    if (turn.graceTimer) return;
    turn.graceTimer = setTimeout(() => {
      if (!turn.terminal) signalProcessGroup(session.client.child, "SIGKILL");
    }, this.#options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS);
    turn.graceTimer.unref?.();
  }

  #abandonPermissions(session: AcpSession): void {
    for (const pending of session.permissions.values()) {
      session.client.respond(pending.rpcId, { outcome: { outcome: "cancelled" } });
    }
    session.permissions.clear();
  }

  #armIdle(session: AcpSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.turn !== undefined && !session.turn.terminal) return;
      session.closing = true;
      session.client.end();
      setTimeout(() => signalProcessGroup(session.client.child, "SIGTERM"), 2_000).unref?.();
    }, this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  }

  #terminate(session: AcpSession): void {
    session.closing = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.client.end();
    signalProcessGroup(session.client.child, "SIGTERM");
  }

  #onClose(session: AcpSession, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.permissions.clear();
    const turn = session.turn;
    if (turn === undefined || turn.terminal) return;
    if (turn.interruptRequested) {
      this.#completeTurn(session, turn, "interrupted");
    } else if (turn.timedOut) {
      this.#emit(session, "error", { code: "VIBE_TURN_TIMEOUT", message: "Vibe turn exceeded its time limit", fatal: true });
      this.#completeTurn(session, turn, "failed");
    } else {
      this.#emit(session, "error", {
        code: "VIBE_ACP_EXITED",
        message: "vibe-acp exited during the turn; the session can be resumed with send_message",
        fatal: true,
        details: { exitCode: code, signal, stderr: scanChildOutput(session.client.stderr.trim()).slice(-2_000) },
      });
      this.#completeTurn(session, turn, "failed");
    }
  }

  // ------------------------------------------------------------------ agent → client

  #onRequest(session: AcpSession, request: AcpIncomingRequest): void {
    if (request.method !== "session/request_permission") {
      // fs/* and terminal/* were not advertised; anything else is unknown to this client.
      session.client.respondError(request.id, METHOD_NOT_FOUND, `${request.method} is not supported by subagent-mcp`);
      return;
    }
    const turn = session.turn;
    const toolCall = isRecord(request.params.toolCall) ? request.params.toolCall : {};
    const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : `unknown-${String(request.id)}`;
    if (request.params.sessionId !== session.sessionId || turn === undefined || turn.terminal || session.replaying) {
      session.client.respond(request.id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const options = parsePermissionOptions(request.params.options);
    const call = turn.tools.get(toolCallId) ?? toolCallFromUpdate({ ...toolCall, toolCallId });
    const requestId = `${toolCallId}#${String(request.id)}`;
    session.permissions.set(requestId, { rpcId: request.id, toolCallId, options });
    const approval: ApprovalRequest = {
      requestId,
      agentId: session.agentId,
      backend: this.backend,
      toolName: call?.toolName ?? "unknown",
      input: { ...(call?.input ?? {}), ...(call === undefined ? {} : { vibe_tool: call.vibeTool }) },
      cwd: session.cwd,
      ...(call?.command === undefined ? {} : { command: call.command }),
      ...(call === undefined || call.paths.length === 0 ? {} : { paths: call.paths }),
      ...(call?.title === undefined ? {} : { reason: call.title }),
      requestedAt: new Date().toISOString(),
    };
    this.#emit(session, "approval.requested", approval);
  }

  #onNotification(session: AcpSession, method: string, params: Readonly<Record<string, unknown>>): void {
    if (method !== "session/update" || params.sessionId !== session.sessionId) return;
    const update = isRecord(params.update) ? params.update : undefined;
    if (update === undefined) return;
    if (update.sessionUpdate === "usage_update") {
      const cumulative = cumulativeFromUsageUpdate(update);
      if (cumulative === undefined) return;
      if (cumulative.costUsd !== undefined) session.latestCost = cumulative.costUsd;
      session.usage = cumulative;
      session.usageSeen();
      const turn = session.turn;
      if (turn !== undefined && !turn.terminal && !session.replaying) {
        const usage = turnUsage(cumulative, turn.baseline, session.provider);
        if (usage !== undefined) this.#emit(session, "usage.updated", { turnId: turn.id, usage });
      }
      return;
    }
    const turn = session.turn;
    if (session.replaying || turn === undefined || turn.terminal) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = isRecord(update.content) ? update.content : {};
        if (typeof content.text !== "string" || content.text === "") return;
        const messageId = typeof update.messageId === "string" ? update.messageId : "message";
        const startsMessage = !turn.texts.has(messageId);
        turn.texts.set(messageId, (turn.texts.get(messageId) ?? "") + content.text);
        turn.lastMessageId = messageId;
        const text = startsMessage && turn.emittedText ? `\n\n${content.text}` : content.text;
        turn.emittedText = true;
        this.#emit(session, "message.delta", { text: scanChildOutput(text) });
        return;
      }
      case "tool_call": {
        const call = toolCallFromUpdate(update);
        if (call === undefined || turn.tools.has(call.toolCallId)) return;
        turn.tools.set(call.toolCallId, call);
        this.#emit(session, "tool.start", { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
        this.#maybeEndTool(session, turn, update);
        return;
      }
      case "tool_call_update":
        this.#maybeEndTool(session, turn, update);
        return;
      default:
        // agent_thought_chunk, plan, user_message_chunk, session_info_update, available_commands_update: not mapped.
        return;
    }
  }

  #maybeEndTool(session: AcpSession, turn: AcpTurn, update: Readonly<Record<string, unknown>>): void {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (toolCallId === undefined || turn.ended.has(toolCallId)) return;
    const status = toolEndStatus(update);
    if (status === undefined) return;
    turn.ended.add(toolCallId);
    const output = toolOutputText(update);
    this.#emit(session, "tool.end", {
      toolCallId,
      ...(turn.tools.get(toolCallId) === undefined ? {} : { toolName: turn.tools.get(toolCallId)!.toolName }),
      status,
      ...(output === undefined ? {} : { output: scanChildOutput(output) }),
    });
  }

  #emit<T extends NormalizedEventType>(session: AcpSession, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    return this.buffer.append({ type, agentId: session.agentId, backend: this.backend, data } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #requireSession(agentId: string): AcpSession {
    const session = this.#sessions.get(agentId);
    if (session === undefined) throw new VibeAdapterError(`Unknown Vibe ACP session ${agentId}`, { agentId });
    return session;
  }
}

function validateRequest(request: TurnRequest & { readonly prompt: string }): void {
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") throw new VibeAdapterError("Vibe requires a non-empty prompt");
  if (typeof request.model !== "string" || request.model.trim() === "") throw new VibeAdapterError("Vibe requires an explicit model alias");
  if (request.vibeMaxPriceUsd !== undefined) {
    throw new VibeAdapterError("vibeMaxPriceUsd is not available over ACP (vibe-acp has no price limit); use the CLI transport for a price cap");
  }
}

/** A typo'd alias would silently run Vibe's default model: refuse the session instead. */
function assertModel(created: Record<string, unknown>, requested: string): void {
  const options = Array.isArray(created.configOptions) ? created.configOptions : [];
  const model = options.find((option): option is Record<string, unknown> => isRecord(option) && option.id === "model");
  if (model === undefined || typeof model.currentValue !== "string") return;
  if (model.currentValue !== requested) {
    const offered = Array.isArray(model.options)
      ? model.options.flatMap((option) => isRecord(option) && typeof option.value === "string" ? [option.value] : [])
      : [];
    throw new VibeAdapterError(`Vibe is running model "${model.currentValue}", not "${requested}"; is the alias configured? Offered: ${offered.join(", ") || "(none)"}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Waits for `promise` or `ms`; the ref'd timer keeps the loop alive meanwhile and is cleared after. */
async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
