import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
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
  assert.equal(await supervisor.flushUndeliveredPings((ping) => { delivered.push(ping); }), 100);
  assert.equal(delivered[0]?.["agent_id"], "agent-50", "the oldest pings are dropped");
  assert.equal(await supervisor.flushUndeliveredPings((ping) => { delivered.push(ping); }), 0, "a flush is at most once");
});

test("an attaching socket that closes mid-flush leaves pings queued for the next attach", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "delayed-mid-flush-"));
  const snapshotPath = join(cwd, "sessions.json");
  const { supervisor } = fixture();
  supervisor.enablePersistence(snapshotPath);
  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  const raw = createConnection(paths.socketPath);
  await once(raw, "connect");
  try {
    await supervisor.enqueueUndeliveredPing({ agent_id: "closing", backend: "codex", status: "completed", result: "retry" });
    const original = supervisor.flushUndeliveredPings.bind(supervisor);
    let first = true;
    supervisor.flushUndeliveredPings = async (deliver) => {
      if (first) {
        first = false;
        // Close the consumer while attach_session is still flushing to it.
        raw.destroy();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return original(deliver);
    };
    raw.write(`${JSON.stringify({ id: 1, method: "attach_session" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const saved = JSON.parse(await readFile(snapshotPath, "utf8")) as { undeliveredPings?: unknown[] };
    assert.equal(saved.undeliveredPings?.length, 1, "the failed write did not remove the ping");

    const client = await HostClient.connect(paths.socketPath);
    const received: Readonly<Record<string, unknown>>[] = [];
    client.onDetached((data) => received.push(data));
    try {
      await client.call("attach_session");
      await waitUntil(() => received.length === 1);
      assert.equal(received[0]?.["result"], "retry");
    } finally {
      client.close();
    }
  } finally {
    raw.destroy();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a ping enqueued while attach_session flushes is delivered to that socket, not stranded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "delayed-attach-race-"));
  const { supervisor } = fixture();
  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  const client = await HostClient.connect(paths.socketPath);
  const received: Readonly<Record<string, unknown>>[] = [];
  client.onDetached((data) => received.push(data));
  try {
    const original = supervisor.flushUndeliveredPings.bind(supervisor);
    let injected = false;
    supervisor.flushUndeliveredPings = async (deliver) => {
      const delivered = await original(deliver);
      if (!injected) {
        injected = true;
        // Simulate a settle after the flush copied the queue but before attach registered the socket.
        await supervisor.enqueueUndeliveredPing({
          agent_id: "racing", backend: "codex", status: "completed", result: "late",
        });
      }
      return delivered;
    };

    await client.call("attach_session");
    await waitUntil(() => received.some((ping) => ping["result"] === "late"));
    assert.equal(received.filter((ping) => ping["result"] === "late").length, 1, "delivered exactly once");
  } finally {
    client.close();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent attaches deliver each queued ping exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "delayed-concurrent-attach-"));
  const { supervisor } = fixture();
  const queued = Array.from({ length: 20 }, (_, index) => ({
    agent_id: `queued-${index}`, backend: "codex", status: "completed", result: `result-${index}`,
  }));
  for (const ping of queued) await supervisor.enqueueUndeliveredPing(ping);
  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  const first = await HostClient.connect(paths.socketPath);
  const second = await HostClient.connect(paths.socketPath);
  const firstPings: Readonly<Record<string, unknown>>[] = [];
  const secondPings: Readonly<Record<string, unknown>>[] = [];
  first.onDetached((data) => firstPings.push(data));
  second.onDetached((data) => secondPings.push(data));
  try {
    // Hold both flushes open so they would copy the same queue if they were not serialized.
    const original = supervisor.flushUndeliveredPings.bind(supervisor);
    supervisor.flushUndeliveredPings = async (deliver) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return original(async (ping) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return deliver(ping);
      });
    };
    await Promise.all([first.call("attach_session"), second.call("attach_session")]);
    await waitUntil(() => firstPings.length + secondPings.length >= queued.length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const received = [...firstPings, ...secondPings];
    assert.equal(received.length, queued.length, "each queued ping is written once in total");
    assert.deepEqual(
      received.map((ping) => ping["agent_id"]).sort(),
      queued.map((ping) => ping["agent_id"]).sort(),
    );
  } finally {
    first.close();
    second.close();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
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

test("pings with no attached session are queued, persisted, and flushed on attach", async () => {
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
      void (async () => {
        const delivered = endpoint === undefined
          ? 0
          : await endpoint.notify({ event: "detached", data: result }).catch(() => 0);
        if (delivered === 0) await supervisor.enqueueUndeliveredPing(result);
      })();
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
    assert.equal(saved.undeliveredPings?.length, 1, "the ping was persisted while no session was attached");

    client = await HostClient.connect(paths.socketPath);
    const received: Readonly<Record<string, unknown>>[] = [];
    client.onDetached((data) => received.push(data));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 0, "connecting alone is not attaching");
    await client.call("attach_session");
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

test("a delayed task and a queued ping survive a host replacement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "delayed-replacement-"));
  const snapshotPath = join(cwd, "sessions.json");
  const first = fixture();
  first.supervisor.enablePersistence(snapshotPath);
  const task = await first.supervisor.spawnAgent({ ...spawn, delay_seconds: 3_600 });
  const taskId = String(task["task_id"]);
  await first.supervisor.enqueueUndeliveredPing({
    agent_id: "old-agent", backend: "codex", status: "completed", result: "survived",
  });
  await first.supervisor.flushSnapshot();

  const saved = JSON.parse(await readFile(snapshotPath, "utf8")) as {
    pending: unknown[];
    undeliveredPings?: unknown[];
  };
  assert.equal(saved.pending.length, 1, "the scheduled task was persisted before exit");
  assert.equal(saved.undeliveredPings?.length, 1, "the queued ping was persisted before exit");

  // A replacement host restores both, re-arms the timer, and only drains pings on attach_session.
  const second = fixture();
  second.supervisor.enablePersistence(snapshotPath);
  second.supervisor.restoreUndeliveredPings(saved.undeliveredPings);
  second.supervisor.restorePending(saved.pending as never);
  assert.equal(second.supervisor.hasPendingWork(), true);
  assert.equal(second.supervisor.concurrency().scheduled, 1);
  assert.equal(second.adapter.spawnRequests.length, 0, "a future task does not launch during restore");

  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor: second.supervisor });
  const client = await HostClient.connect(paths.socketPath);
  const received: Readonly<Record<string, unknown>>[] = [];
  client.onDetached((data) => received.push(data));
  try {
    await client.call("hello");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 0, "connecting alone does not drain the restored queue");
    await client.call("attach_session");
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]?.["result"], "survived");
    const listed = second.supervisor.listAgents().find((agent) => agent["agent_id"] === taskId);
    assert.equal(listed?.["state"], "queued");
    assert.equal(listed?.["start_at"], task["start_at"]);
  } finally {
    client.close();
    await endpoint.close();
    await second.supervisor.stopAgents([taskId]);
    await rm(paths.socketPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
