import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

import type { ApprovalResolution } from "../../approval/types.js";
import { SubagentError } from "../../core/errors.js";
import type { Usage } from "../../core/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { signalProcessGroup } from "../../process-group.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ProviderInfo, ProviderModel, ResumeRequest, SpawnRequest } from "../adapter.js";

/**
 * Verified live against the installed `opencode 1.17.6` server (see the probe transcripts this
 * adapter was built from): `opencode serve --pure` starts unsecured when
 * `OPENCODE_SERVER_PASSWORD` is unset, `POST /session?directory=<cwd>` scopes a session to a
 * working directory, `POST /session/{id}/prompt_async` accepts `{model:{providerID,modelID},
 * parts:[{type:"text",text}]}` and returns 204 immediately, and `GET /session/{id}/message`
 * gives an authoritative `info.time.completed` marker for the terminal assistant message —
 * exactly the polling floor the brief calls for.
 *
 * This adapter is polling-only by design (no SSE): the brief documents `GET /event` as
 * best-effort and regressed across releases, and mandates the polling reconciler be built
 * "from day one, not as a later hardening pass." Given that, and given the added complexity
 * an SSE-plus-reconciler implementation would add for a single build pass, this ships with
 * only the reconciler and accepts its poll interval as the latency floor rather than adding a
 * fast path that would need the same correctness guarantees duplicated. One shared `opencode
 * serve` process is reused for every session this adapter manages; each session is a separate
 * `directory`-scoped conversation on that one server.
 *
 * OpenCode 2.x ("v2") replaced that wire protocol: `serve` rejects `--pure`, is password-secured
 * (HTTP Basic, user `opencode`, password taken from `OPENCODE_SERVER_PASSWORD`, which this adapter
 * generates per server), and the session API lives under `/api/session`: create with
 * `{location:{directory}, model:{providerID,id}}`, `POST .../prompt {text}` (queues, returns the
 * user message), `POST .../interrupt`, `POST .../permission/{id}/reply {decision}`, pending
 * permissions at `GET /api/permission/request`, and `GET .../message` returning a newest-first
 * log in which an `idle` message with an `outcome` ends a turn. The adapter picks the protocol by
 * the installed binary's major version (`opencode --version`), keeping v1 behaviour unchanged.
 * Verified live against opencode 2.0.22 on 2026-10-03.
 */

const DEFAULT_INIT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_ACTIVE_MS = 400;
const DEFAULT_POLL_IDLE_MS = 3_000;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
/** Each `providerInfo` request gets this long, so one hung endpoint cannot sink the others. */
const DEFAULT_LIVE_SECTION_TIMEOUT_MS = 10_000;

export interface OpenCodeAdapterOptions {
  readonly executable?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly initTimeoutMs?: number;
  readonly pollActiveMs?: number;
  readonly pollIdleMs?: number;
  readonly interruptGraceMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  /** Injectable for tests; must resolve the already-running server's base URL. */
  readonly baseUrl?: string;
  /**
   * Wire protocol. Default: auto-detected from `opencode --version` when this adapter starts the
   * server itself, and "v1" for an injected `baseUrl` (so existing injected-server tests are unchanged).
   */
  readonly protocol?: OpenCodeProtocol;
  /** v2 only: the server password to authenticate with (injected `baseUrl`), or to start the server with. */
  readonly password?: string;
  /** Per-request limit for `providerInfo` (default 10s). */
  readonly liveSectionTimeoutMs?: number;
}

export type OpenCodeProtocol = "v1" | "v2";

const execFileAsync = promisify(execFile);

export class OpenCodeAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "OPENCODE_ADAPTER_ERROR", details);
  }
}

interface SeenPart {
  emittedLength: number;
  toolStarted: boolean;
  toolEnded: boolean;
}

interface OpenCodeSession {
  readonly cwd: string;
  readonly directory: string;
  /** v2: the model the server-side session is currently set to ("provider/model"), if known. */
  model: string | undefined;
  /** v2: id of the user message the current turn's prompt created, and when it was sent (ms epoch). */
  promptMessageId: string | undefined;
  promptStartedAt: number;
  /** Last running usage reported with `usage.updated` this turn, serialized, so an unchanged poll stays quiet. */
  liveUsage: string | undefined;
  /** v2: true from the start of #sendPrompt until the prompt is registered; polling must not read the log meanwhile. */
  promptSending: boolean;
  turnInFlight: boolean;
  interruptRequested: boolean;
  terminal: boolean;
  turnId: string;
  readonly seenParts: Map<string, SeenPart>;
  readonly seenPermissions: Map<string, string>;
  readonly pumpAbort: AbortController;
  pumpDone: Promise<void>;
  timeout?: NodeJS.Timeout;
  timedOut: boolean;
  readonly waiters: (() => void)[];
}

