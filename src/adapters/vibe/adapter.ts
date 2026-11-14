import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ApprovalResolution } from "../../approval/types.js";
import type { Usage } from "../../core/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../../events/schema.js";
import { signalProcessGroup } from "../../process-group.js";
import { scanChildOutput } from "../../safety/output.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ProviderInfo, ResumeRequest, SpawnRequest } from "../adapter.js";
import { buildVibeArguments, composeVibePrompt, VibeAdapterError } from "./arguments.js";
import { parseVibeExport, parseVibeStreamEntry, vibeTerminal, type VibeCatalogModel, type VibeExport, type VibeStreamItem } from "./parser.js";

/**
 * Mistral Vibe CLI adapter (`vibe -p`, verified against mistral-vibe 3.1.2; docs/protocol/vibe.md).
 *
 * Like Cursor, Vibe headless mode is one process per turn: the prompt goes in on stdin, completed
 * history entries stream out as JSON lines, and the process exits after writing
 * `<output-dir>/export.json`. Continuation is a fresh process with `--resume <session_id>`.
 *
 * The agent id is Vibe's native session id, read from the first streamed entry (every entry
 * carries `sessionId`) or, when the run streamed nothing, from the export. So the supervisor's
 * persisted record is all a restarted host needs to resume, and no id is ever guessed: a run that
 * dies before Vibe names its session fails the spawn instead of returning a receipt.
 *
 * The export, not the exit code, decides the outcome (see parser.ts `vibeTerminal`). A missing or
 * unreadable export is an infrastructure failure, never a success.
 *
 * Headless Vibe cannot ask the host to approve a tool call; it denies any call that would need
 * approval. `permission.default: allow` runs `--auto-approve`; anything else runs the builtin `ask`
 * agent with only read-only tools enabled (see arguments.ts).
 */

const DEFAULT_INIT_TIMEOUT_MS = 90_000;
/** Vibe gives a stopped run up to 10 s to wind down and write its export. */
const DEFAULT_INTERRUPT_GRACE_MS = 15_000;
/** Past the turn's own `--time-limit`, how long before the adapter stops the run itself. */
const DEFAULT_TIMEOUT_BACKSTOP_MS = 20_000;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface VibeAdapterOptions {
  readonly executable?: string;
  /** Fixed argv before Vibe flags. Intended for wrapped binaries and process fixtures. */
  readonly executableArgs?: readonly string[];
  /** How long to wait for Vibe to name its session (startup includes MCP servers and connectors). */
  readonly initTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly timeoutBackstopMs?: number;
  readonly stderrLimitBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly buffer?: EventBuffer;
  readonly spawnProcess?: SpawnProcess;
  /** Parent directory for per-turn `--output-dir`s. Defaults to the OS temp directory. */
  readonly outputRoot?: string;
  /** Keep each turn's export and journal copy instead of deleting them once read. */
  readonly keepOutputDirs?: boolean;
  /**
   * Where to remember the model catalog from the latest export, so `list_models` can show Vibe's
   * aliases after a host restart. Vibe has no command that lists them without a run.
   */
  readonly catalogCachePath?: string;
}

interface VibeCatalog {
  readonly models: readonly VibeCatalogModel[];
  readonly seen_at: string;
  readonly vibe_version?: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
}

interface VibeTurn {
  readonly id: string;
  terminal: boolean;
  interruptRequested: boolean;
  timedOut: boolean;
  timeout?: NodeJS.Timeout;
  interruptPromise?: Promise<void>;
  lastAssistantText?: string;
  emittedText: boolean;
}

interface VibeSession {
  agentId?: string;
  /** The alias this session runs (fixed at creation; resumed turns pass it explicitly). */
  readonly model: string;
  readonly expectedAgentId?: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly outputDir: string;
  readonly ready: Deferred<string>;
  readonly pending: VibeStreamItem[];
  readonly currentTurn: VibeTurn;
  stdoutBuffer: string;
  stderr: string;
  exited: boolean;
  initTimer?: NodeJS.Timeout;
}

