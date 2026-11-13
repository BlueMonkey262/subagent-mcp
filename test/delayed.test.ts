import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter, type FakeStep } from "../src/adapters/fake.js";
import { ConfigRegistry, defaultServerLimits } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { hasLiveWork, HostClient, hostPaths, serveHost, type RunningHost } from "../src/host.js";
import { Supervisor, type NotifyMode } from "../src/supervisor.js";

const permission = { allow: [], deny: [], default: "escalate" as const };
const spawn = { agent: "general", prompt: "hello", description: "test", run_in_background: true };

function testRegistry(limits = defaultServerLimits()): ConfigRegistry {
  const agent: AgentConfig = {
    name: "general",
    backend: "codex",
    model: "fake-model",
    description: "General agent",
    systemPrompt: "",
    permission,
    env: {},
    sourcePath: "test-fixture",
  };
  const roster: ModelRoster = {
    claude: [],
    codex: [{ name: "fake-model" }],
    opencode: [],
    antigravity: [],
    cursor: [],
  };
  return new ConfigRegistry([agent], roster, limits);
}

function fixture(options: { settled?: Readonly<Record<string, unknown>>[]; limits?: ReturnType<typeof defaultServerLimits> } = {}) {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry(options.limits),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
    ...(options.settled === undefined ? {} : { onDetachedSettled: (result) => options.settled!.push(result) }),
  });
  return { adapter, supervisor, settled: options.settled ?? [] };
}

/** Let async spawn/pump work settle without using the (possibly mocked) timers. */
async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Poll with setImmediate only, so it also works while fake timers are installed. */
async function flushUntil(predicate: () => boolean, rounds = 200): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function completeScript(status: "completed" | "failed", finalText?: string): readonly FakeStep[] {
  return [{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status, ...(finalText === undefined ? {} : { finalText }) },
    }),
  }];
}

test("delay_seconds and start_at start at the right time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { supervisor, adapter } = fixture();
  const now = Date.now();

  const delayed = await supervisor.spawnAgent({ ...spawn, delay_seconds: 60 });
  assert.equal(delayed["status"], "queued");
  assert.equal(delayed["task_id"], delayed["agent_id"]);
  assert.equal(delayed["start_at"], new Date(now + 60_000).toISOString());
  assert.equal(adapter.spawnRequests.length, 0);

  t.mock.timers.tick(59_000);
  await flush();
  assert.equal(adapter.spawnRequests.length, 0, "not before its start time");

  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(adapter.spawnRequests.length, 1, "starts at its start time");

  const at = new Date(Date.now() + 30_000).toISOString();
  const scheduled = await supervisor.spawnAgent({ ...spawn, start_at: at });
  assert.equal(scheduled["start_at"], at);
  assert.equal(adapter.spawnRequests.length, 1);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(adapter.spawnRequests.length, 2);
});

test("start_at and delay_seconds reject both-together, the past, and over 7 days", async () => {
  const { supervisor, adapter } = fixture();
  await assert.rejects(
    supervisor.spawnAgent({
      ...spawn,
      start_at: new Date(Date.now() + 60_000).toISOString(),
      delay_seconds: 60,
    }),
    /exactly one of start_at or delay_seconds/,
  );
  await assert.rejects(
    supervisor.spawnAgent({ ...spawn, start_at: new Date(Date.now() - 1_000).toISOString() }),
    /start_at must be in the future/,
  );
  await assert.rejects(supervisor.spawnAgent({ ...spawn, delay_seconds: 0 }), /positive integer/);
  await assert.rejects(supervisor.spawnAgent({ ...spawn, delay_seconds: 604_801 }), /at most 7 days/);
  await assert.rejects(
    supervisor.spawnAgent({ ...spawn, start_at: new Date(Date.now() + 8 * 86_400_000).toISOString() }),
    /at most 7 days/,
  );
  await assert.rejects(supervisor.spawnAgent({ ...spawn, notify: "sometimes" as NotifyMode }), /notify must be/);
  assert.equal(adapter.spawnRequests.length, 0);
});

test("stop before the start time cancels the scheduled task", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { supervisor, adapter } = fixture();
  const task = await supervisor.spawnAgent({ ...spawn, delay_seconds: 60 });
  const taskId = String(task["task_id"]);

  await supervisor.stopAgents([taskId]);
  assert.equal(supervisor.getAgentResult(taskId)?.state, "interrupted");
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(adapter.spawnRequests.length, 0, "the cancelled timer never fires a spawn");
});

test("list_agents shows start_at and notify on queued rows", async () => {
  const { supervisor } = fixture();
  const task = await supervisor.spawnAgent({ ...spawn, delay_seconds: 60, notify: "on_failure" });
  const taskId = String(task["task_id"]);
  const listed = supervisor.listAgents().find((agent) => agent["agent_id"] === taskId);
  assert.equal(listed?.["state"], "queued");
  assert.equal(listed?.["start_at"], task["start_at"]);
  assert.equal(listed?.["notify"], "on_failure");
  await supervisor.stopAgents([taskId]);
});