/** Polling-only OpenCode `serve` adapter. One shared server process, many directory-scoped sessions. */
export class OpenCodeAdapter implements BackendAdapter {
  readonly backend = "opencode" as const;
  /** OpenCode's permission-response wire format is decision-only; a deny `message` never reaches the child. */
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly #options: Required<Pick<OpenCodeAdapterOptions, "executable" | "hostname" | "initTimeoutMs" | "pollActiveMs" | "pollIdleMs" | "interruptGraceMs">> & OpenCodeAdapterOptions;
  readonly #sessions = new Map<string, OpenCodeSession>();
  #server: { readonly process: ChildProcessWithoutNullStreams; readonly baseUrl: string } | undefined;
  #starting: Promise<string> | undefined;
  #protocol: OpenCodeProtocol = "v1";
  /** v2: `Authorization` header value (HTTP Basic) for the password-secured server. */
  #authorization: string | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#options = {
      ...options,
      executable: options.executable ?? "opencode",
      hostname: options.hostname ?? "127.0.0.1",
      initTimeoutMs: positiveInteger(options.initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS),
      pollActiveMs: positiveInteger(options.pollActiveMs, DEFAULT_POLL_ACTIVE_MS),
      pollIdleMs: positiveInteger(options.pollIdleMs, DEFAULT_POLL_IDLE_MS),
      interruptGraceMs: positiveInteger(options.interruptGraceMs, DEFAULT_INTERRUPT_GRACE_MS),
    };
    this.buffer = options.buffer ?? new EventBuffer();
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    validateRequest(request.model, request.cwd);
    const baseUrl = await this.#ensureServer();
    let sessionId: string;
    if (this.#protocol === "v2") {
      const { providerID, modelID } = parseModel(request.model);
      const created = await this.#fetchJson(baseUrl, "POST", "/api/session", {
        location: { directory: request.cwd },
        model: { providerID, id: modelID },
      });
      sessionId = requireString(isRecord(created) ? created.data : undefined, "id", "session creation response id");
    } else {
      const created = await this.#fetchJson(baseUrl, "POST", `/session?directory=${encodeURIComponent(request.cwd)}`, {});
      sessionId = requireString(created, "id", "session creation response id");
    }
    const session: OpenCodeSession = {
      cwd: request.cwd,
      directory: request.cwd,
      model: this.#protocol === "v2" ? request.model : undefined,
      promptMessageId: undefined,
      promptStartedAt: 0,
      promptSending: false,
      liveUsage: undefined,
      turnInFlight: false,
      interruptRequested: false,
      terminal: false,
      turnId: randomUUID(),
      seenParts: new Map(),
      seenPermissions: new Map(),
      pumpAbort: new AbortController(),
      pumpDone: Promise.resolve(),
      timedOut: false,
      waiters: [],
    };
    this.#sessions.set(sessionId, session);
    this.#emit(sessionId, "thread.started", { threadId: sessionId, turnId: session.turnId });
    session.pumpDone = this.#pump(baseUrl, sessionId, session);
    await this.#sendPrompt(baseUrl, sessionId, session, request.model, request.prompt, request.timeoutMs);
    return { agentId: sessionId, turnId: session.turnId, backend: this.backend };
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validateRequest(request.model, request.cwd);
    const baseUrl = await this.#ensureServer();
    let session = this.#sessions.get(request.agentId);
    if (!session) {
      // Rejoin an existing server-side session (e.g. after this adapter instance restarted).
      const lookup = this.#protocol === "v2"
        ? `/api/session/${request.agentId}`
        : `/session/${request.agentId}?directory=${encodeURIComponent(request.cwd)}`;
      await this.#fetchJson(baseUrl, "GET", lookup, undefined, true)
        .catch(() => {
          throw new OpenCodeAdapterError(`Unknown or unresumable OpenCode session ${request.agentId}`, { agentId: request.agentId });
        });
      session = {
        cwd: request.cwd,
        directory: request.cwd,
        model: undefined,
        promptMessageId: undefined,
        promptStartedAt: 0,
        promptSending: false,
        liveUsage: undefined,
        turnInFlight: false,
        interruptRequested: false,
        terminal: false,
        turnId: randomUUID(),
        seenParts: new Map(),
        seenPermissions: new Map(),
        pumpAbort: new AbortController(),
        pumpDone: Promise.resolve(),
        timedOut: false,
        waiters: [],
      };
      this.#sessions.set(request.agentId, session);
      session.pumpDone = this.#pump(baseUrl, request.agentId, session);
    } else if (session.turnInFlight) {
      throw new OpenCodeAdapterError(`OpenCode session ${request.agentId} already has an active turn`, { agentId: request.agentId });
    } else {
      session.turnId = randomUUID();
      session.terminal = false;
    }
    await this.#sendPrompt(baseUrl, request.agentId, session, request.model, request.prompt, request.timeoutMs);
    return { agentId: request.agentId, turnId: session.turnId, backend: this.backend };
  }

  async interrupt(agentId: string): Promise<void> {
    const session = this.#requireSession(agentId);
    if (session.terminal) return;
    session.interruptRequested = true;
    const baseUrl = await this.#ensureServer();
    try {
      await this.#fetchJson(
        baseUrl,
        "POST",
        this.#protocol === "v2"
          ? `/api/session/${agentId}/interrupt`
          : `/session/${agentId}/abort?directory=${encodeURIComponent(session.directory)}`,
        {},
      );
    } catch {
      // fall through to the grace-timeout reconciliation below
    }
    // The grace wait belongs to the turn being interrupted. If a new turn starts before it ends (a quick
    // resume), it must not be force-completed as "interrupted" when the grace timer finally fires.
    const interruptedTurnId = session.turnId;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        clearInterval(check);
        resolve();
      }, this.#options.interruptGraceMs);
      const check = setInterval(() => {
        if (session.terminal || session.turnId !== interruptedTurnId) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
    if (!session.terminal && session.turnId === interruptedTurnId) this.#completeTurn(agentId, session, "interrupted");
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  async approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    const session = this.#requireSession(agentId);
    const permissionId = session.seenPermissions.get(resolution.requestId);
    if (!permissionId) {
      throw new OpenCodeAdapterError(`No pending OpenCode approval ${resolution.requestId} for ${agentId}`, { agentId, requestId: resolution.requestId });
    }
    const response = resolution.decision === "allow" ? "once" : resolution.decision === "allow_for_session" ? "always" : "reject";
    const baseUrl = await this.#ensureServer();
    if (this.#protocol === "v2") {
      await this.#fetchJson(baseUrl, "POST", `/api/session/${agentId}/permission/${permissionId}/reply`, { decision: response });
    } else {
      await this.#fetchJson(baseUrl, "POST", `/session/${agentId}/permissions/${permissionId}?directory=${encodeURIComponent(session.directory)}`, { response });
    }
    session.seenPermissions.delete(resolution.requestId);
  }

  async close(agentId: string): Promise<void> {
    const session = this.#sessions.get(agentId);
    if (!session) return;
    if (!session.terminal) await this.interrupt(agentId);
    session.pumpAbort.abort();
  }

  /**
   * v2 only: the models the server can run (`GET /api/model`), its default (`GET /api/model/default`),
   * and OpenCode plan/budget usage (`GET /api/experimental/usage/limits`). Each section fails on its
   * own, so an experimental endpoint going away still leaves the model list. Usage here is what
   * OpenCode's console knows (Go meters, workspace budgets), not third-party provider quotas.
   */
  async providerInfo(signal?: AbortSignal): Promise<ProviderInfo> {
    const baseUrl = await this.#ensureServer();
    if (this.#protocol !== "v2") {
      return { supported: false, reason: "Live models and usage need opencode >= 2.0 (the v1 server has no /api/model)." };
    }
    const get = (path: string) => {
      const timeout = AbortSignal.timeout(this.#options.liveSectionTimeoutMs ?? DEFAULT_LIVE_SECTION_TIMEOUT_MS);
      return this.#fetchJson(baseUrl, "GET", path, undefined, true, signal === undefined ? timeout : AbortSignal.any([signal, timeout]))
        .then((body) => (isRecord(body) ? body.data : undefined));
    };
    const [models, defaultModel, limits] = await Promise.allSettled([
      get("/api/model"),
      get("/api/model/default"),
      get("/api/experimental/usage/limits"),
    ]);
    const errors: Record<string, string> = {};
    const settled = <T>(name: string, result: PromiseSettledResult<unknown>, map: (value: unknown) => T): T | undefined => {
      if (result.status === "fulfilled") return map(result.value);
      errors[name] = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return undefined;
    };
    const available = settled("models", models, (value) => (Array.isArray(value) ? value.flatMap(summarizeModel) : []));
    const fallback = settled("default_model", defaultModel, (value) => summarizeModel(value)[0]?.id);
    const usage = settled("usage_limits", limits, summarizeUsageLimits);
    return {
      ...(fallback === undefined ? {} : { default_model: fallback }),
      ...(usage === undefined ? {} : { usage_limits: usage }),
      ...(available === undefined ? {} : { models: available }),
      ...(Object.keys(errors).length === 0 ? {} : { errors }),
    };
  }

  async closeAll(): Promise<void> {
    for (const agentId of this.#sessions.keys()) await this.close(agentId);
    if (this.#server) {
      signalProcessGroup(this.#server.process, "SIGTERM");
      this.#server = undefined;
    }
  }

  async #ensureServer(): Promise<string> {
    if (this.#server) return this.#server.baseUrl;
    if (this.#starting) return this.#starting;
    this.#starting = this.#startServer();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  /** Wire protocol of the installed binary: "v2" for opencode >= 2.0, otherwise "v1". */
  async #detectProtocol(): Promise<OpenCodeProtocol> {
    if (this.#options.protocol !== undefined) return this.#options.protocol;
    try {
      const { stdout } = await execFileAsync(this.#options.executable, ["--version"], {
        timeout: 10_000,
        env: { ...process.env, ...this.#options.env },
      });
      const major = Number.parseInt(/(\d+)\.\d+\.\d+/.exec(stdout)?.[1] ?? "", 10);
      return Number.isFinite(major) && major >= 2 ? "v2" : "v1";
    } catch {
      // An unreadable version keeps the long-standing v1 behaviour; a wrong guess surfaces as a startup error.
      return "v1";
    }
  }

  async #startServer(): Promise<string> {
    if (this.#options.baseUrl !== undefined) {
      this.#protocol = this.#options.protocol ?? "v1";
      this.#authorization = this.#options.password === undefined ? undefined : basicAuthorization(this.#options.password);
      this.#server = { process: nullProcess(), baseUrl: this.#options.baseUrl };
      return this.#options.baseUrl;
    }
    const protocol = await this.#detectProtocol();
    this.#protocol = protocol;
    // v2 secures the server with a password; choose our own so we never have to scrape it from stdout.
    const password = protocol === "v2"
      ? (this.#options.password ?? this.#options.env?.OPENCODE_SERVER_PASSWORD ?? randomBytes(24).toString("hex"))
      : undefined;
    this.#authorization = password === undefined ? undefined : basicAuthorization(password);
    // `--pure` exists only on v1's `serve`; v2 rejects it ("Unknown flag") and exits before listening.
    const serveArgs = ["serve", "--hostname", this.#options.hostname, "--port", "0", ...(protocol === "v1" ? ["--pure"] : [])];
    const child = nodeSpawn(this.#options.executable, serveArgs, {
      env: { ...process.env, ...this.#options.env, ...(password === undefined ? {} : { OPENCODE_SERVER_PASSWORD: password }) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group so shutting the server down also reaps commands it spawned.
      detached: true,
    });
    let stdout = "";
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OpenCodeAdapterError(`OpenCode server did not become ready within ${this.#options.initTimeoutMs}ms`)), this.#options.initTimeoutMs);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const match = /listening on (http:\/\/[^\s]+)/.exec(stdout);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new OpenCodeAdapterError(`Failed to start OpenCode: ${error.message}`));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new OpenCodeAdapterError("OpenCode server exited before becoming ready", { code, signal }));
      });
    });
    const baseUrl = await ready;
    this.#server = { process: child, baseUrl };
    return baseUrl;
  }

  async #sendPrompt(baseUrl: string, sessionId: string, session: OpenCodeSession, model: string, prompt: string, timeoutMs?: number): Promise<void> {
    const { providerID, modelID } = parseModel(model);
    if (this.#protocol === "v2") {
      // Reset the turn markers before the pump can see `turnInFlight`, and keep it off the log until
      // the prompt is registered: otherwise it reads the previous turn's idle as this turn's end.
      session.promptSending = true;
      session.promptMessageId = undefined;
      session.promptStartedAt = Date.now();
    }
    session.turnInFlight = true;
    session.terminal = false;
    session.liveUsage = undefined;
    session.interruptRequested = false;
    session.timedOut = false;
    if (timeoutMs !== undefined) {
      session.timeout = setTimeout(() => {
        session.timedOut = true;
        this.#emit(sessionId, "error", { code: "OPENCODE_TURN_TIMEOUT", message: `OpenCode turn exceeded ${timeoutMs}ms`, fatal: true });
        void this.interrupt(sessionId).catch(() => undefined);
      }, timeoutMs);
      session.timeout.unref();
    }
    if (this.#protocol === "v2") {
      // v2 fixes the model on the session, not per prompt: switch only when it differs from the one set.
      if (session.model !== model) {
        try {
          await this.#fetchJson(baseUrl, "POST", `/api/session/${sessionId}/model`, { model: { providerID, id: modelID } });
        } catch (error) {
          session.promptSending = false;
          throw error;
        }
        session.model = model;
      }
      try {
        session.promptStartedAt = Date.now();
        const sent = await this.#fetchJson(baseUrl, "POST", `/api/session/${sessionId}/prompt`, { text: prompt });
        const queued = isRecord(sent) && isRecord(sent.data) ? sent.data : undefined;
        session.promptMessageId = typeof queued?.id === "string" ? queued.id : undefined;
      } finally {
        session.promptSending = false;
      }
      return;
    }
    await this.#fetchJson(baseUrl, "POST", `/session/${sessionId}/prompt_async?directory=${encodeURIComponent(session.directory)}`, {
      model: { providerID, modelID },
      parts: [{ type: "text", text: prompt }],
    });
  }

  async #pump(baseUrl: string, sessionId: string, session: OpenCodeSession): Promise<void> {
    const signal = session.pumpAbort.signal;
    while (!signal.aborted) {
      try {
        if (session.turnInFlight) {
          if (this.#protocol === "v2") {
            await this.#pollPermissionsV2(baseUrl, sessionId, session);
            await this.#pollMessagesV2(baseUrl, sessionId, session);
          } else {
            await this.#pollPermissions(baseUrl, sessionId, session);
            await this.#pollMessages(baseUrl, sessionId, session);
          }
        }
      } catch (error) {
        if (session.turnInFlight && !session.terminal) {
          this.#emit(sessionId, "error", { code: "OPENCODE_POLL_ERROR", message: error instanceof Error ? error.message : String(error), fatal: false });
        }
      }
      const delayMs = session.turnInFlight ? this.#options.pollActiveMs : this.#options.pollIdleMs;
      await sleep(delayMs, signal);
    }
  }

  async #pollPermissions(baseUrl: string, sessionId: string, session: OpenCodeSession): Promise<void> {
    const pending = await this.#fetchJson(baseUrl, "GET", "/permission", undefined, true);
    if (!Array.isArray(pending)) return;
    for (const item of pending) {
      if (!isRecord(item) || item.sessionID !== sessionId) continue;
      const requestId = typeof item.id === "string" ? item.id : undefined;
      if (!requestId || session.seenPermissions.has(requestId)) continue;
      session.seenPermissions.set(requestId, requestId);
      const metadata = isRecord(item.metadata) ? item.metadata : {};
      const command = typeof metadata.command === "string" ? metadata.command : undefined;
      const paths = extractPaths(metadata);
      this.#emit(sessionId, "approval.requested", {
        requestId,
        agentId: sessionId,
        backend: this.backend,
        toolName: typeof item.permission === "string" ? item.permission : "unknown",
        input: metadata,
        cwd: session.cwd,
        ...(command === undefined ? {} : { command }),
        ...(paths.length === 0 ? {} : { paths }),
        requestedAt: new Date().toISOString(),
      });
    }
  }

  async #pollMessages(baseUrl: string, sessionId: string, session: OpenCodeSession): Promise<void> {
    const messages = await this.#fetchJson(baseUrl, "GET", `/session/${sessionId}/message?directory=${encodeURIComponent(session.directory)}`, undefined, true);
    if (!Array.isArray(messages)) return;
    const last = messages.at(-1);
    if (!isRecord(last)) return;
    const info = isRecord(last.info) ? last.info : {};
    const parts = Array.isArray(last.parts) ? last.parts : [];
    if (info.role !== "assistant") return;

    for (const part of parts) {
      if (!isRecord(part) || typeof part.id !== "string") continue;
      if (part.type === "text" && typeof part.text === "string") {
        const seen = session.seenParts.get(part.id) ?? { emittedLength: 0, toolStarted: false, toolEnded: false };
        if (part.text.length > seen.emittedLength) {
          this.#emit(sessionId, "message.delta", { text: scanChildOutput(part.text.slice(seen.emittedLength)) });
          seen.emittedLength = part.text.length;
          session.seenParts.set(part.id, seen);
        }
      } else if (part.type === "tool") {
        const seen = session.seenParts.get(part.id) ?? { emittedLength: 0, toolStarted: false, toolEnded: false };
        const state = isRecord(part.state) ? part.state : {};
        if (!seen.toolStarted) {
          this.#emit(sessionId, "tool.start", { toolCallId: part.id, toolName: typeof part.tool === "string" ? part.tool : "unknown", input: isRecord(state.input) ? state.input : {} });
          seen.toolStarted = true;
        }
        if (!seen.toolEnded && (state.status === "completed" || state.status === "error")) {
          this.#emit(sessionId, "tool.end", { toolCallId: part.id, status: state.status === "error" ? "failed" : "completed", output: state.output });
          seen.toolEnded = true;
        }
        session.seenParts.set(part.id, seen);
      }
    }

    const time = isRecord(info.time) ? info.time : {};
    if (typeof time.completed === "number") {
      const finalText = parts
        .filter((part): part is Readonly<Record<string, unknown>> => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      const usage = extractUsage(info);
      const status = session.timedOut ? "failed" : info.finish === "error" ? "failed" : "completed";
      this.#completeTurn(sessionId, session, status, finalText === "" ? undefined : scanChildOutput(finalText), usage);
    }
  }

  /** v2: pending permission requests (`GET /api/permission/request`) for this session. */
  async #pollPermissionsV2(baseUrl: string, sessionId: string, session: OpenCodeSession): Promise<void> {
    // The session-scoped route, not `GET /api/permission/request`: that one is scoped to the server's own
    // working directory and never lists a session that lives in another `location.directory`.
    const pending = await this.#fetchJson(baseUrl, "GET", `/api/session/${sessionId}/permission`, undefined, true);
    const items = isRecord(pending) && Array.isArray(pending.data) ? pending.data : [];
    for (const item of items) {
      if (!isRecord(item) || item.sessionID !== sessionId) continue;
      const requestId = typeof item.id === "string" ? item.id : undefined;
      if (!requestId || session.seenPermissions.has(requestId)) continue;
      session.seenPermissions.set(requestId, requestId);
      const metadata = isRecord(item.metadata) ? item.metadata : {};
      const command = typeof metadata.command === "string" ? metadata.command : undefined;
      const resources = Array.isArray(item.resources) ? item.resources.filter((value): value is string => typeof value === "string") : [];
      const paths = [...new Set([...extractPaths(metadata), ...resources])];
      this.#emit(sessionId, "approval.requested", {
        requestId,
        agentId: sessionId,
        backend: this.backend,
        toolName: typeof item.action === "string" ? item.action : "unknown",
        input: metadata,
        cwd: session.cwd,
        ...(command === undefined ? {} : { command }),
        ...(paths.length === 0 ? {} : { paths }),
        requestedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * v2: read the session log (newest first), keep what came after this turn's prompt, stream new
   * assistant text and tool activity, and finish the turn on the `idle` message that follows it.
   */
  async #pollMessagesV2(baseUrl: string, sessionId: string, session: OpenCodeSession): Promise<void> {
    if (session.promptSending) return;
    const response = await this.#fetchJson(baseUrl, "GET", `/api/session/${sessionId}/message?order=desc&limit=200`, undefined, true);
    const newestFirst = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    const log = [...newestFirst].reverse();
    const promptIndex = session.promptMessageId === undefined ? -1 : log.findIndex((message) => isRecord(message) && message.id === session.promptMessageId);
    const turn = promptIndex >= 0
      ? log.slice(promptIndex + 1)
      : log.filter((message) => isRecord(message) && isRecord(message.time) && typeof message.time.created === "number" && message.time.created >= session.promptStartedAt);

    let lastText = "";
    let idle: Readonly<Record<string, unknown>> | undefined;
    let sawUsage = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let uncachedInputTokens = 0;
    let costUsd = 0;
    for (const message of turn) {
      if (!isRecord(message)) continue;
      if (message.type === "idle") {
        idle ??= message;
        continue;
      }
      if (message.type !== "assistant") continue;
      const messageId = typeof message.id === "string" ? message.id : "";
      const content = Array.isArray(message.content) ? message.content : [];
      let text = "";
      content.forEach((part: unknown, index: number) => {
        if (!isRecord(part)) return;
        if (part.type === "text" && typeof part.text === "string") {
          text += part.text;
          const key = `${messageId}:${index}`;
          const seen = session.seenParts.get(key) ?? { emittedLength: 0, toolStarted: false, toolEnded: false };
          if (part.text.length > seen.emittedLength) {
            this.#emit(sessionId, "message.delta", { text: scanChildOutput(part.text.slice(seen.emittedLength)) });
            seen.emittedLength = part.text.length;
            session.seenParts.set(key, seen);
          }
        } else if (part.type === "tool" && typeof part.id === "string") {
          const key = `tool:${part.id}`;
          const seen = session.seenParts.get(key) ?? { emittedLength: 0, toolStarted: false, toolEnded: false };
          const state = isRecord(part.state) ? part.state : {};
          if (!seen.toolStarted) {
            this.#emit(sessionId, "tool.start", { toolCallId: part.id, toolName: typeof part.name === "string" ? part.name : "unknown", input: isRecord(state.input) ? state.input : {} });
            seen.toolStarted = true;
          }
          if (!seen.toolEnded && (state.status === "completed" || state.status === "error")) {
            const output = toolContentText(state) ?? (isRecord(state.error) && typeof state.error.message === "string" ? state.error.message : undefined);
            this.#emit(sessionId, "tool.end", { toolCallId: part.id, status: state.status === "error" ? "failed" : "completed", output });
            seen.toolEnded = true;
          }
          session.seenParts.set(key, seen);
        }
      });
      if (text !== "") lastText = text;
      const tokens = isRecord(message.tokens) ? message.tokens : undefined;
      if (tokens) {
        sawUsage = true;
        inputTokens += typeof tokens.input === "number" ? tokens.input : 0;
        outputTokens += typeof tokens.output === "number" ? tokens.output : 0;
        const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
        cachedInputTokens += typeof cache?.read === "number" ? cache.read : 0;
        uncachedInputTokens += freshInput(tokens);
      }
      if (typeof message.cost === "number") {
        sawUsage = true;
        costUsd += message.cost;
      }
    }

    if (sawUsage && !idle) {
      const usage: Usage = { inputTokens, outputTokens, cachedInputTokens, uncachedInputTokens, costUsd };
      const key = JSON.stringify(usage);
      if (key !== session.liveUsage) {
        session.liveUsage = key;
        this.#emit(sessionId, "usage.updated", { turnId: session.turnId, usage });
      }
    }

    if (idle) {
      const outcome = idle.outcome;
      const status = session.timedOut || outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "completed";
      const usage: Usage | undefined = sawUsage ? { inputTokens, outputTokens, cachedInputTokens, uncachedInputTokens, costUsd } : undefined;
      this.#completeTurn(sessionId, session, status, lastText === "" ? undefined : scanChildOutput(lastText), usage);
    }
  }

  #completeTurn(sessionId: string, session: OpenCodeSession, status: NormalizedEventData["turn.completed"]["status"], finalText?: string, usage?: Usage): void {
    if (session.terminal) return;
    session.terminal = true;
    session.turnInFlight = false;
    if (session.timeout) clearTimeout(session.timeout);
    for (const requestId of session.seenPermissions.keys()) {
      this.#emit(sessionId, "tool.end", { toolCallId: requestId, status: status === "interrupted" ? "cancelled" : "denied" });
    }
    session.seenPermissions.clear();
    this.#emit(sessionId, "turn.completed", {
      turnId: session.turnId,
      status,
      ...(finalText === undefined ? {} : { finalText }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  #emit<T extends NormalizedEventType>(agentId: string, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    return this.buffer.append({ type, agentId, backend: this.backend, data } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #requireSession(agentId: string): OpenCodeSession {
    const session = this.#sessions.get(agentId);
    if (!session) throw new OpenCodeAdapterError(`Unknown OpenCode session ${agentId}`, { agentId });
    return session;
  }

  async #fetchJson(baseUrl: string, method: string, path: string, body: unknown, allow404 = false, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.#authorization === undefined ? {} : { authorization: this.#authorization }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 && allow404) {
      throw new OpenCodeAdapterError(`OpenCode ${method} ${path} returned 404`, { status: 404 });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OpenCodeAdapterError(`OpenCode ${method} ${path} failed with ${response.status}`, { status: response.status, body: text.slice(0, 500) });
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  }
}

