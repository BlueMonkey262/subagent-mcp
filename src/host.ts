import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AdapterRegistry } from "./adapters/adapter.js";
import { AntigravityAdapter } from "./adapters/antigravity/adapter.js";
import { ClaudeAdapter } from "./adapters/claude/adapter.js";
import { CodexAdapter } from "./adapters/codex/adapter.js";
import { CursorAdapter } from "./adapters/cursor/adapter.js";
import { OpenCodeAdapter } from "./adapters/opencode/adapter.js";
import { LiveConfig } from "./config/live.js";
import { isBackend } from "./core/types.js";
import type { EventReadOptions } from "./events/buffer.js";
import type { NormalizedEventType } from "./events/schema.js";
import type { ListAgentsInput, AgentSnapshot, SendMessageInput, SpawnAgentInput, Supervisor } from "./supervisor.js";
import { Supervisor as SupervisorClass } from "./supervisor.js";
import { ensureProjectMemoryIgnored } from "./storage/routing.js";
import { checkForUpdate } from "./update-check.js";
import { UsageLedger } from "./usage.js";

export const HOST_PROTOCOL = 2;

/** A fingerprint of compiled code: a hash of the `.js` files, and when the newest of them was written. */
export interface BuildInfo {
  readonly build: string;
  /** Newest file mtime (ms). Orders builds, so a proxy never replaces a host with older code. */
  readonly builtAt: number;
}

const BUILD_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/**
 * The build this process loaded, taken at import time so a later rebuild on disk does not change
 * it. A proxy that finds an idle host on an older build, with no other session attached, replaces
 * it, so rebuilding and reconnecting picks up new code.
 */
const LOADED_BUILD = readBuild(BUILD_DIRECTORY);

function readBuild(directory: string): BuildInfo {
  const hash = createHash("sha256");
  let builtAt = 0;
  try {
    const files = readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".js"))
      .sort();
    for (const file of files) {
      const path = join(directory, file);
      hash.update(file).update("\0").update(readFileSync(path)).update("\0");
      builtAt = Math.max(builtAt, statSync(path).mtimeMs);
    }
  } catch {
    return { build: "unknown", builtAt: 0 };
  }
  return { build: hash.digest("hex").slice(0, 16), builtAt: Math.floor(builtAt) };
}

/** This process's build. `SUBAGENT_MCP_BUILD_ID` / `SUBAGENT_MCP_BUILD_TIME` override it (tests). */
export function buildInfo(): BuildInfo {
  const time = Number(process.env.SUBAGENT_MCP_BUILD_TIME);
  return {
    build: process.env.SUBAGENT_MCP_BUILD_ID ?? LOADED_BUILD.build,
    builtAt: Number.isFinite(time) && process.env.SUBAGENT_MCP_BUILD_TIME !== undefined ? time : LOADED_BUILD.builtAt,
  };
}

/** The build currently on disk, which differs from `buildInfo()` after a rebuild. */
export function diskBuildInfo(): BuildInfo {
  return process.env.SUBAGENT_MCP_DISK_BUILD_ID !== undefined
    ? { build: process.env.SUBAGENT_MCP_DISK_BUILD_ID, builtAt: Number(process.env.SUBAGENT_MCP_BUILD_TIME ?? 0) }
    : readBuild(BUILD_DIRECTORY);
}

export interface HostHello {
  readonly protocol?: number;
  readonly pid?: number;
  readonly build?: string;
  readonly builtAt?: number;
  /** Connected clients, including the one asking. */
  readonly clients?: number;
  readonly active?: number;
  readonly waiting?: number;
}

export type HostDisposition = "keep" | "newer" | "stale" | "replace" | "refuse";