export class VibeAdapter implements BackendAdapter {
  readonly backend = "vibe" as const;
  /** Headless mode has no approval-response channel; a deny `message` never reaches the child. */
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly #options: Required<Pick<VibeAdapterOptions,
    "executable" | "initTimeoutMs" | "interruptGraceMs" | "timeoutBackstopMs" | "stderrLimitBytes" | "outputRoot">> & VibeAdapterOptions;
  readonly #sessions = new Map<string, VibeSession>();
  readonly #launches = new Set<VibeSession>();
  readonly #spawnProcess: SpawnProcess;
  #catalog: VibeCatalog | undefined;
  #catalogLoaded = false;

  constructor(options: VibeAdapterOptions = {}) {
    this.#options = {
      ...options,
      executable: options.executable ?? "vibe",
      initTimeoutMs: positiveInteger(options.initTimeoutMs, "initTimeoutMs", DEFAULT_INIT_TIMEOUT_MS),
      interruptGraceMs: positiveInteger(options.interruptGraceMs, "interruptGraceMs", DEFAULT_INTERRUPT_GRACE_MS),
      timeoutBackstopMs: positiveInteger(options.timeoutBackstopMs, "timeoutBackstopMs", DEFAULT_TIMEOUT_BACKSTOP_MS),
      stderrLimitBytes: positiveInteger(options.stderrLimitBytes, "stderrLimitBytes", DEFAULT_STDERR_LIMIT_BYTES),
      outputRoot: options.outputRoot ?? tmpdir(),
    };
    this.buffer = options.buffer ?? new EventBuffer();
    this.#spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    validatePrompt(request.prompt);
    const session = await this.#launch(request, composeVibePrompt(request.systemPrompt, request.prompt));
    const agentId = await session.ready.promise;
    return { agentId, turnId: session.currentTurn.id, backend: this.backend };
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    validatePrompt(request.prompt);
    const existing = this.#sessions.get(request.agentId);
    if (existing && !existing.exited) {
      if (!existing.currentTurn.terminal) {
        throw new VibeAdapterError(`Vibe session ${request.agentId} already has an active turn`, { agentId: request.agentId });
      }
      this.#terminate(existing);
    }
    const session = await this.#launch(request, request.prompt, request.agentId);
    const actualId = await session.ready.promise;
    return { agentId: actualId, turnId: session.currentTurn.id, backend: this.backend };
  }

  async interrupt(agentId: string): Promise<void> {
    return this.#interruptSession(this.#requireSession(agentId));
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  async approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    this.#requireSession(agentId);
    throw new VibeAdapterError(
      `Vibe headless mode does not expose approval ${resolution.requestId} to the host`,
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

  async #launch(
    request: Pick<SpawnRequest, "model" | "cwd" | "permission" | "env" | "maxTurns" | "timeoutMs" | "vibeMaxTokens" | "vibeMaxPriceUsd">,
    prompt: string,
    expectedAgentId?: string,
  ): Promise<VibeSession> {
    // Validate before creating anything on disk.
    buildVibeArguments({ ...request, outputDir: "-" }, expectedAgentId);
    const outputDir = await mkdtemp(join(this.#options.outputRoot, "subagent-vibe-"));
    let args: string[];
    try {
      args = buildVibeArguments({ ...request, outputDir }, expectedAgentId);
    } catch (error) {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const child = this.#spawnProcess(this.#options.executable, [...(this.#options.executableArgs ?? []), ...args], {
      cwd: request.cwd,
      env: { ...process.env, ...this.#options.env, ...request.env },
      shell: false,
      windowsHide: true,
      // Own process group, so a stop that Vibe does not honor can still reap its app-server and tools.
      detached: true,
    });
    const session: VibeSession = {
      model: request.model,
      ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
      child,
      outputDir,
      ready: deferred<string>(),
      pending: [],
      currentTurn: { id: randomUUID(), terminal: false, interruptRequested: false, timedOut: false, emittedText: false },
      stdoutBuffer: "",
      stderr: "",
      exited: false,
    };
    // A spawn that never gets a receipt is nobody's to await; keep its rejection from going unhandled.
    session.ready.promise.catch(() => undefined);
    this.#launches.add(session);
    session.initTimer = setTimeout(() => {
      this.#rejectReady(session, new VibeAdapterError(`Vibe did not report a session within ${this.#options.initTimeoutMs}ms`, {
        stderr: scanChildOutput(session.stderr),
      }));
      this.#terminate(session);
    }, this.#options.initTimeoutMs);
    session.initTimer.unref();
    if (request.timeoutMs !== undefined) this.#armBackstop(session, request.timeoutMs);
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(session, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderr = boundedAppend(session.stderr, chunk, this.#options.stderrLimitBytes);
    });
    child.on("error", (error) => this.#onProcessError(session, error));
    // `close`, not `exit`: stdout must be drained before the export is reconciled.
    child.on("close", () => void this.#onClose(session).catch((error) => {
      this.#rejectReady(session, error);
      this.#failTurn(session, "VIBE_ADAPTER_ERROR", error instanceof Error ? error.message : String(error));
    }));
    return session;
  }

  #onStdout(session: VibeSession, chunk: string): void {
    session.stdoutBuffer += chunk;
    let newline = session.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = session.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
      this.#handleLine(session, line);
      newline = session.stdoutBuffer.indexOf("\n");
    }
  }

  #handleLine(session: VibeSession, line: string): void {
    if (line.trim() === "" || session.currentTurn.terminal) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Vibe writes only JSON to stdout in streaming mode, but a torn final line from a killed run is
      // expected and the export remains authoritative, so a bad line is recorded and skipped.
      if (!session.currentTurn.interruptRequested && session.agentId) {
        this.#emit(session, "error", {
          code: "VIBE_PROTOCOL_WARNING",
          message: "Skipped a malformed line on Vibe stdout",
          fatal: false,
          details: { lineLength: line.length },
        });
      }
      return;
    }
    const item = parseVibeStreamEntry(value);
    if (item.kind === "invalid") return;
    if (!session.agentId) {
      if (!this.#establish(session, item.sessionId)) return;
    }
    this.#onItem(session, item);
  }

  /** Adopt Vibe's session id as the agent id. Returns false (and fails the launch) on a mismatch. */
  #establish(session: VibeSession, sessionId: string): boolean {
    if (session.agentId === sessionId) return true;
    if (session.agentId !== undefined) return false;
    if (session.expectedAgentId !== undefined && session.expectedAgentId !== sessionId) {
      this.#rejectReady(session, new VibeAdapterError("Vibe resumed a different session than requested", {
        expected: session.expectedAgentId,
        actual: sessionId,
      }));
      this.#terminate(session);
      return false;
    }
    const collision = this.#sessions.get(sessionId);
    if (collision && collision !== session && !collision.exited) {
      this.#rejectReady(session, new VibeAdapterError(`Vibe session ${sessionId} is already owned by another process`));
      this.#terminate(session);
      return false;
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
    return true;
  }

  #onItem(session: VibeSession, item: VibeStreamItem): void {
    // Subagents spawned by Vibe's own task tool have their own sessions; their entries are not this agent's.
    if (item.sessionId !== session.agentId) return;
    const turn = session.currentTurn;
    if (item.kind === "message") {
      if (item.role !== "assistant" || item.discarded || item.text.trim() === "") return;
      const text = scanChildOutput(item.text);
      turn.lastAssistantText = text;
      this.#emit(session, "message.delta", { text: turn.emittedText ? `\n\n${text}` : text });
      turn.emittedText = true;
    } else if (item.kind === "tool") {
      // An effect line is written once the call has settled, so it opens and closes the call at once.
      this.#emit(session, "tool.start", { toolCallId: item.toolCallId, toolName: item.toolName, input: item.input });
      this.#emit(session, "tool.end", {
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        status: item.status,
        ...(item.output === undefined ? {} : { output: item.output }),
      });
    }
  }

  async #onClose(session: VibeSession): Promise<void> {
    session.exited = true;
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.stdoutBuffer.trim() !== "") {
      const trailing = session.stdoutBuffer;
      session.stdoutBuffer = "";
      this.#handleLine(session, trailing);
    }
    try {
      const exported = await this.#readExport(session);
      if (!session.agentId && exported?.sessionId !== undefined) this.#establish(session, exported.sessionId);
      if (!session.agentId) {
        this.#rejectReady(session, new VibeAdapterError(
          exported
            ? `Vibe run ended (${exported.outcome}) before it opened a session${exported.errorMessage ? `: ${scanChildOutput(exported.errorMessage)}` : ""}`
            : "Vibe exited before it opened a session and wrote no export",
          {
            ...(exported ? { outcome: exported.outcome } : {}),
            exitCode: session.child.exitCode,
            signal: session.child.signalCode,
            stderr: scanChildOutput(session.stderr),
          },
        ));
        return;
      }
      this.#settleTurn(session, exported);
    } finally {
      if (!this.#options.keepOutputDirs) await rm(session.outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #readExport(session: VibeSession): Promise<VibeExport | undefined> {
    let text: string;
    try {
      text = await readFile(join(session.outputDir, "export.json"), "utf8");
    } catch {
      return undefined;
    }
    try {
      return parseVibeExport(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  #settleTurn(session: VibeSession, exported: VibeExport | undefined): void {
    const turn = session.currentTurn;
    if (turn.terminal) return;
    if (exported === undefined) {
      if (turn.timedOut) {
        this.#emit(session, "error", { code: "VIBE_TURN_TIMEOUT", message: "Vibe turn exceeded its time limit", fatal: true });
        this.#completeTurn(session, "failed");
      } else if (turn.interruptRequested) {
        this.#completeTurn(session, "interrupted");
      } else {
        this.#failTurn(session, "VIBE_EXPORT_MISSING", "Vibe exited without a readable export.json", {
          exitCode: session.child.exitCode,
          signal: session.child.signalCode,
          stderr: scanChildOutput(session.stderr),
        });
      }
      return;
    }
    if (exported.sessionId !== undefined && exported.sessionId !== session.agentId) {
      this.#failTurn(session, "VIBE_PROTOCOL_ERROR", "Vibe export names a different session than its stream", {
        expected: session.agentId,
        actual: exported.sessionId,
      });
      return;
    }
    const terminal = vibeTerminal(exported, turn);
    if (terminal.error) {
      this.#emit(session, "error", {
        code: terminal.error.code,
        message: scanChildOutput(terminal.error.message),
        fatal: terminal.status === "failed" && !["VIBE_LIMIT_REACHED", "VIBE_REFUSAL", "VIBE_LENGTH"].includes(terminal.error.code),
        details: {
          outcome: exported.outcome,
          ...(exported.exitCode === undefined ? {} : { exitCode: exported.exitCode }),
          ...(exported.stopReason === undefined ? {} : { stopReason: exported.stopReason }),
          ...(exported.errorCode === undefined ? {} : { vibeErrorCode: exported.errorCode }),
          ...(exported.steps === undefined ? {} : { steps: exported.steps }),
          ...(exported.warnings.length === 0 ? {} : { warnings: exported.warnings.map(scanChildOutput) }),
        },
      });
    }
    if (exported.catalog !== undefined && exported.catalog.length > 0) this.#rememberCatalog(exported);
    const model = exported.activeModel ?? session.model;
    const provider = (exported.catalog ?? this.#catalog?.models)?.find((entry) => entry.id === model)?.provider;
    const usage = exported.usage === undefined || provider === undefined ? exported.usage : { ...exported.usage, provider };
    // Partial output is kept whatever the outcome.
    this.#completeTurn(session, terminal.status, turn.lastAssistantText, usage);
  }

  /**
   * Vibe's model aliases as of the most recent run's export (`config.models`): Vibe has no command
   * that lists them without starting a run. Before any run, nothing is reported.
   */
  async providerInfo(): Promise<ProviderInfo> {
    await this.#loadCatalog();
    if (this.#catalog === undefined) {
      return { source: "none", note: "Vibe reports its model aliases only in a run's export; none has been seen yet. Spawn any Vibe agent once to populate this." };
    }
    return {
      source: "latest run export",
      seen_at: this.#catalog.seen_at,
      ...(this.#catalog.vibe_version === undefined ? {} : { vibe_version: this.#catalog.vibe_version }),
      cost_basis: "estimated from Vibe's configured prices; plan usage is not billed per token",
      models: this.#catalog.models,
    };
  }

  #rememberCatalog(exported: VibeExport): void {
    this.#catalog = {
      models: exported.catalog!,
      seen_at: new Date().toISOString(),
      ...(exported.vibeVersion === undefined ? {} : { vibe_version: exported.vibeVersion }),
    };
    this.#catalogLoaded = true;
    const path = this.#options.catalogCachePath;
    if (path === undefined) return;
    const temporary = `${path}.${process.pid}.tmp`;
    void mkdir(dirname(path), { recursive: true })
      .then(() => writeFile(temporary, `${JSON.stringify(this.#catalog, null, 2)}\n`, "utf8"))
      .then(() => rename(temporary, path))
      .catch(() => undefined);
  }

  async #loadCatalog(): Promise<void> {
    if (this.#catalogLoaded) return;
    this.#catalogLoaded = true;
    const path = this.#options.catalogCachePath;
    if (path === undefined) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as VibeCatalog).models)
          && typeof (parsed as VibeCatalog).seen_at === "string") {
        this.#catalog = parsed as VibeCatalog;
      }
    } catch {
      // No cache yet, or unreadable: report nothing rather than guess.
    }
  }

  #armBackstop(session: VibeSession, timeoutMs: number): void {
    const turn = session.currentTurn;
    turn.timeout = setTimeout(() => {
      if (turn.terminal) return;
      turn.timedOut = true;
      void this.#interruptSession(session).catch(() => this.#terminate(session));
    }, timeoutMs + this.#options.timeoutBackstopMs);
    turn.timeout.unref();
  }

  #interruptSession(session: VibeSession): Promise<void> {
    const turn = session.currentTurn;
    if (turn.terminal || session.exited) return Promise.resolve();
    if (turn.interruptPromise) return turn.interruptPromise;
    turn.interruptRequested = true;
    turn.interruptPromise = (async () => {
      // SIGTERM to Vibe itself only: it stops its turn and tools and writes the export. Signalling the
      // whole group at once would kill its app-server mid-export.
      try {
        session.child.kill("SIGTERM");
      } catch {
        // already gone
      }
      await waitFor(() => turn.terminal || session.exited, this.#options.interruptGraceMs);
      if (!session.exited) signalProcessGroup(session.child, "SIGKILL");
      await waitFor(() => turn.terminal, 2_000);
      if (!turn.terminal && session.agentId) {
        if (turn.timedOut) this.#emit(session, "error", { code: "VIBE_TURN_TIMEOUT", message: "Vibe turn exceeded its time limit", fatal: true });
        this.#completeTurn(session, turn.timedOut ? "failed" : "interrupted");
      }
    })();
    return turn.interruptPromise;
  }

  #failTurn(session: VibeSession, code: string, message: string, details?: Readonly<Record<string, unknown>>): void {
    if (!session.agentId || session.currentTurn.terminal) return;
    this.#emit(session, "error", { code, message, fatal: true, ...(details === undefined ? {} : { details }) });
    this.#completeTurn(session, "failed", session.currentTurn.lastAssistantText);
  }

  #completeTurn(
    session: VibeSession,
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

  #onProcessError(session: VibeSession, error: Error): void {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    this.#rejectReady(session, new VibeAdapterError(
      missing
        ? `Vibe CLI not found (${this.#options.executable}). Install Mistral Vibe and run \`vibe --setup\`.`
        : `Failed to start Vibe: ${error.message}`,
      { executable: this.#options.executable },
    ));
    if (session.agentId) this.#failTurn(session, "VIBE_PROCESS_ERROR", scanChildOutput(error.message));
  }

  #rejectReady(session: VibeSession, error: unknown): void {
    if (session.ready.settled) return;
    session.ready.settled = true;
    session.ready.reject(error);
  }

  #emit<T extends NormalizedEventType>(session: VibeSession, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    if (!session.agentId) throw new VibeAdapterError(`Cannot emit ${type} before Vibe names its session`);
    return this.buffer.append({ type, agentId: session.agentId, backend: this.backend, data } as NewAgentEvent<T>) as AgentEvent<T>;
  }

  #requireSession(agentId: string): VibeSession {
    const session = this.#sessions.get(agentId);
    if (!session) throw new VibeAdapterError(`Unknown Vibe session ${agentId}`, { agentId });
    return session;
  }

  #terminate(session: VibeSession): void {
    if (session.initTimer) clearTimeout(session.initTimer);
    if (session.currentTurn.timeout) clearTimeout(session.currentTurn.timeout);
    signalProcessGroup(session.child, "SIGTERM");
  }
}

function validatePrompt(prompt: unknown): void {
  if (typeof prompt !== "string" || prompt.trim() === "") throw new VibeAdapterError("Vibe requires a non-empty prompt");
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (condition()) return resolve();
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve();
    }, timeoutMs);
    const check = setInterval(() => {
      if (condition()) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 20);
  });
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

function boundedAppend(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= limit) return combined;
  const bytes = Buffer.from(combined);
  return `[stderr truncated]\n${bytes.subarray(Math.max(0, bytes.length - limit)).toString("utf8")}`;
}
