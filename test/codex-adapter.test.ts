import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CodexAdapter } from "../src/adapters/codex/adapter.js";
import type { ResumeRequest, SpawnRequest } from "../src/adapters/adapter.js";
import type { AgentEvent } from "../src/events/schema.js";

const permission = { allow: [], deny: [], default: "escalate" as const };

interface FakeCodexServer {
  readonly child: ChildProcessWithoutNullStreams;
  /** Every `params` object the fake server received, keyed by JSON-RPC method. */
  readonly received: Record<string, Readonly<Record<string, unknown>>[]>;
}

/** A canned reply: `{ result }`, a JSON-RPC `{ error }`, or `{ silent: true }` to never answer. */
type FakeResponse =
  | { readonly result: Readonly<Record<string, unknown>> }
  | { readonly error: Readonly<Record<string, unknown>> }
  | { readonly silent: true };

/**
 * Minimal fake `codex app-server`: answers `initialize`, `thread/start`, `thread/resume`, and
 * `turn/start` just enough for CodexAdapter.spawn()/resume() to resolve, while recording every
 * request's params so tests can assert on what the adapter actually sent over the wire.
 */
function fakeCodexServer(
  responses: Readonly<Record<string, (params: Readonly<Record<string, unknown>>) => FakeResponse>> = {},
  /**
   * Notifications sent before each turn's `turn/completed`, by 1-based turn number. An entry
   * `{ hold: true }` is not sent; it keeps the turn open (no `turn/completed`).
   */
  turnNotifications: (turnId: string, turnNumber: number) => readonly Readonly<Record<string, unknown>>[] = () => [],
  /** Signals that make the fake process exit (default: none, so it ignores kill like a hung child). */
  exitOn: readonly NodeJS.Signals[] = [],
): FakeCodexServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const signals: NodeJS.Signals[] = [];
  Object.assign(child, {
    stdin, stdout, stderr, exitCode: null, signalCode: null, killed: false, signals,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      const state = child as unknown as { killed: boolean; signalCode: NodeJS.Signals | null };
      state.killed = true;
      signals.push(signal);
      if (exitOn.includes(signal) && state.signalCode === null) {
        state.signalCode = signal;
        setImmediate(() => child.emit("exit", null, signal));
      }
      return true;
    },
  });

  const received: Record<string, Readonly<Record<string, unknown>>[]> = {};
  let threadIdCounter = 0;
  let turnCounter = 0;
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Readonly<Record<string, unknown>> };
      if (message.method === undefined || message.id === undefined) continue; // ignore notifications
      const params = message.params ?? {};
      (received[message.method] ??= []).push(params);
      const reply = (result: Readonly<Record<string, unknown>>): void => {
        stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      };
      const canned = responses[message.method]?.(params);
      if (canned !== undefined) {
        if (!("silent" in canned)) stdout.write(`${JSON.stringify({ id: message.id, ...canned })}\n`);
        continue;
      }
      switch (message.method) {
        case "initialize":
          reply({});
          break;
        case "thread/start":
          reply({ thread: { id: `thread-${++threadIdCounter}` } });
          break;
        case "thread/resume": {
          const threadId = typeof params.threadId === "string" ? params.threadId : `thread-${++threadIdCounter}`;
          reply({ thread: { id: threadId } });
          break;
        }
        case "turn/start": {
          const turnId = `turn-${message.id}`;
          reply({ turn: { id: turnId } });
          // Complete the turn right after, so the test doesn't depend on any of the adapter's
          // internal (deliberately unref'd) timers to observe a terminal state. Deferred to a
          // macrotask so the client has processed turn/start's own response (and recorded
          // currentTurn.id) before the completion notification arrives.
          const planned = turnNotifications(turnId, ++turnCounter);
          const hold = planned.some((notification) => notification.hold === true);
          const notifications = planned.filter((notification) => notification.hold !== true);
          setImmediate(() => {
            for (const notification of notifications) stdout.write(`${JSON.stringify(notification)}\n`);
            if (hold) return;
            stdout.write(`${JSON.stringify({
              method: "turn/completed",
              params: { turn: { id: turnId, status: "completed", items: [] } },
            })}\n`);
          });
          break;
        }
        default:
          reply({});
      }
    }
  });

  return { child, received };
}