/**
 * What a connecting proxy does with a host:
 * - `keep`: same build.
 * - `newer`: the host runs newer code than this proxy; keep it (never downgrade) and reconnect the proxy.
 * - `replace`: the host runs older code (or predates build reporting), is idle, and no other session uses it.
 * - `stale`: older code, but agents are running or waiting, or another session is attached; keep it for now.
 * - `refuse`/`replace` on a protocol mismatch, by whether agents are running.
 */
export function hostDisposition(hello: HostHello, local: BuildInfo): HostDisposition {
  const busy = (hello.active ?? 0) > 0 || (hello.waiting ?? 0) > 0;
  if (hello.protocol !== HOST_PROTOCOL) return busy ? "refuse" : "replace";
  if (hello.build === local.build) return "keep";
  if (typeof hello.builtAt === "number" && hello.builtAt > local.builtAt) return "newer";
  const otherClients = Math.max(0, (hello.clients ?? 1) - 1);
  return busy || otherClients > 0 ? "stale" : "replace";
}

const IDLE_EXIT_MS = 60_000;
const CONNECT_WAIT_MS = 8_000;
const RECORDED_HOST_WAIT_MS = 2_000;

export interface HostPaths {
  readonly socketPath: string;
  readonly directory: string;
  readonly pidPath: string;
  readonly snapshotPath: string;
  readonly usagePath: string;
  readonly lockPath: string;
  readonly logPath: string;
}