test("restore re-arms a future scheduled task", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const path = join(await mkdtemp(join(tmpdir(), "delayed-restore-")), "sessions.json");
  const first = fixture();
  first.supervisor.enablePersistence(path);
  const task = await first.supervisor.spawnAgent({ ...spawn, delay_seconds: 60 });
  const saved = JSON.parse(await readFile(path, "utf8")) as { version: number; pending: unknown[] };
  assert.equal(saved.version, 1, "additive fields keep snapshot version 1");
  await first.supervisor.stopAgents([String(task["task_id"])]);

  const restarted = fixture();
  restarted.supervisor.restorePending(saved.pending as never);
  assert.equal(restarted.supervisor.hasPendingWork(), true);
  assert.equal(restarted.adapter.spawnRequests.length, 0);
  t.mock.timers.tick(59_000);
  await flush();
  assert.equal(restarted.adapter.spawnRequests.length, 0);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(restarted.adapter.spawnRequests.length, 1);
});

test("a restore beyond Node's timer limit re-arms instead of firing early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { supervisor, adapter } = fixture();
  const start = new Date(Date.now() + 25 * 86_400_000).toISOString();
  supervisor.restorePending([restoredTask(start)] as never);

  t.mock.timers.tick(2 ** 31 - 1);
  await flush();
  assert.equal(adapter.spawnRequests.length, 0, "the first chunk only re-arms the timer");

  t.mock.timers.tick(Date.parse(start) - Date.now());
  await flush();
  assert.equal(adapter.spawnRequests.length, 1, "the second chunk starts it at the right time");
  await supervisor.stopAgents(["task-restored"]);
});

test("the offline ping queue is bounded and flushed at most once", async () => {
  const { supervisor } = fixture();
  const pings = Array.from({ length: 150 }, (_, index) => ({ agent_id: `agent-${index}`, status: "completed" }));
  supervisor.restoreUndeliveredPings(pings);

  const delivered: Readonly<Record<string, unknown>>[] = [];
  assert.equal(await supervisor.flushUndeliveredPings((ping) => delivered.push(ping)), 100);
  assert.equal(delivered[0]?.["agent_id"], "agent-50", "the oldest pings are dropped");
  assert.equal(await supervisor.flushUndeliveredPings((ping) => delivered.push(ping)), 0, "a flush is at most once");
});

function restoredTask(startAt: string, id = "task-restored"): Record<string, unknown> {
  return {
    id,
    created_at: new Date().toISOString(),
    input: { agent: "general", prompt: "restored", description: "restored", backend: "codex", notify: "always" },
    dependencies: [],
    state: "queued",
    start_at: startAt,
    notify: "always",
  };
}

test("restore past the grace window blocks with MISSED_START; within it starts immediately", async () => {
  const settled: Readonly<Record<string, unknown>>[] = [];
  const late = fixture({ settled });
  const lateId = "task-missed-start";
  late.supervisor.restorePending([
    restoredTask(new Date(Date.now() - 2 * 3_600_000).toISOString(), lateId),
  ] as never);
  await flush();
  const blocked = late.supervisor.getAgentResult(lateId) as Record<string, unknown>;
  assert.equal(blocked["state"], "blocked");
  const result = blocked["result"] as Record<string, unknown>;
  assert.equal(result["missed_start"], true);
  assert.equal((result["error"] as { code: string }).code, "MISSED_START");
  assert.equal(late.adapter.spawnRequests.length, 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.["status"], "blocked");

  const within = fixture();
  within.supervisor.restorePending([
    restoredTask(new Date(Date.now() - 10 * 60_000).toISOString(), "task-within-grace"),
  ] as never);
  await flush();
  assert.equal(within.adapter.spawnRequests.length, 1, "a small overshoot starts immediately");
});

test("notify policy matrix for completed/failed, and needs_approval always pings", async () => {
  const expected: Record<NotifyMode, Record<"completed" | "failed", number>> = {
    always: { completed: 1, failed: 1 },
    on_failure: { completed: 0, failed: 1 },
    never: { completed: 0, failed: 0 },
  };
  for (const notify of ["always", "on_failure", "never"] as const) {
    for (const status of ["completed", "failed"] as const) {
      const settled: Readonly<Record<string, unknown>>[] = [];
      const { supervisor, adapter } = fixture({ settled });
      adapter.queueScript(completeScript(status));
      const spawned = await supervisor.spawnAgent({ ...spawn, notify });
      await waitUntil(() => supervisor.listAgents().some((agent) =>
        agent["agent_id"] === spawned["agent_id"] && agent["state"] === status));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled.length, expected[notify][status], `${notify}/${status}`);
    }
  }

  const settled: Readonly<Record<string, unknown>>[] = [];
  const { supervisor, adapter } = fixture({ settled });
  adapter.queueScript([{
    create: (context) => ({
      type: "approval.requested",
      agentId: context.agentId,
      backend: context.backend,
      data: {
        requestId: "req-delayed",
        agentId: context.agentId,
        backend: "codex" as const,
        toolName: "Bash",
        input: { command: "npm test" },
        command: "npm test",
        cwd: "/work",
        requestedAt: new Date().toISOString(),
      },
    }),
  }]);
  const spawned = await supervisor.spawnAgent({ ...spawn, notify: "never" });
  await waitUntil(() => settled.length === 1);
  assert.equal(settled[0]?.["status"], "needs_approval");
  await supervisor.stopAgent(String(spawned["agent_id"]));
});