function parseModel(model: string): { readonly providerID: string; readonly modelID: string } {
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new OpenCodeAdapterError(`OpenCode model must be "provider/model", got "${model}"`, { model });
  }
  return { providerID, modelID };
}

/**
 * One v2 `/api/model` entry, reduced to what routing needs. Drops `headers`/`settings`, which carry
 * account identifiers and provider endpoints. `cost` is OpenCode's USD per million tokens.
 */
function summarizeModel(value: unknown): ProviderModel[] {
  if (!isRecord(value) || typeof value.providerID !== "string") return [];
  const modelID = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : undefined;
  if (modelID === undefined) return [];
  const limit = isRecord(value.limit) ? value.limit : {};
  const cost = Array.isArray(value.cost) && isRecord(value.cost[0]) ? value.cost[0] : undefined;
  const cache = isRecord(cost?.cache) ? cost.cache : {};
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const variants = Array.isArray(value.variants)
    ? value.variants.flatMap((variant: unknown) => (isRecord(variant) && typeof variant.id === "string" ? [variant.id] : []))
    : [];
  return [{
    id: `${value.providerID}/${modelID}`,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(value.enabled === false ? { enabled: false } : {}),
    ...(typeof limit.context === "number" ? { context: limit.context } : {}),
    ...(typeof limit.output === "number" ? { max_output: limit.output } : {}),
    ...(cost === undefined
      ? {}
      : {
        cost_per_mtok: {
          ...(typeof cost.input === "number" ? { input: cost.input } : {}),
          ...(typeof cost.output === "number" ? { output: cost.output } : {}),
          ...(typeof cache.read === "number" ? { cache_read: cache.read } : {}),
        },
      }),
    ...(capabilities.tools === false ? { tools: false } : {}),
    ...(variants.length === 0 ? {} : { variants }),
  }];
}

