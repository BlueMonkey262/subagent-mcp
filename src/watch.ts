import { open, stat } from "node:fs/promises";

import { HostClient, hostPaths } from "./host.js";

/**
 * One line of `.subagents/memory/sessions.json.results.jsonl`: a turn that settled. The file is
 * append-only; a turn can appear more than once (a provisional entry on a fatal error, then the
 * complete one), and the last line for an `agent_id` and `turn` wins. Fields are only ever added.
 */
export interface ResultEntry {
  readonly agent_id: string;
  /** Absent on entries written by older versions. */
  readonly name?: string;
  readonly turn: number;
  readonly turn_id?: string;
  readonly status: string;
  readonly finished_at?: string;
  readonly result?: string;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly structured_result?: unknown;
  readonly validation_errors?: unknown;
  readonly [key: string]: unknown;
}

export function resultsLogPath(cwd: string): string {
  return `${hostPaths(cwd).snapshotPath}.results.jsonl`;
}

export function parseResultLine(line: string): ResultEntry | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const entry = value as Record<string, unknown>;
    if (typeof entry["agent_id"] !== "string" || typeof entry["status"] !== "string") return undefined;
    return entry as ResultEntry;
  } catch {
    return undefined;
  }
}

/** The short form `events` prints: who settled, how, and the start of the result. */
export function summarizeEntry(entry: ResultEntry, maxResultChars: number): Readonly<Record<string, unknown>> {
  const error = entry.error;
  return {
    ...(entry.name === undefined ? {} : { name: entry.name }),
    agent_id: entry.agent_id,
    turn: entry.turn,
    status: entry.status,
    ...(entry.finished_at === undefined ? {} : { finished_at: entry.finished_at }),
    ...(error === undefined ? {} : { error: { code: error["code"], message: error["message"] } }),
    ...(typeof entry.result === "string" && maxResultChars > 0 ? { result: cap(entry.result, maxResultChars) } : {}),
  };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

export interface FollowOptions {
  /** Read existing lines first (else start at the current end of the file). */
  readonly fromStart?: boolean;
  /** Keep reading as lines are appended, until `signal` aborts. */
  readonly follow?: boolean;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
}

/**
 * Every result entry in the log, then (with `follow`) each one appended later. Polls the file's
 * size, so it works on any filesystem and survives the file not existing yet or being replaced.
 */
export async function* readResults(path: string, options: FollowOptions = {}): AsyncGenerator<ResultEntry> {
  const pollMs = options.pollMs ?? 500;
  let offset = options.fromStart === true ? 0 : await size(path);
  let partial = "";
  for (;;) {
    if (options.signal?.aborted) return;
    const end = await size(path);
    if (end < offset) { offset = 0; partial = ""; } // truncated or replaced: start over
    if (end > offset) {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(end - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        partial += buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const entry = parseResultLine(line);
        if (entry !== undefined) yield entry;
      }
    }
    if (options.follow !== true) return;
    await sleep(pollMs, options.signal);
  }
}

async function size(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** `subagent-mcp wait` exit codes. */
export const WAIT_EXIT = {
  completed: 0,
  error: 1,
  /** Every agent settled, and at least one failed or was interrupted. */
  unsuccessful: 2,
  /** An agent is waiting for `resolve_approval`. */
  needsApproval: 3,
  timedOut: 124,
} as const;

/** What `wait` needs from a host connection: the `wait_for_agents` call. */
export interface WaitHost {
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  readonly closed: boolean;
  close(): void;
}

export interface WaitOptions {
  readonly cwd: string;
  readonly agents: readonly string[];
  readonly mode?: "all" | "any";
  /** Give up after this many seconds (default: wait as long as it takes). */
  readonly timeoutSeconds?: number;
  readonly maxResultChars?: number;
  /** Prints one JSON line per agent when the wait ends. */
  readonly write: (line: string) => void;
  /** Connects to this project's host; undefined when none is running. */
  readonly connect?: () => Promise<WaitHost | undefined>;
  /** How long to keep trying to reach a host that went away (a restart) before reading the log. */
  readonly reconnectMs?: number;
  readonly now?: () => number;
}

/** Not settled yet: an agent's turn in progress, or a queued task that has not started. */
const STILL_GOING = new Set(["starting", "running", "queued"]);

/**
 * Block until the agents settle (or one needs approval), using the host's `wait_for_agents` in
 * 60-second rounds. Run in the background, its exit is the wake-up signal for clients without
 * Claude Code channels, such as the desktop app. Returns the process exit code.
 */
export async function waitForAgentsCommand(options: WaitOptions): Promise<number> {
  const connect = options.connect ?? (() => connectExisting(options.cwd));
  const now = options.now ?? Date.now;
  const deadline = options.timeoutSeconds === undefined ? undefined : now() + options.timeoutSeconds * 1000;
  const reconnectMs = options.reconnectMs ?? 30_000;
  let host = await connect();
  let lostAt: number | undefined;
  try {
    for (;;) {
      if (host === undefined || host.closed) {
        host?.close();
        lostAt ??= now();
        host = await connect();
        if (host === undefined) {
          if (now() - lostAt < reconnectMs) { await sleep(1_000); continue; }
          return await fromLog(options);
        }
      }
      lostAt = undefined;
      const remaining = deadline === undefined ? 60 : Math.max(0, Math.min(60, (deadline - now()) / 1000));
      let response: unknown;
      try {
        response = await host.call("wait_for_agents", {
          agents: options.agents,
          mode: options.mode ?? "all",
          timeout_seconds: remaining,
          max_result_chars: Math.max(1, options.maxResultChars ?? 2_000),
        }, (remaining + 15) * 1000);
      } catch (error) {
        if (host.closed) continue; // the host restarted mid-wait: reconnect and wait again
        throw error;
      }
      const result = response as { timed_out?: boolean; agents?: readonly Readonly<Record<string, unknown>>[] };
      const agents = result.agents ?? [];
      if (result.timed_out === true) {
        if (deadline !== undefined && now() >= deadline) {
          report(options, agents);
          return WAIT_EXIT.timedOut;
        }
        continue;
      }
      report(options, agents);
      return exitFor(agents.map(stateOf));
    }
  } catch (error) {
    options.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    return WAIT_EXIT.error;
  } finally {
    host?.close();
  }
}

/** Judged on the agents that settled; with mode "any" the others may still be running. */
function exitFor(states: readonly string[]): number {
  if (states.includes("needs_approval")) return WAIT_EXIT.needsApproval;
  const settled = states.filter((state) => !STILL_GOING.has(state));
  return settled.every((state) => state === "completed") ? WAIT_EXIT.completed : WAIT_EXIT.unsuccessful;
}

/** An agent record reports `status`; a queued task that has not started reports `state`. */
function stateOf(agent: Readonly<Record<string, unknown>>): string {
  return String(agent["status"] ?? agent["state"]);
}

/** `capResults` for log entries; the host already caps what wait_for_agents returns. */
function report(options: WaitOptions, agents: readonly Readonly<Record<string, unknown>>[], capResults = false): void {
  const max = options.maxResultChars ?? 2_000;
  for (const agent of agents) {
    const state = stateOf(agent);
    const result = agent["result"];
    const error = agent["error"] as Readonly<Record<string, unknown>> | null | undefined;
    options.write(JSON.stringify({
      ...(agent["name"] === undefined ? {} : { name: agent["name"] }),
      agent_id: agent["agent_id"] ?? agent["id"],
      state,
      ...(error === undefined || error === null ? {} : { error: { code: error["code"], message: error["message"] } }),
      ...(state === "needs_approval" ? { approval: {
        request_id: agent["request_id"], tool_name: agent["tool_name"], command: agent["command"], reason: agent["reason"],
      } } : {}),
      ...(typeof result === "string" && max > 0 ? { result: capResults ? cap(result, max) : result } : {}),
    }));
  }
}

/** No host is running, so nothing is: each agent's last logged turn is its final state. */
async function fromLog(options: WaitOptions): Promise<number> {
  const last = new Map<string, ResultEntry>();
  for await (const entry of readResults(resultsLogPath(options.cwd), { fromStart: true })) {
    last.set(entry.agent_id, entry);
    if (entry.name !== undefined) last.set(entry.name, entry);
  }
  const found = options.agents.map((agent) => last.get(agent));
  const missing = options.agents.filter((_, index) => found[index] === undefined);
  if (missing.length > 0) {
    options.write(JSON.stringify({ error: `No subagent-mcp host is running for ${options.cwd}, and ${missing.join(", ")} has no recorded result` }));
    return WAIT_EXIT.error;
  }
  report(options, found.map((entry) => ({ ...entry! })), true);
  return exitFor(found.map((entry) => entry!.status));
}

async function connectExisting(cwd: string): Promise<WaitHost | undefined> {
  return HostClient.connect(hostPaths(cwd).socketPath, 1_000).catch(() => undefined);
}