async function waitForTurnCompleted(adapter: CodexAdapter, agentId: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 2_000);
  try {
    for await (const event of adapter.events(agentId, { signal: abort.signal }) as AsyncIterable<AgentEvent>) {
      if (event.type === "turn.completed") return;
    }
    throw new Error("Timed out waiting for turn.completed");
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

function spawnRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    prompt: "do the thing",
    description: "fixture delegation",
    model: "gpt-5.6-luna",
    cwd: "/tmp",
    systemPrompt: "",
    env: {},
    permission,
    ...overrides,
  };
}

test("spawn detaches Codex into its own process group", async () => {
  const server = fakeCodexServer();
  let detached: boolean | undefined;
  const adapter = new CodexAdapter({
    spawnProcess: (_command, _args, options) => {
      detached = options.detached;
      return server.child;
    },
    initTimeoutMs: 2_000,
  });
  await adapter.spawn(spawnRequest());
  assert.equal(detached, true);
});

test("spawn() sends reasoningEffort on turn/start when provided", async () => {
  const server = fakeCodexServer();
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  await adapter.spawn(spawnRequest({ reasoningEffort: "xhigh" }));
  assert.equal(server.received["turn/start"]?.length, 1);
  assert.equal(server.received["turn/start"]?.[0]?.reasoningEffort, "xhigh");
});

test("spawn() omits reasoningEffort entirely when not provided", async () => {
  const server = fakeCodexServer();
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  await adapter.spawn(spawnRequest());
  assert.equal(server.received["turn/start"]?.length, 1);
  assert.ok(!("reasoningEffort" in (server.received["turn/start"]?.[0] ?? {})));
});

test("resume() on an existing session sends reasoningEffort on the new turn/start", async () => {
  const server = fakeCodexServer();
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const spawned = await adapter.spawn(spawnRequest());
  // Wait for the fake server's completion notification so the session is terminal and resume()
  // takes the "existing session" branch instead of throwing "already has an active turn".
  await waitForTurnCompleted(adapter, spawned.agentId);

  const resumeRequest: ResumeRequest = {
    agentId: spawned.agentId,
    prompt: "follow up",
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    systemPrompt: "",
    env: {},
    permission,
    reasoningEffort: "low",
  };
  await adapter.resume(resumeRequest);
  assert.equal(server.received["turn/start"]?.length, 2);
  assert.equal(server.received["turn/start"]?.[1]?.reasoningEffort, "low");
});