/**
 * `/api/experimental/usage/limits`: OpenCode Go meters (`percent` used, `resetsAt` epoch ms) become
 * `percent_used`/`remaining_percent`/ISO `resets_at`. The workspace keeps only its name: its id and
 * `usageURL` (which embeds the id) are dropped, and budgets go through an allowlist without their id.
 */
function summarizeUsageLimits(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const workspace = isRecord(value.workspace) ? value.workspace : undefined;
  const go = isRecord(value.go) ? value.go : undefined;
  const meters = go === undefined
    ? undefined
    : Object.fromEntries(Object.entries(go).flatMap(([window, meter]) => {
      if (!isRecord(meter)) return [];
      const percent = typeof meter.percent === "number" ? meter.percent : undefined;
      return [[window, {
        ...(percent === undefined ? {} : { percent_used: percent, remaining_percent: Math.max(0, 100 - percent) }),
        ...(typeof meter.limited === "boolean" ? { limited: meter.limited } : {}),
        ...(typeof meter.resetsAt === "number" ? { resets_at: new Date(meter.resetsAt).toISOString() } : {}),
      }]];
    }));
  return {
    ...(typeof workspace?.name === "string" ? { workspace: { name: workspace.name } } : {}),
    ...(meters === undefined ? {} : { go: meters }),
    ...(Array.isArray(value.budgets) ? { budgets: value.budgets.filter(isRecord).map(summarizeBudget) } : {}),
  };
}