test("notify survives a snapshot round-trip and a send_message resume", async () => {
  const firstSettled: Readonly<Record<string, unknown>>[] = [];
  const first = fixture({ settled: firstSettled });
  first.adapter.queueScript(completeScript("completed", "first"));
  const spawned = await first.supervisor.spawnAgent({ ...spawn, notify: "never" });
  const agentId = String(spawned["agent_id"]);
  await waitUntil(() => first.supervisor.listAgents().some((agent) =>
    agent["agent_id"] === agentId && agent["state"] === "completed"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(firstSettled.length, 0, "never suppresses the first completion");

  const snapshot = first.supervisor.exportSnapshot();
  assert.equal(snapshot[0]?.meta?.notify, "never");

  const secondSettled: Readonly<Record<string, unknown>>[] = [];
  const second = fixture({ settled: secondSettled });
  second.supervisor.restore(snapshot);
  second.adapter.seed(agentId);

  second.adapter.queueScript(completeScript("completed", "second"));
  await second.supervisor.sendMessage({ agent: agentId, prompt: "again", run_in_background: true });
  await waitUntil(() => second.supervisor.listAgents().some((agent) =>
    agent["agent_id"] === agentId && agent["state"] === "completed"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondSettled.length, 0, "the restored policy still suppresses completion");

  second.adapter.queueScript(completeScript("completed", "third"));
  await second.supervisor.sendMessage({ agent: agentId, prompt: "again", run_in_background: true, notify: "always" });
  await waitUntil(() => secondSettled.length === 1);
  assert.equal(secondSettled[0]?.["result"], "third");
});

test("depends_on plus start_at waits for both the clock and the prerequisite", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { supervisor, adapter } = fixture();
  adapter.queueScript([]);
  const dependency = String((await supervisor.spawnAgent(spawn))["agent_id"]);
  const queued = await supervisor.spawnAgent({ ...spawn, depends_on: [dependency], delay_seconds: 60 });

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(adapter.spawnRequests.length, 1, "the clock alone does not launch it");

  adapter.queueScript(completeScript("completed", "done"));
  adapter.emit(dependency, "turn.completed", { turnId: "dependency", status: "completed", finalText: "ready" });
  await flush();
  assert.equal(adapter.spawnRequests.length, 2, "both conditions are met");
  await flushUntil(() => supervisor.listAgents().some((agent) =>
    agent["queued_from"] === queued["task_id"] && agent["state"] === "completed"));
});

test("the host keeps running while a delayed task is queued", async () => {
  const { supervisor } = fixture();
  const task = await supervisor.spawnAgent({ ...spawn, delay_seconds: 60 });
  assert.equal(hasLiveWork(supervisor), true, "a queued scheduled task keeps the host alive");
  await supervisor.stopAgents([String(task["task_id"])]);
  assert.equal(hasLiveWork(supervisor), false, "cancelling it lets the host idle out");
});

test("pings with no client are queued, persisted, and flushed on the next connect", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "delayed-offline-ping-"));
  const snapshotPath = join(cwd, "sessions.json");
  const paths = hostPaths(cwd);
  const adapter = new FakeAdapter("codex");
  let endpoint: RunningHost | undefined;
  const supervisor = new Supervisor({
    registry: testRegistry(),
    adapters: new AdapterRegistry([adapter]),
    cwd,
    onDetachedSettled: (result) => {
      if (endpoint !== undefined && endpoint.clients > 0) endpoint.notify({ event: "detached", data: result });
      else void supervisor.enqueueUndeliveredPing(result);
    },
  });
  supervisor.enablePersistence(snapshotPath);
  endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  let client: HostClient | undefined;
  try {
    adapter.queueScript(completeScript("completed", "offline result"));
    const spawned = await supervisor.spawnAgent(spawn);
    await waitUntil(() => supervisor.listAgents().some((agent) =>
      agent["agent_id"] === spawned["agent_id"] && agent["state"] === "completed"));

    let saved: { undeliveredPings?: unknown[] } = {};
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      saved = JSON.parse(await readFile(snapshotPath, "utf8")) as typeof saved;
      if ((saved.undeliveredPings ?? []).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(saved.undeliveredPings?.length, 1, "the ping was persisted while no client was attached");

    client = await HostClient.connect(paths.socketPath);
    const received: Readonly<Record<string, unknown>>[] = [];
    client.onDetached((data) => received.push(data));
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]?.["status"], "completed");
    assert.equal(received[0]?.["result"], "offline result");

    const clearDeadline = Date.now() + 2_000;
    let remaining = -1;
    while (Date.now() < clearDeadline) {
      const after = JSON.parse(await readFile(snapshotPath, "utf8")) as typeof saved;
      remaining = (after.undeliveredPings ?? []).length;
      if (remaining === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(remaining, 0, "the queue is cleared after delivery");
  } finally {
    client?.close();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