test("providerInfo summarizes the catalog, plan rate limits and account usage without identifiers", async () => {
  const server = fakeCodexServer({
    "model/list": (params) => (params.cursor === undefined
      ? { result: { data: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Workhorse", isDefault: true, hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" }], nextCursor: "page2" } }
      : { result: { data: [{ id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", hidden: true }], nextCursor: null } }),
    "account/rateLimits/read": () => ({ result: {
      accountId: "acct_secret",
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: "codex" },
      rateLimitsByLimitId: { codex: {
        limitId: "codex", planType: "plus", rateLimitReachedType: null, spendControlReached: false,
        primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1_794_175_661 },
        secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_794_692_335 },
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      } },
      rateLimitResetCredits: { availableCount: 2, credits: [{ id: "RateLimitResetCredit_secret" }] },
    } }),
    "account/usage/read": () => ({ result: {
      summary: { lifetimeTokens: 500, peakDailyTokens: 90 },
      dailyUsageBuckets: Array.from({ length: 9 }, (_, day) => ({ startDate: `2026-11-0${day + 1}`, tokens: day })),
    } }),
    "account/read": () => ({ result: { account: { type: "chatgpt", email: "someone@example.com", planType: "plus" },
      workspaceRouting: { chatgptAccountId: "acct_secret" } } }),
  }, () => [], ["SIGTERM"]);
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const info = await adapter.providerInfo();

  assert.deepEqual(info["auth"], { mode: "chatgpt", plan: "plus" });
  assert.equal(info["default_model"], "gpt-6.1-sol");
  assert.deepEqual(info.models, [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", description: "Workhorse", default: true, reasoning_efforts: ["low", "high"], default_effort: "low" },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", hidden: true },
  ]);
  assert.deepEqual(server.received["model/list"]?.map((params) => params.cursor), [undefined, "page2"]);
  assert.equal(server.received["model/list"]?.[0]?.includeHidden, true);
  assert.deepEqual(info["usage_limits"], {
    plan: "plus",
    usage_allowed: true,
    limits: { codex: {
      primary: { percent_used: 21, remaining_percent: 79, window_minutes: 300, resets_at: new Date(1_794_175_661_000).toISOString() },
      secondary: { percent_used: 8, remaining_percent: 92, window_minutes: 10_080, resets_at: new Date(1_794_692_335_000).toISOString() },
      limited: false,
      credits: { has_credits: false, unlimited: false, balance: "0" },
    } },
    reset_credits_available: 2,
  });
  const usage = info["account_usage"] as { lifetime_tokens: number; recent_daily_tokens: { date: string }[] };
  assert.equal(usage.lifetime_tokens, 500);
  assert.equal(usage.recent_daily_tokens.length, 7);
  assert.equal(usage.recent_daily_tokens.at(-1)?.date, "2026-11-09");
  const text = JSON.stringify(info);
  assert.equal(text.includes("secret") || text.includes("@example.com"), false);
  assert.equal(info["errors"], undefined);
  assert.equal((server.child as unknown as { killed: boolean }).killed, true, "the probe app-server is shut down");
});

test("providerInfo keeps the catalog when plan limits are unavailable (API-key auth)", async () => {
  const server = fakeCodexServer({
    "model/list": () => ({ result: { data: [{ id: "gpt-6.1-sol", isDefault: true }] } }),
    "account/rateLimits/read": () => ({ error: { code: -32600, message: "codex account authentication required to read rate limits" } }),
    "account/read": () => ({ result: { account: null } }),
  }, () => [], ["SIGTERM"]);
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const info = await adapter.providerInfo();
  assert.deepEqual(info.models, [{ id: "gpt-6.1-sol", default: true }]);
  assert.deepEqual(info["auth"], { mode: "none" });
  assert.match(String((info["errors"] as Record<string, string>)["usage_limits"]), /authentication required/);
});

test("turn usage is the turn's own tokens, not the thread's running total", async () => {
  // Counts from a live two-turn gpt-5.6-luna thread; turn 3 makes two model calls.
  const breakdown = (input: number, output: number, cached: number) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached });
  // Codex's inputTokens includes cached reads, so new input is the difference.
  const expected = (input: number, output: number, cached: number) => ({ ...breakdown(input, output, cached), uncachedInputTokens: input - cached });
  const updates: Record<number, [ReturnType<typeof breakdown>, ReturnType<typeof breakdown>][]> = {
    1: [[breakdown(18_547, 5, 11_264), breakdown(18_547, 5, 11_264)]],
    2: [[breakdown(37_113, 10, 29_696), breakdown(18_566, 5, 18_432)]],
    3: [[breakdown(37_213, 12, 29_696), breakdown(100, 2, 0)], [breakdown(37_363, 15, 29_746), breakdown(150, 3, 50)]],
  };
  const server = fakeCodexServer({}, (turnId, turnNumber) => (updates[turnNumber] ?? []).map(([total, last]) => ({
    method: "thread/tokenUsage/updated",
    params: { turnId, tokenUsage: { total, last } },
  })));
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const usageOf = async (agentId: string, since: number): Promise<unknown> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2_000);
    try {
      for await (const event of adapter.events(agentId, { since, signal: abort.signal }) as AsyncIterable<AgentEvent>) {
        if (event.type === "turn.completed") return (event.data as { usage?: unknown }).usage;
      }
      throw new Error("Timed out waiting for turn.completed");
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  };
  const resume = (agentId: string): ResumeRequest => ({ agentId, prompt: "again", cwd: "/tmp", model: "gpt-5.6-luna", systemPrompt: "", env: {}, permission });

  const { agentId } = await adapter.spawn(spawnRequest());
  assert.deepEqual(await usageOf(agentId, 0), expected(18_547, 5, 11_264));
  let since = adapter.buffer.read(agentId).currentSequence;
  await adapter.resume(resume(agentId));
  assert.deepEqual(await usageOf(agentId, since), expected(18_566, 5, 18_432));
  since = adapter.buffer.read(agentId).currentSequence;
  await adapter.resume(resume(agentId));
  assert.deepEqual(await usageOf(agentId, since), expected(250, 5, 50), "both model calls of turn 3, nothing from earlier turns");
  const live = adapter.buffer.read(agentId, since).events.filter((event) => event.type === "usage.updated");
  assert.deepEqual(live.map((event) => (event.data as { usage: unknown }).usage), [expected(100, 2, 0), expected(250, 5, 50)]);
});