/** One `UsageLimits.Budget` (USD amounts, `resetsAt` epoch ms), by allowlist so its id never passes through. */
function summarizeBudget(budget: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const number = (key: string) => (typeof budget[key] === "number" ? budget[key] as number : undefined);
  const limit = number("limit");
  const spent = number("spent");
  const inputPriceAtLeast = number("inputPriceAtLeast");
  const models = Array.isArray(budget.models)
    ? budget.models.filter(isRecord).map((model) => ({
      ...(typeof model.providerID === "string" && typeof model.modelID === "string" ? { model: `${model.providerID}/${model.modelID}` } : {}),
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      ...(typeof model.spent === "number" ? { spent_usd: model.spent } : {}),
    }))
    : undefined;
  return {
    ...(limit === undefined ? {} : { limit_usd: limit }),
    ...(spent === undefined ? {} : { spent_usd: spent }),
    ...(limit === undefined || spent === undefined ? {} : { remaining_usd: Math.max(0, limit - spent) }),
    ...(typeof budget.scope === "string" ? { scope: budget.scope } : {}),
    ...(typeof budget.per === "string" ? { per: budget.per } : {}),
    ...(typeof budget.coverage === "string" ? { coverage: budget.coverage } : {}),
    ...(models === undefined ? {} : { models }),
    ...(Array.isArray(budget.vendors) ? { vendors: budget.vendors.filter((vendor) => typeof vendor === "string") } : {}),
    ...(inputPriceAtLeast === undefined ? {} : { input_price_at_least_per_mtok: inputPriceAtLeast }),
    ...(typeof budget.picked === "boolean" ? { picked: budget.picked } : {}),
    ...(typeof budget.shared === "boolean" ? { shared: budget.shared } : {}),
    ...(typeof budget.resetsAt === "number" ? { resets_at: new Date(budget.resetsAt).toISOString() } : {}),
  };
}