export function hostPaths(cwd: string): HostPaths {
  const directory = join(resolve(cwd), ".subagents", "memory");
  // Hash the canonical path: on macOS /tmp and /var are symlinks into /private, and a spawned
  // host's process.cwd() reports the resolved path, so the client must hash the same string.
  const hash = createHash("sha256").update(canonicalPath(cwd)).digest("hex").slice(0, 16);
  return {
    socketPath: join(tmpdir(), `subagent-mcp-${hash}.sock`),
    directory,
    pidPath: join(directory, "host.json"),
    snapshotPath: join(directory, "sessions.json"),
    usagePath: join(directory, "usage.json"),
    lockPath: join(directory, "host.lock"),
    logPath: join(directory, "host.log"),
  };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface RunningHost {
  notify(message: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
  readonly clients: number;
}

export async function serveHost(options: {
  readonly socketPath: string;
  readonly supervisor: Supervisor;
  readonly onClients?: (count: number) => void;
  readonly onShutdown?: () => void;
}): Promise<RunningHost> {
  const sockets = new Set<Socket>();
  let shuttingDown = false;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    options.onClients?.(sockets.size);
    const buffer = { text: "" };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer.text += chunk;
      let newline = buffer.text.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.text.slice(0, newline);
        buffer.text = buffer.text.slice(newline + 1);
        newline = buffer.text.indexOf("\n");
        if (line.trim() === "") continue;
        void handleLine(socket, line, options.supervisor, () => {
          if (shuttingDown) return;
          shuttingDown = true;
          options.onShutdown?.();
        }, { clients: () => sockets.size });
      }
    });
    const drop = (): void => {
      sockets.delete(socket);
      options.onClients?.(sockets.size);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    get clients() {
      return sockets.size;
    },
    notify(message) {
      const line = `${JSON.stringify(message)}\n`;
      for (const socket of sockets) socket.write(line);
    },
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Attach to the project host, starting one if this working directory does not already have one. */
export async function connectHost(options: {
  readonly cwd: string;
  readonly agentsDirectory: string;
  readonly modelsFile: string;
  readonly scriptPath: string;
}): Promise<HostClient> {
  const paths = hostPaths(options.cwd);
  await mkdir(paths.directory, { recursive: true });
  const existing = await connectCompatibleHost(paths.socketPath);
  if (existing.client !== undefined) {
    if (existing.pid !== undefined) await refreshLockForOwner(paths.lockPath, existing.pid);
    return existing.client;
  }
  if (existing.stoppedPid !== undefined) {
    await waitForExit(existing.stoppedPid, RECORDED_HOST_WAIT_MS);
  }

  const owner = await liveHostOwner(paths);
  if (owner !== undefined) {
    const deadline = Date.now() + RECORDED_HOST_WAIT_MS;
    while (Date.now() < deadline && isAlive(owner.pid)) {
      const retry = await connectCompatibleHost(paths.socketPath);
      if (retry.client !== undefined) {
        if (retry.pid !== undefined) await refreshLockForOwner(paths.lockPath, retry.pid);
        return retry.client;
      }
      if (retry.stoppedPid !== undefined) {
        await waitForExit(retry.stoppedPid, RECORDED_HOST_WAIT_MS);
        break;
      }
      await delay(50);
    }
    if (isAlive(owner.pid)) {
      throw new Error(
        `subagent-mcp host pid ${owner.pid} recorded in ${owner.source} is still running, but its socket ` +
          `at ${paths.socketPath} is unreachable. Refusing to start a duplicate; stop pid ${owner.pid}, ` +
          "then ask the user to run `/mcp` and reconnect subagent-mcp.",
      );
    }
  }
  await startDaemon(options, paths);
  return waitForHost(paths.socketPath);
}

const RESTART_EXIT_WAIT_MS = 10_000;

/**
 * The proxy's connection to its project host, and the one place that replaces it. Owns the client
 * so a failed restart never leaves tool calls on a closed connection.
 */
export class HostSession {
  #client: HostClient | undefined;
  #error: Error | undefined;
  readonly #detached: ((data: Readonly<Record<string, unknown>>) => void)[] = [];

  constructor(readonly options: Parameters<typeof connectHost>[0]) {}

  async connect(): Promise<void> {
    try {
      this.#attach(await connectHost(this.options));
    } catch (error) {
      // Startup failures used to reach stderr (visible in Claude Code's MCP log); keep that.
      process.stderr.write(`subagent-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
      this.#fail(error);
    }
  }

  onDetached(listener: (data: Readonly<Record<string, unknown>>) => void): void {
    this.#detached.push(listener);
    this.#client?.onDetached(listener);
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    if (this.#client === undefined) {
      throw this.#error ?? new Error("subagent-mcp host is not connected. Ask the user to run `/mcp` and then reconnect subagent-mcp.");
    }
    return this.#client.call(method, params);
  }

  /** Why the connected host's code differs from this proxy's, if it does. */
  warning(): string | undefined {
    const host = this.#client?.host;
    const local = buildInfo();
    if (host === undefined || host.build === local.build) return undefined;
    if (typeof host.builtAt === "number" && host.builtAt > local.builtAt) {
      return "The subagent-mcp host runs newer code than this MCP connection. Ask the user to run `/mcp` and " +
        "reconnect subagent-mcp to load updated tool definitions.";
    }
    return "The subagent-mcp host runs an older build than this MCP connection, because agents were running or " +
      "another session was attached when it connected. Once agents finish and other sessions disconnect, call " +
      "restart_host to load the new code.";
  }

  /**
   * Replace the host with one running the code on disk. Refused while agents run or wait (always),
   * and, unless `force`, when the host already runs the code on disk or other sessions are attached
   * (replacing it would drop their connections).
   */
  async restart(force = false): Promise<Readonly<Record<string, unknown>>> {
    const client = this.#client;
    const hello = client === undefined ? undefined : await client.call("hello", undefined, 2_000).catch(() => undefined) as HostHello | undefined;
    if (hello !== undefined && client !== undefined) {
      if ((hello.active ?? 0) > 0 || (hello.waiting ?? 0) > 0) {
        throw new Error("subagent-mcp host still has running agents and will not restart; wait for them to finish.");
      }
      if (!force && hello.build === diskBuildInfo().build) {
        throw new Error("The subagent-mcp host already runs the code on disk; there is nothing to reload. Pass force: true to restart anyway.");
      }
      const others = Math.max(0, (hello.clients ?? 1) - 1);
      if (!force && others > 0) {
        throw new Error(
          `${others} other session(s) are connected to this subagent-mcp host; restarting would disconnect them. ` +
            "Ask the user, then pass force: true to restart anyway.",
        );
      }
      await client.call("shutdown", undefined, 5_000);
      client.close();
      this.#client = undefined;
      const pid = positiveInteger(hello.pid);
      if (pid !== undefined) await waitForExit(pid, RESTART_EXIT_WAIT_MS);
    }
    try {
      this.#attach(await connectHost(this.options));
    } catch (error) {
      this.#fail(error);
      throw this.#error;
    }
    const next = this.#client!.host;
    return {
      restarted: true,
      ...(hello?.pid === undefined ? {} : { previous_pid: hello.pid }),
      pid: next?.pid,
      build: next?.build,
      build_changed: hello?.build !== next?.build,
      ...(this.warning() === undefined ? {} : { host_warning: this.warning() }),
    };
  }

  close(): void {
    this.#client?.close();
  }

  #attach(client: HostClient): void {
    this.#client = client;
    this.#error = undefined;
    for (const listener of this.#detached) client.onDetached(listener);
  }

  #fail(error: unknown): void {
    this.#client = undefined;
    const message = error instanceof Error ? error.message : String(error);
    this.#error = new Error(message.includes("/mcp") ? message : `${message} Ask the user to run \`/mcp\` and then reconnect subagent-mcp.`);
  }
}

export async function runHost(): Promise<void> {
  const cwd = process.cwd();
  const agentsDirectory = process.env.SUBAGENT_MCP_AGENTS_DIR ?? join(cwd, ".subagents");
  const modelsFile = process.env.SUBAGENT_MCP_MODELS_FILE ?? join(cwd, ".subagents", "models.yaml");
  const paths = hostPaths(cwd);
  await mkdir(paths.directory, { recursive: true });

  const firstProbe = await probeHost(paths.socketPath);
  if (firstProbe.state === "live") {
    if (firstProbe.pid !== undefined) await refreshLockForOwner(paths.lockPath, firstProbe.pid);
    return;
  }
  if (firstProbe.state === "occupied") return;
  const recordedPid = await readHostPid(paths.pidPath);
  if (recordedPid !== undefined && recordedPid !== process.pid && isAlive(recordedPid)) {
    await refreshLockForOwner(paths.lockPath, recordedPid);
    return;
  }
  const starterPid = positiveInteger(process.env.SUBAGENT_MCP_STARTER_PID);
  if (!await acquireHostLock(paths.lockPath, process.pid, starterPid)) return;
  const lockedProbe = await probeHost(paths.socketPath);
  if (lockedProbe.state !== "stale") {
    if (lockedProbe.pid !== undefined) await refreshLockForOwner(paths.lockPath, lockedProbe.pid);
    else await removeOwnedLock(paths.lockPath, process.pid);
    return;
  }
  await rm(paths.socketPath, { force: true }).catch(() => undefined);

  const live = new LiveConfig({ agentsDirectory, modelsFile });
  await live.reload();
  // Sessions, the lock and the usage ledger live in .subagents/memory; keep it out of the user's git.
  await ensureProjectMemoryIgnored(cwd).catch(() => undefined);
  const usage = new UsageLedger(paths.usagePath);
  await usage.load();
  const claude = new ClaudeAdapter();
  const codex = new CodexAdapter();
  const opencode = new OpenCodeAdapter();
  const antigravity = new AntigravityAdapter();
  const cursor = new CursorAdapter();
  let endpoint: RunningHost | undefined;
  const supervisor = new SupervisorClass({
    registry: live,
    adapters: new AdapterRegistry([claude, codex, opencode, antigravity, cursor]),
    cwd,
    usage,
    updateCachePath: join(paths.directory, "update.json"),
    maxConcurrent: live.maxConcurrent(),
    onDetachedSettled: (result) => endpoint?.notify({ event: "detached", data: result }),
  });
  live.watch(() => supervisor.setMaxConcurrent(live.maxConcurrent()));
  supervisor.restore(await readSnapshot(paths.snapshotPath));
  let pending = [];
  try { pending = JSON.parse(await readFile(paths.snapshotPath, 'utf8')).pending ?? []; }
  catch(error) { if (!isErrno(error, 'ENOENT')) throw error; }
  supervisor.enablePersistence(paths.snapshotPath);
  await supervisor.recoverResults();
  supervisor.restorePending(pending);

  const runUpdateCheck = (): void => {
    void checkForUpdate({ memoryDirectory: paths.directory }).catch(() => undefined);
  };
  runUpdateCheck();
  const updateTimer = setInterval(runUpdateCheck, 24 * 60 * 60 * 1_000);
  updateTimer.unref();

  let shuttingDown = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    clearInterval(updateTimer);
    live.close();
    await Promise.all([
      claude.closeAll(),
      codex.closeAll(),
      opencode.closeAll(),
      antigravity.closeAll(),
      cursor.closeAll(),
    ]).catch(() => undefined);
    const ownsPaths = await ownsHostPaths(paths, process.pid);
    // net.Server.close() unlinks Unix sockets, so an orphan must exit without closing a replacement's path.
    if (ownsPaths) await endpoint?.close();
    if (ownsPaths && await ownsHostPaths(paths, process.pid)) {
      await rm(paths.socketPath, { force: true }).catch(() => undefined);
      await removeOwnedLock(paths.lockPath, process.pid);
      if (await readHostPid(paths.pidPath) === process.pid) {
        await rm(paths.pidPath, { force: true }).catch(() => undefined);
      }
    }
    process.exit(0);
  };
  const scheduleIdle = (clients: number): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (clients > 0 || shuttingDown) return;
    idleTimer = setTimeout(() => {
      const { active, waiting } = supervisor.concurrency();
      const liveAgent = supervisor.listAgents().some((agent) => {
        const state = agent["state"];
        return state === "running" || state === "starting" || state === "needs_approval";
      });
      if (active > 0 || waiting > 0 || liveAgent) return;
      void shutdown();
    }, IDLE_EXIT_MS);
  };

  endpoint = await serveHost({
    socketPath: paths.socketPath,
    supervisor,
    onClients: scheduleIdle,
    onShutdown: () => void shutdown(),
  });
  await writeFile(paths.pidPath, `${JSON.stringify({ pid: process.pid, protocol: HOST_PROTOCOL, socketPath: paths.socketPath })}\n`);
  await refreshLockForOwner(paths.lockPath, process.pid);
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

export class HostClient {
  readonly #socket: Socket;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #detached: Array<(data: Readonly<Record<string, unknown>>) => void> = [];
  #buffer = "";
  #nextId = 1;
  #closed = false;
  /** The host's `hello` when this client connected: its build, and whether it was kept as stale or newer. */
  host: HostHello | undefined;

  static connect(socketPath: string, timeoutMs = 5_000): Promise<HostClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to the subagent-mcp host at ${socketPath}`));
      }, timeoutMs);
      const fail = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new HostClient(socket));
      });
      socket.once("error", (error) => fail(error));
    });
  }

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", () => this.#failAll(new Error("subagent-mcp host connection failed")));
    socket.on("close", () => this.#failAll(new Error("subagent-mcp host connection closed")));
  }

  onDetached(listener: (data: Readonly<Record<string, unknown>>) => void): void {
    this.#detached.push(listener);
  }

  call(method: string, params?: unknown, timeoutMs = 0): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("subagent-mcp host connection is closed"));
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (!this.#pending.has(id)) return;
          this.#pending.delete(id);
          reject(new Error(`subagent-mcp host ${method} timed out`));
        }, timeoutMs);
        timer.unref();
      }
    });
    this.#socket.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return response;
  }

  close(): void {
    this.#closed = true;
    this.#socket.end();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (line.trim() === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message)) continue;
      if (message["event"] === "detached" && isRecord(message["data"])) {
        for (const listener of this.#detached) listener(message["data"]);
        continue;
      }
      if (typeof message["id"] !== "number") continue;
      const pending = this.#pending.get(message["id"]);
      if (pending === undefined) continue;
      this.#pending.delete(message["id"]);
      if (isRecord(message["error"])) {
        const text = message["error"]["message"];
        const code = message["error"]["code"];
        // The code leads the message so a model reading only the tool error text still sees it.
        const body = typeof text === "string" ? text : "subagent-mcp host request failed";
        const error = new Error(typeof code === "string" ? `${code}: ${body}` : body) as Error & { code?: string };
        if (typeof code === "string") error.code = code;
        pending.reject(error);
      } else {
        pending.resolve(message["result"]);
      }
    }
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function handleLine(
  socket: Socket,
  line: string,
  supervisor: Supervisor,
  onShutdown: () => void,
  context: DispatchContext,
): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    socket.write(`${JSON.stringify({ id: null, error: { message: "Malformed host request" } })}\n`);
    return;
  }
  if (!isRecord(request) || typeof request["id"] !== "number" || typeof request["method"] !== "string") {
    socket.write(`${JSON.stringify({ id: null, error: { message: "Host request requires id and method" } })}\n`);
    return;
  }
  const id = request["id"];
  const method = request["method"];
  try {
    const result = await dispatch(supervisor, method, request["params"], context);
    socket.write(`${JSON.stringify({ id, result })}\n`);
    if (method === "shutdown") setTimeout(onShutdown, 30);
  } catch (error) {
    const body = error instanceof Error
      ? { message: error.message, ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}) }
      : { message: String(error) };
    socket.write(`${JSON.stringify({ id, error: body })}\n`);
  }
}

/** The build this host process started with (see `buildId`); fixed for the life of the process. */
const HOST_BUILD = buildInfo();

interface DispatchContext {
  /** Clients currently connected to this host. */
  readonly clients: () => number;
}

async function dispatch(supervisor: Supervisor, method: string, params: unknown, context: DispatchContext): Promise<unknown> {
  const input = isRecord(params) ? params : {};
  switch (method) {
    case "hello":
      return {
        protocol: HOST_PROTOCOL,
        pid: process.pid,
        build: HOST_BUILD.build,
        builtAt: HOST_BUILD.builtAt,
        clients: context.clients(),
        ...supervisor.concurrency(),
      };
    case "spawn_agent":
      return supervisor.spawnAgent(input as unknown as SpawnAgentInput);
    case "send_message":
      return supervisor.sendMessage(input as unknown as SendMessageInput);
    case "list_agents":
      return supervisor.sessionView(input as ListAgentsInput);
    case "list_agent_configs": return supervisor.listAgentConfigs();
    case "wait_for_agents": return supervisor.waitForAgents(input.agents as string[], input.mode as 'all' | 'any' | undefined,
      input.timeout_seconds as number | undefined, input.since as string | undefined, input.max_result_chars as number | undefined);
    case "get_agent_result": return supervisor.getAgentResult(requiredString(input, 'agent'), input.turn as number | undefined, input.offset as number | undefined, input.limit as number | undefined);
    case "cleanup_worktree": return supervisor.cleanupWorktree(requiredString(input, 'agent'));
    case "stop_agents": return supervisor.stopAgents(input.agents as string[] | undefined, input.group_id as string | undefined);
    case "stop_agent":
      return supervisor.stopAgent(requiredString(input, "agent"));
    case "resolve_approval": {
      const requestId = requiredString(input, "request_id");
      const decision = requiredDecision(input["decision"]);
      const message = input["message"];
      return typeof message === "string"
        ? supervisor.resolveApproval(requestId, decision, message)
        : supervisor.resolveApproval(requestId, decision);
    }
    case "get_agent_events": {
      const agent = requiredString(input, "agent");
      const since = typeof input["since"] === "number" ? input["since"] : 0;
      if (input["summary"] === true) return supervisor.summarizeAgentEvents(agent, 5, since);
      const types = Array.isArray(input["types"]) ? (input["types"] as NormalizedEventType[]) : undefined;
      const coalesce = input["coalesce"] === true;
      const options: EventReadOptions | undefined =
        types !== undefined || coalesce ? { ...(types !== undefined ? { types } : {}), ...(coalesce ? { coalesce } : {}) } : undefined;
      return typeof input["limit"] === "number"
        ? supervisor.getAgentEvents(agent, since, input["limit"], options)
        : supervisor.getAgentEvents(agent, since, undefined, options);
    }
    case "list_models":
      return supervisor.listModels(
        isBackend(input["backend"]) ? input["backend"] : undefined,
        ...(typeof input["live"] === "boolean" ? [input["live"]] : []),
      );
    case "shutdown": {
      const { active, waiting } = supervisor.concurrency();
      if (active > 0 || waiting > 0) {
        throw new Error("subagent-mcp host still has running agents and will not shut down");
      }
      return { shuttingDown: true };
    }
    default:
      throw new Error(`Unknown host method ${method}`);
  }
}

async function startDaemon(
  options: { readonly cwd: string; readonly agentsDirectory: string; readonly modelsFile: string; readonly scriptPath: string },
  paths: HostPaths,
): Promise<void> {
  const acquired = await acquireHostLock(paths.lockPath, process.pid);
  if (!acquired) return;
  const child = spawn(process.execPath, [options.scriptPath], {
    cwd: options.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SUBAGENT_MCP_HOST: "1",
      SUBAGENT_MCP_STARTER_PID: String(process.pid),
      SUBAGENT_MCP_AGENTS_DIR: options.agentsDirectory,
      SUBAGENT_MCP_MODELS_FILE: options.modelsFile,
    },
  });
  child.unref();
  if (child.pid !== undefined) await writeFile(join(paths.lockPath, "pid"), String(child.pid));
  child.on("error", () => void removeOwnedLock(paths.lockPath, process.pid));
}

async function acquireHostLock(lockPath: string, ownerPid: number, inheritedPid?: number): Promise<boolean> {
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "pid"), String(ownerPid));
    return true;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const pid = await readLockPid(lockPath);
  if (pid === ownerPid || (inheritedPid !== undefined && pid === inheritedPid)) {
    await writeFile(join(lockPath, "pid"), String(ownerPid));
    return true;
  }
  if (pid !== undefined && isAlive(pid)) return false;
  await rm(lockPath, { recursive: true, force: true });
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "pid"), String(ownerPid));
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
}

async function connectCompatibleHost(socketPath: string): Promise<{
  readonly client?: HostClient;
  readonly pid?: number;
  readonly stoppedPid?: number;
}> {
  const client = await HostClient.connect(socketPath, 250).catch(() => undefined);
  if (client === undefined) return {};
  let keep = false;
  try {
    const hello = await client.call("hello", undefined, 2_000) as HostHello;
    const disposition = hostDisposition(hello, buildInfo());
    if (disposition === "keep" || disposition === "stale" || disposition === "newer") {
      keep = true;
      client.host = hello;
      const pid = positiveInteger(hello.pid);
      return { client, ...(pid === undefined ? {} : { pid }) };
    }
    if (disposition === "refuse") {
      throw new Error(
        `subagent-mcp host speaks protocol ${String(hello.protocol)} and still has running agents. ` +
          "Stop those agents, then ask the user to run `/mcp` and then reconnect subagent-mcp.",
      );
    }
    await client.call("shutdown").catch(() => undefined);
    const stoppedPid = positiveInteger(hello.pid);
    return { ...(stoppedPid === undefined ? {} : { stoppedPid }) };
  } finally {
    if (!keep) client.close();
  }
}

async function probeHost(socketPath: string): Promise<{
  readonly state: "live" | "stale" | "occupied";
  readonly pid?: number;
}> {
  let client: HostClient;
  try {
    client = await HostClient.connect(socketPath, 250);
  } catch (error) {
    return { state: isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED") ? "stale" : "occupied" };
  }
  try {
    const hello = await client.call("hello", undefined, 2_000) as { pid?: number };
    const pid = positiveInteger(hello.pid);
    return { state: "live", ...(pid === undefined ? {} : { pid }) };
  } catch {
    return { state: "occupied" };
  } finally {
    client.close();
  }
}

async function liveHostOwner(paths: HostPaths): Promise<{ readonly pid: number; readonly source: string } | undefined> {
  const hostPid = await readHostPid(paths.pidPath);
  if (hostPid !== undefined && isAlive(hostPid)) return { pid: hostPid, source: paths.pidPath };
  const lockPid = await readLockPid(paths.lockPath);
  return lockPid !== undefined && isAlive(lockPid) ? { pid: lockPid, source: join(paths.lockPath, "pid") } : undefined;
}

async function ownsHostPaths(paths: HostPaths, pid: number): Promise<boolean> {
  const hostPid = await readHostPid(paths.pidPath);
  if (hostPid !== undefined && hostPid !== pid && isAlive(hostPid)) return false;
  const lockPid = await readLockPid(paths.lockPath);
  return hostPid === pid || lockPid === pid;
}

async function refreshLockForOwner(lockPath: string, pid: number): Promise<void> {
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "pid"), String(pid));
    return;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const lockPid = await readLockPid(lockPath);
  if (lockPid !== undefined && lockPid !== pid && isAlive(lockPid)) return;
  await writeFile(join(lockPath, "pid"), String(pid));
}

async function removeOwnedLock(lockPath: string, pid: number): Promise<void> {
  if (await readLockPid(lockPath) !== pid) return;
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
  const path = join(lockPath, "pid");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pid = await readPid(path);
    if (pid !== undefined) return pid;
    if (attempt < 2) await delay(20);
  }
  return undefined;
}

async function readHostPid(path: string): Promise<number | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? positiveInteger(parsed["pid"]) : undefined;
  } catch {
    return undefined;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) await delay(25);
}

async function waitForHost(socketPath: string): Promise<HostClient> {
  const deadline = Date.now() + CONNECT_WAIT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const client = await HostClient.connect(socketPath, 300);
      const hello = await client.call("hello", undefined, 2_000) as HostHello;
      if (hello.protocol !== HOST_PROTOCOL) {
        client.close();
        throw new Error(`subagent-mcp host protocol is ${String(hello.protocol)}, this client speaks ${HOST_PROTOCOL}`);
      }
      client.host = hello;
      return client;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `subagent-mcp host did not come up. ${detail} Ask the user to run \`/mcp\` and then reconnect subagent-mcp.`,
  );
}

async function readSnapshot(path: string): Promise<readonly AgentSnapshot[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["agents"])) return [];
    return parsed["agents"].filter(isSnapshot);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    return [];
  }
}

function isSnapshot(value: unknown): value is AgentSnapshot {
  return isRecord(value)
    && typeof value["id"] === "string"
    && typeof value["backend"] === "string"
    && isBackend(value["backend"])
    && typeof value["model"] === "string"
    && typeof value["agentConfig"] === "string"
    && typeof value["cwd"] === "string"
    && typeof value["state"] === "string"
    && typeof value["createdAt"] === "string"
    && typeof value["updatedAt"] === "string";
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined;
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

function requiredDecision(value: unknown): "allow" | "allow_for_session" | "deny" {
  if (value === "allow" || value === "allow_for_session" || value === "deny") return value;
  throw new Error("decision must be allow, allow_for_session, or deny");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