/** The adapter's grace timers are unref'd (a real child process keeps the loop alive); a fake child
 * does not, so hold the loop open while a test waits on them. */
async function withLoopHeld<T>(body: () => Promise<T>): Promise<T> {
  const held = setInterval(() => undefined, 25);
  try {
    return await body();
  } finally {
    clearInterval(held);
  }
}

const tokenUpdate = (turnId: string, total?: Record<string, number>, last?: Record<string, number>) => ({
  method: "thread/tokenUsage/updated",
  params: { turnId, tokenUsage: { ...(total === undefined ? {} : { total }), ...(last === undefined ? {} : { last }) } },
});
const counts = (input: number, output: number, cached: number) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached });

async function turnEvents(adapter: CodexAdapter, agentId: string, since: number): Promise<readonly AgentEvent[]> {
  await waitForTurnCompleted(adapter, agentId);
  await new Promise((resolve) => setImmediate(resolve)); // let any trailing notifications land
  return adapter.buffer.read(agentId, since).events;
}

test("a token update arriving after turn/completed does not reopen the turn", async () => {
  const server = fakeCodexServer({}, (turnId) => [tokenUpdate(turnId, counts(100, 5, 0), counts(100, 5, 0))]);
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const { agentId, turnId } = await adapter.spawn(spawnRequest());
  await waitForTurnCompleted(adapter, agentId);
  (server.child.stdout as PassThrough).write(`${JSON.stringify(tokenUpdate(turnId, counts(180, 9, 0), counts(80, 4, 0)))}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const events = adapter.buffer.read(agentId).events;
  const completedAt = events.findIndex((event) => event.type === "turn.completed");
  assert.equal(events.slice(completedAt + 1).some((event) => event.type === "usage.updated"), false);
});

test("a late update after turn/completed still advances the thread baseline for the next turn's no-`last` fallback", async () => {
  const server = fakeCodexServer({}, (turnId, turn) => turn === 1
    ? [tokenUpdate(turnId, counts(100, 5, 0), counts(100, 5, 0))]
    : [tokenUpdate(turnId, counts(230, 12, 0))]); // no `last`: charged against the previous total
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const { agentId, turnId } = await adapter.spawn(spawnRequest());
  await waitForTurnCompleted(adapter, agentId);
  (server.child.stdout as PassThrough).write(`${JSON.stringify(tokenUpdate(turnId, counts(180, 9, 0), counts(80, 4, 0)))}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const since = adapter.buffer.read(agentId).currentSequence;
  await adapter.resume({ agentId, prompt: "again", cwd: "/tmp", model: "gpt-5.6-luna", systemPrompt: "", env: {}, permission });
  const second = await turnEvents(adapter, agentId, since);
  assert.deepEqual((second.find((event) => event.type === "turn.completed")?.data as { usage?: unknown }).usage,
    { ...counts(50, 3, 0), uncachedInputTokens: 50 }, "230 - 180, not 230 - 100");
});

test("without `last`, the previous total is the baseline; with neither, usage is left unreported", async () => {
  const server = fakeCodexServer({}, (turnId, turn) => turn === 1
    ? [tokenUpdate(turnId, counts(100, 5, 0))] // no `last`, nothing seen before: unknown
    : [tokenUpdate(turnId, counts(160, 8, 10))]); // no `last`, but turn 1's total was seen
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const { agentId } = await adapter.spawn(spawnRequest());
  const first = await turnEvents(adapter, agentId, 0);
  assert.equal(first.some((event) => event.type === "usage.updated"), false, "no misleading zero");
  assert.equal((first.find((event) => event.type === "turn.completed")?.data as { usage?: unknown }).usage, undefined);
  const since = adapter.buffer.read(agentId).currentSequence;
  await adapter.resume({ agentId, prompt: "again", cwd: "/tmp", model: "gpt-5.6-luna", systemPrompt: "", env: {}, permission });
  const second = await turnEvents(adapter, agentId, since);
  assert.deepEqual((second.find((event) => event.type === "turn.completed")?.data as { usage?: unknown }).usage,
    { ...counts(60, 3, 10), uncachedInputTokens: 50 });
});

test("a thread resumed in a new process counts only the new turn", async () => {
  // A fresh adapter has seen nothing of the thread; the first update's total includes earlier turns.
  const server = fakeCodexServer({}, (turnId) => [tokenUpdate(turnId, counts(37_113, 10, 29_696), counts(18_566, 5, 18_432))]);
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const { agentId } = await adapter.resume({ agentId: "thread-old", prompt: "again", cwd: "/tmp", model: "gpt-5.6-luna", systemPrompt: "", env: {}, permission });
  const events = await turnEvents(adapter, agentId, 0);
  assert.deepEqual((events.find((event) => event.type === "turn.completed")?.data as { usage?: unknown }).usage,
    { ...counts(18_566, 5, 18_432), uncachedInputTokens: 134 });
});

test("an interrupted turn keeps the usage observed before the interrupt", async () => {
  await withLoopHeld(async () => {
  const server = fakeCodexServer({}, (turnId) => [tokenUpdate(turnId, counts(20, 2, 0), counts(20, 2, 0)), { hold: true }]);
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000, interruptGraceMs: 30 });
  const { agentId } = await adapter.spawn(spawnRequest());
  await new Promise((resolve) => setTimeout(resolve, 20));
  await adapter.interrupt(agentId);
  const completed = adapter.buffer.read(agentId).events.find((event) => event.type === "turn.completed");
  assert.equal((completed?.data as { status: string }).status, "interrupted");
  assert.deepEqual((completed?.data as { usage?: unknown }).usage, { ...counts(20, 2, 0), uncachedInputTokens: 20 });
  });
});

test("providerInfo: a hung section times out on its own and a child ignoring SIGTERM is killed", async () => {
  await withLoopHeld(async () => {
  const server = fakeCodexServer({
    "model/list": () => ({ result: { data: [{ id: "gpt-6.1-sol", isDefault: true }] } }),
    "account/usage/read": () => ({ silent: true }), // never answers
    "account/read": () => ({ result: { account: { type: "chatgpt", planType: "plus" } } }),
  }, () => [], ["SIGKILL"]);
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000, liveSectionTimeoutMs: 50, probeReapGraceMs: 30 });
  const info = await adapter.providerInfo();
  assert.deepEqual(info.models, [{ id: "gpt-6.1-sol", default: true }], "the other sections still come back");
  assert.match(String((info["errors"] as Record<string, string>)["account_usage"]), /timed out/);
  assert.deepEqual((server.child as unknown as { signals: string[] }).signals, ["SIGTERM", "SIGKILL"]);
  });
});