/** HTTP Basic credentials for v2's password-secured server (user is always `opencode`). */
function basicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

/** Text of a v2 tool state's `content` array (text items only), or undefined when it has none. */
function toolContentText(state: Readonly<Record<string, unknown>>): string | undefined {
  if (!Array.isArray(state.content)) return undefined;
  const texts = state.content
    .filter((item): item is Readonly<Record<string, unknown>> => isRecord(item) && typeof item.text === "string")
    .map((item) => item.text as string);
  return texts.length === 0 ? undefined : texts.join("\n");
}

function validateRequest(model: string, cwd: string): void {
  if (typeof model !== "string" || model.trim() === "") throw new OpenCodeAdapterError("OpenCode requires an explicit model");
  if (typeof cwd !== "string" || cwd.trim() === "") throw new OpenCodeAdapterError("OpenCode requires a cwd");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("value must be a positive integer");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, key: string, what: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || value[key] === "") {
    throw new OpenCodeAdapterError(`OpenCode response is missing ${what}`);
  }
  return value[key] as string;
}

function extractPaths(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  const paths = new Set<string>();
  for (const key of ["filePath", "path", "file"]) {
    const value = metadata[key];
    if (typeof value === "string") paths.add(value);
  }
  return [...paths];
}

function extractUsage(info: Readonly<Record<string, unknown>>): Usage | undefined {
  const tokens = isRecord(info.tokens) ? info.tokens : undefined;
  if (!tokens) return undefined;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const result: Usage = {
    ...(typeof tokens.input === "number" ? { inputTokens: tokens.input } : {}),
    ...(typeof tokens.output === "number" ? { outputTokens: tokens.output } : {}),
    ...(typeof cache?.read === "number" ? { cachedInputTokens: cache.read } : {}),
    ...(typeof tokens.input === "number" ? { uncachedInputTokens: freshInput(tokens) } : {}),
    ...(typeof info.cost === "number" ? { costUsd: info.cost } : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * OpenCode's `tokens.input` excludes cache reads (recorded turns show `cache.read` far above
 * `input`), and cache writes are counted separately but were processed fresh.
 */
function freshInput(tokens: Readonly<Record<string, unknown>>): number {
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  return (typeof tokens.input === "number" ? tokens.input : 0) + (typeof cache?.write === "number" ? cache.write : 0);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function nullProcess(): ChildProcessWithoutNullStreams {
  // Only used when `baseUrl` is injected (tests / an externally managed server); closeAll()
  // must not try to kill a process this adapter never started.
  return { kill: () => true } as unknown as ChildProcessWithoutNullStreams;
}
