import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { AGENT_NAMES } from "../src/agent-names.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { EventBuffer } from "../src/events/buffer.js";
import { Supervisor } from "../src/supervisor.js";

const permission = { allow: [], deny: [], default: "escalate" as const };

function testRegistry(agents: readonly AgentConfig[], roster: Partial<ModelRoster> = {}): ConfigRegistry {
  const fullRoster: ModelRoster = {
    claude: roster.claude ?? [],
    codex: roster.codex ?? [{ name: "fake-model" }],
    opencode: roster.opencode ?? [],
    antigravity: roster.antigravity ?? [],
    cursor: roster.cursor ?? [],
  };
  return new ConfigRegistry(agents, fullRoster);
}

function codexAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "general",
    backend: "codex",
    model: "fake-model",
    description: "General agent",
    systemPrompt: "",
    permission,
    env: {},
    sourcePath: "test-fixture",
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("spawn auto-assigns a memorable name and exposes it everywhere", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "hello",
    description: "automatic name",
    run_in_background: true,
  });
  const name = spawned["name"] as string;
  assert.match(name, /^[A-Z][a-z]+$/);
  assert.equal(supervisor.listAgents()[0]?.["name"], name);

  const events = supervisor.getAgentEvents(name, 0);
  assert.equal(events.name, name);
  assert.equal(events.agent_id, spawned["agent_id"]);

  const summary = supervisor.summarizeAgentEvents(name);
  assert.equal(summary["name"], name);
  assert.equal(summary["agent_id"], spawned["agent_id"]);
  assert.equal(typeof summary["tool_calls"], "number");
  assert.ok(Array.isArray(summary["recent_tools"]));
});

test("concurrent unnamed spawns receive unique names", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  const spawned = await Promise.all(Array.from({ length: 8 }, (_, index) => supervisor.spawnAgent({
    agent: "general",
    prompt: `job ${index}`,
    description: "concurrent automatic name",
    run_in_background: true,
  })));
  const names = spawned.map((result) => String(result["name"]));
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
});

test("listAgents order and pagination remain stable when an agent is updated", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  adapter.queueScript([]);
  adapter.queueScript([]);
  adapter.queueScript([]);
  const first = String((await supervisor.spawnAgent({ agent: "general", prompt: "first", description: "first", run_in_background: true }))["agent_id"]);
  const second = String((await supervisor.spawnAgent({ agent: "general", prompt: "second", description: "second", run_in_background: true }))["agent_id"]);
  const third = String((await supervisor.spawnAgent({ agent: "general", prompt: "third", description: "third", run_in_background: true }))["agent_id"]);
  const queued = await supervisor.spawnAgent({ agent: "general", prompt: "queued", description: "queued", depends_on: [third] });
  const queuedId = String(queued["task_id"]);
  const expected = [first, second, third, queuedId];

  await waitUntil(() => supervisor.listAgents().length === expected.length);
  assert.deepEqual(supervisor.listAgents().map((agent) => agent["agent_id"]), expected);
  const pending = supervisor.listAgents().find((agent) => agent["agent_id"] === queuedId);
  assert.equal(typeof pending?.["created_at"], "string");
  assert.equal(pending?.["updated_at"], pending?.["created_at"]);

  const firstPage = supervisor.sessionView({ limit: 1 });
  assert.equal((firstPage.agents as Record<string, unknown>[])[0]?.["agent_id"], first);
  const previousUpdatedAt = supervisor.listAgents()[0]?.["updated_at"];
  await new Promise((resolve) => setTimeout(resolve, 10));
  adapter.emit(first, "tool.start", { toolCallId: "busy", toolName: "Bash", input: { command: "npm test" } });
  await waitUntil(() => supervisor.listAgents()[0]?.["updated_at"] !== previousUpdatedAt);
  assert.deepEqual(supervisor.listAgents().map((agent) => agent["agent_id"]), expected);

  const paged = [first];
  let cursor = firstPage.next_cursor as string | null;
  while (cursor) {
    const page = supervisor.sessionView({ limit: 1, cursor });
    paged.push(String((page.agents as Record<string, unknown>[])[0]?.["agent_id"]));
    cursor = page.next_cursor as string | null;
  }
  assert.deepEqual(paged, expected);
});

test("waitForAgents since ignores earlier settlements and reports newly settled agents", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  adapter.queueScript([]);
  adapter.queueScript([]);
  const first = String((await supervisor.spawnAgent({ agent: "general", prompt: "first", description: "first", run_in_background: true }))["agent_id"]);
  const second = String((await supervisor.spawnAgent({ agent: "general", prompt: "second", description: "second", run_in_background: true }))["agent_id"]);
  adapter.emit(first, "turn.completed", { turnId: "first-turn", status: "completed", finalText: "done" });
  await waitUntil(() => supervisor.listAgents().find((agent) => agent["agent_id"] === first)?.["state"] === "completed");

  const initial = await supervisor.waitForAgents([first, second], "any", 0);
  assert.equal(initial.timed_out, false);
  assert.deepEqual(initial.newly_settled, [first]);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const since = new Date().toISOString();
  const stale = await supervisor.waitForAgents([first, second], "any", 0, since);
  assert.equal(stale.timed_out, true);
  assert.deepEqual(stale.newly_settled, []);

  const waiting = supervisor.waitForAgents([first, second], "any", 1, since);
  await new Promise((resolve) => setTimeout(resolve, 10));
  adapter.emit(second, "turn.completed", { turnId: "second-turn", status: "completed", finalText: "done" });
  const settled = await waiting;
  assert.equal(settled.timed_out, false);
  assert.deepEqual(settled.newly_settled, [second]);

  const allSettled = await supervisor.waitForAgents([first, second], "any", 0);
  assert.deepEqual(allSettled.newly_settled, [first, second]);
});

test("an explicit name is preserved and automatic names avoid it case-insensitively", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  const explicit = await supervisor.spawnAgent({
    agent: "general",
    prompt: "first",
    description: "explicit name",
    name: "abel",
    run_in_background: true,
  });
  const automatic = await supervisor.spawnAgent({
    agent: "general",
    prompt: "second",
    description: "automatic name",
    run_in_background: true,
  });
  assert.equal(explicit["name"], "abel");
  assert.notEqual(String(automatic["name"]).toLowerCase(), "abel");
});

test("automatic names are reused randomly, with a note, after every name in the pool has been used", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  for (const name of AGENT_NAMES) {
    adapter.queueScript([{
      create: (context) => ({
        type: "turn.completed",
        agentId: context.agentId,
        backend: context.backend,
        data: { turnId: context.turnId, status: "completed" as const },
      }),
    }]);
    await supervisor.spawnAgent({ agent: "general", prompt: name, description: "fill name pool", name });
  }

  const fallback = await supervisor.spawnAgent({
    agent: "general",
    prompt: "overflow",
    description: "name pool fallback",
    run_in_background: true,
  });
  assert.ok(AGENT_NAMES.some((name) => name === fallback["name"]));
  assert.match(String(fallback["name_note"]), /already given to 1 earlier agent.*NEW, different agent/);
  assert.equal(fallback["name_note"] === undefined, false);
});

test("sendMessage resolves an automatically generated name", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });
  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const },
    }),
  }]);
  const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "first", description: "named resume" });
  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const, finalText: "resumed" },
    }),
  }]);

  const resumed = await supervisor.sendMessage({ agent: String(spawned["name"]), prompt: "continue" });
  assert.equal(resumed["agent_id"], spawned["agent_id"]);
  assert.equal(resumed["name"], spawned["name"]);
  assert.equal(adapter.resumeRequests[0]?.agentId, spawned["agent_id"]);
});

test("resolveApproval auto-follows-up a deny message when the backend can't relay it inline (issue #1)", async () => {
  const adapter = new FakeAdapter("codex", new EventBuffer(), false /* relaysDenyMessage */);
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  // The initial turn parks on an approval as soon as it starts.
  adapter.queueScript([
    {
      create: (context) => ({
        type: "approval.requested",
        agentId: context.agentId,
        backend: context.backend,
        data: {
          requestId: "req-1",
          agentId: context.agentId,
          backend: "codex" as const,
          toolName: "Bash",
          input: { command: "npm test" },
          command: "npm test",
          cwd: "/work",
          requestedAt: new Date().toISOString(),
        },
      }),
    },
  ]);

  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "run tests",
    description: "fixture delegation",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  await waitUntil(() => supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "needs_approval"));

  // Simulate Codex's real wire protocol: approve() carries only `decision`, never `message`, so a
  // deny silently ends the child's turn (finding #1 in docs/reviews/usage-review-2026-09-05.md).
  const baseApprove = adapter.approve.bind(adapter);
  adapter.approve = async (id, resolution) => {
    await baseApprove(id, resolution);
    if (resolution.decision === "deny") {
      adapter.emit(id, "turn.completed", { turnId: "denied-turn", status: "completed" });
    }
  };

  // The follow-up turn resolveApproval starts automatically also needs to reach a terminal state.
  adapter.queueScript([
    {
      create: (context) => ({
        type: "turn.completed",
        agentId: context.agentId,
        backend: context.backend,
        data: { turnId: context.turnId, status: "completed" as const },
      }),
    },
  ]);

  const result = await supervisor.resolveApproval("req-1", "deny", "please fix the retry logic");

  assert.equal(adapter.resumeRequests.length, 1, "the deny message should have been delivered as a follow-up turn");
  assert.equal(adapter.resumeRequests[0]?.prompt, "please fix the retry logic");
  assert.equal(result["status"], "completed");
});

test("resolveApproval does not auto-follow-up when the backend already relays deny messages inline", async () => {
  const adapter = new FakeAdapter("codex", new EventBuffer(), true /* relaysDenyMessage */);
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  adapter.queueScript([
    {
      create: (context) => ({
        type: "approval.requested",
        agentId: context.agentId,
        backend: context.backend,
        data: {
          requestId: "req-2",
          agentId: context.agentId,
          backend: "codex" as const,
          toolName: "Bash",
          input: { command: "npm test" },
          command: "npm test",
          cwd: "/work",
          requestedAt: new Date().toISOString(),
        },
      }),
    },
  ]);

  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "run tests",
    description: "fixture delegation",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  await waitUntil(() => supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "needs_approval"));

  const baseApprove = adapter.approve.bind(adapter);
  adapter.approve = async (id, resolution) => {
    await baseApprove(id, resolution);
    if (resolution.decision === "deny") {
      adapter.emit(id, "turn.completed", { turnId: "denied-turn", status: "completed" });
    }
  };

  const result = await supervisor.resolveApproval("req-2", "deny", "already relayed inline");

  assert.equal(adapter.resumeRequests.length, 0, "no follow-up turn when the backend relays the message inline");
  assert.equal(result["status"], "completed");
});

test("listAgents() includes approval detail for a needs_approval agent (issue #4)", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  adapter.queueScript([
    {
      create: (context) => ({
        type: "approval.requested",
        agentId: context.agentId,
        backend: context.backend,
        data: {
          requestId: "req-3",
          agentId: context.agentId,
          backend: "codex" as const,
          toolName: "Bash",
          input: { command: "rm -rf build" },
          command: "rm -rf build",
          cwd: "/work",
          reason: "cleaning stale build output",
          requestedAt: new Date().toISOString(),
        },
      }),
    },
  ]);

  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "clean up",
    description: "fixture delegation",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  await waitUntil(() => supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "needs_approval"));

  const listed = supervisor.listAgents().find((a) => a["agent_id"] === agentId);
  assert.equal(listed?.["request_id"], "req-3");
  assert.equal(listed?.["command"], "rm -rf build");
  assert.equal(listed?.["cwd"], "/work");
  assert.equal(listed?.["reason"], "cleaning stale build output");
});

test("sendMessage queues while an agent is busy and delivers it once the current turn ends (issue #5)", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  // No script queued: the initial turn just sits "running" until we emit its completion below.
  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "start the long task",
    description: "fixture delegation",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  await waitUntil(() => supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "running"));

  // Sending while busy no longer throws; it queues and reports so on both call shapes.
  const queuedResult = await supervisor.sendMessage({ agent: agentId, prompt: "actually also do this", run_in_background: true });
  assert.equal(queuedResult["status"], "running");
  assert.equal(queuedResult["queued"], true);
  assert.equal(supervisor.listAgents().find((a) => a["agent_id"] === agentId)?.["queued"], true);

  // A second queue attempt while one is already waiting is rejected rather than dropped.
  await assert.rejects(
    supervisor.sendMessage({ agent: agentId, prompt: "a third thing", run_in_background: true }),
    /already has a message queued/,
  );

  // The follow-up turn (triggered automatically by the queued message) completes on its own.
  adapter.queueScript([
    {
      create: (context) => ({
        type: "turn.completed",
        agentId: context.agentId,
        backend: context.backend,
        data: { turnId: context.turnId, status: "completed" as const, finalText: "done" },
      }),
    },
  ]);

  // The original turn now ends; the queued message should be delivered instead of the agent
  // surfacing as "completed" here.
  adapter.emit(agentId, "turn.completed", { turnId: "original-turn", status: "completed" });

  await waitUntil(() => adapter.resumeRequests.length === 1);
  assert.equal(adapter.resumeRequests[0]?.prompt, "actually also do this");

  await waitUntil(() => supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "completed"));
  const final = supervisor.listAgents().find((a) => a["agent_id"] === agentId);
  assert.equal(final?.["queued"], undefined);
});

test("a completed background agent frees its capacity slot (no leak past MAX_CONCURRENT_AGENTS)", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  // Run well past the concurrency ceiling. Each agent completes before the next
  // spawn needs its slot. If a finished agent kept the slot, a later spawn would
  // wait forever and this test would time out.
  for (let i = 0; i < 25; i += 1) {
    adapter.queueScript([
      {
        create: (context) => ({
          type: "turn.completed",
          agentId: context.agentId,
          backend: context.backend,
          data: { turnId: context.turnId, status: "completed" as const },
        }),
      },
    ]);
    const spawned = await supervisor.spawnAgent({
      agent: "general",
      prompt: `job ${i}`,
      description: "capacity regression",
      run_in_background: true,
    });
    const agentId = spawned["agent_id"] as string;
    await waitUntil(() =>
      supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "completed"),
    );
  }

  assert.equal(supervisor.listAgents().length, 25);
});

test("resuming a completed agent re-counts it against capacity and releases again on completion", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  const completeOnce = () => {
    adapter.queueScript([
      {
        create: (context) => ({
          type: "turn.completed",
          agentId: context.agentId,
          backend: context.backend,
          data: { turnId: context.turnId, status: "completed" as const },
        }),
      },
    ]);
  };

  completeOnce();
  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "first",
    description: "resume capacity",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  await waitUntil(() =>
    supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "completed"),
  );

  // Resume then complete again, several times: the slot must be given back each time.
  for (let i = 0; i < 25; i += 1) {
    completeOnce();
    await supervisor.sendMessage({ agent: agentId, prompt: `again ${i}`, run_in_background: true });
    await waitUntil(() =>
      supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "completed"),
    );
  }

  // A fresh spawn still fits — the resumes did not leak.
  completeOnce();
  await supervisor.spawnAgent({
    agent: "general",
    prompt: "fresh",
    description: "resume capacity",
    run_in_background: true,
  });
});

test("spawn echoes the turn cap and send_message can override it", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig({ timeout: 1200 })]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });

  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "write the chapter",
    description: "timeout visibility",
    run_in_background: true,
  });
  assert.equal(spawned["timeout_seconds"], 1200);
  assert.equal(spawned["status"], "running");
  assert.equal(adapter.spawnRequests[0]?.timeoutMs, 1_200_000);

  const agentId = spawned["agent_id"] as string;
  adapter.emit(agentId, "error", {
    code: "CODEX_TURN_TIMEOUT",
    message: "Codex turn exceeded 1200000ms",
    fatal: true,
  });
  adapter.emit(agentId, "turn.completed", { turnId: "timed-out", status: "failed" });
  await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === agentId && agent["timed_out"] === true));

  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const, finalText: "done" },
    }),
  }]);
  const resumed = await supervisor.sendMessage({
    agent: agentId,
    prompt: "continue",
    timeout: 90,
    run_in_background: true,
  });
  assert.equal(resumed["timeout_seconds"], 90);
  assert.equal(adapter.resumeRequests.at(-1)?.timeoutMs, 90_000);
  assert.match(String(resumed["warning"]), /no prompt cache/);
});

test("a Codex resume past the idle limit is refused unless the caller opts in", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
    codexResumeIdleMs: 0,
  });
  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const },
    }),
  }]);
  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "first",
    description: "resume cost",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === agentId && agent["state"] === "completed"));

  await assert.rejects(
    supervisor.sendMessage({ agent: agentId, prompt: "again", run_in_background: true }),
    /allow_expensive_resume/,
  );
  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const },
    }),
  }]);
  const resumed = await supervisor.sendMessage({
    agent: agentId,
    prompt: "again",
    run_in_background: true,
    allow_expensive_resume: true,
  });
  assert.match(String(resumed["warning"]), /no prompt cache/);
});

test("OpenCode and Cursor reject effort instead of ignoring it", async () => {
  for (const backend of ["opencode", "cursor"] as const) {
    const adapter = new FakeAdapter(backend);
    const supervisor = new Supervisor({
      registry: testRegistry(
        [codexAgentConfig({ name: backend, backend, model: "model-a" })],
        { [backend]: [{ name: "model-a" }] },
      ),
      adapters: new AdapterRegistry([adapter]),
      cwd: "/work",
    });
    await assert.rejects(
      supervisor.spawnAgent({ agent: backend, prompt: "go", description: "effort", effort: "xhigh" }),
      /does not honor effort/,
    );
    assert.equal(adapter.spawnRequests.length, 0);
  }
});

test("spawn waits for a free concurrency slot instead of failing", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
    maxConcurrent: 1,
  });
  const first = await supervisor.spawnAgent({
    agent: "general",
    prompt: "hold",
    description: "cap",
    run_in_background: true,
  });
  let started = false;
  const second = supervisor.spawnAgent({
    agent: "general",
    prompt: "next",
    description: "cap",
    name: "next",
    run_in_background: true,
  }).then((result) => {
    started = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(started, false);
  assert.equal(supervisor.concurrency().waiting, 1);

  const agentId = first["agent_id"] as string;
  adapter.emit(agentId, "turn.completed", { turnId: "hold", status: "completed" });
  const result = await second;
  assert.equal(started, true);
  assert.equal(result["name"], "next");
  assert.equal(adapter.spawnRequests.length, 2);
});

test("list_models reports per-backend usage counters", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });
  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: {
        turnId: context.turnId,
        status: "completed" as const,
        usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.02 },
      },
    }),
  }]);
  const spawned = await supervisor.spawnAgent({
    agent: "general",
    prompt: "spend",
    description: "usage",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === agentId && agent["state"] === "completed"));

  const listed = supervisor.listModels();
  const usage = listed["usage"] as { codex: { spawns: number; turns: number; inputTokens: number; outputTokens: number; costUsd: number; models: Record<string, { inputTokens: number }> } };
  assert.equal(usage.codex.spawns, 1);
  assert.equal(usage.codex.turns, 1);
  assert.equal(usage.codex.inputTokens, 10);
  assert.equal(usage.codex.outputTokens, 4);
  assert.equal(usage.codex.costUsd, 0.02);
  assert.equal(usage.codex.models["fake-model"]?.inputTokens, 10);
  const concurrency = listed["concurrency"] as { limit: number; active: number };
  assert.equal(concurrency.limit, 12);
  assert.equal(concurrency.active, 0);
});

test("a restored running agent is interrupted and can be resumed", async () => {
  const firstAdapter = new FakeAdapter("codex");
  const first = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([firstAdapter]),
    cwd: "/work",
  });
  const spawned = await first.spawnAgent({
    agent: "general",
    prompt: "in flight",
    description: "restore",
    name: "writer",
    run_in_background: true,
  });
  const agentId = spawned["agent_id"] as string;
  const snapshot = first.exportSnapshot();

  const secondAdapter = new FakeAdapter("codex");
  secondAdapter.seed(agentId);
  const second = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([secondAdapter]),
    cwd: "/work",
  });
  second.restore(snapshot);
  const restored = second.listAgents().find((agent) => agent["agent_id"] === agentId);
  assert.equal(restored?.["state"], "interrupted");
  assert.equal(restored?.["name"], "writer");

  secondAdapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const, finalText: "resumed" },
    }),
  }]);
  const resumed = await second.sendMessage({
    agent: "writer",
    prompt: "pick up where you left off",
    run_in_background: true,
    allow_expensive_resume: true,
  });
  assert.equal(secondAdapter.resumeRequests[0]?.agentId, agentId);
  await waitUntil(() => second.listAgents().some((agent) => agent["agent_id"] === agentId && agent["state"] === "completed"));
  assert.equal(resumed["agent_id"], agentId);
});

test("restored automatic names persist and are not reassigned", async () => {
  const firstAdapter = new FakeAdapter("codex");
  const first = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([firstAdapter]),
    cwd: "/work",
  });
  const spawned = await first.spawnAgent({
    agent: "general",
    prompt: "in flight",
    description: "automatic name restore",
    run_in_background: true,
  });
  const originalName = spawned["name"] as string;

  const secondAdapter = new FakeAdapter("codex");
  const second = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([secondAdapter]),
    cwd: "/work",
  });
  second.restore(first.exportSnapshot());
  const restored = second.listAgents().find((agent) => agent["agent_id"] === spawned["agent_id"]);
  assert.equal(restored?.["name"], originalName);

  const next = await second.spawnAgent({
    agent: "general",
    prompt: "new work",
    description: "name after restore",
    run_in_background: true,
  });
  assert.notEqual(String(next["name"]).toLowerCase(), originalName.toLowerCase());
});

test("agent name pool is unique (case-insensitive) and includes philosophers and Greek mythology", () => {
  const lowered = AGENT_NAMES.map((name) => name.toLowerCase());
  assert.equal(new Set(lowered).size, lowered.length);
  for (const name of ["Aristotle", "Kant", "Athena", "Odysseus"]) assert.ok(lowered.includes(name.toLowerCase()), name);
  for (const name of AGENT_NAMES) assert.match(name, /^[A-Za-z][A-Za-z-]*$/);
});

test("describeToolInput normalizes targets and edit previews across harness shapes", async () => {
  const { describeToolInput } = await import("../src/tool-describe.js");
  assert.deepEqual(describeToolInput({ file_path: "a.ts", old_string: "x", new_string: "y" }), { target: "a.ts", preview: "-x\n+y" });
  assert.equal(describeToolInput({ filePath: "b.ts", oldString: "x", newString: "y" }).target, "b.ts");
  assert.equal(describeToolInput({ command: "npm  test" }).target, "npm test");
  const codex = describeToolInput({ changes: [{ path: "c.ts", diff: "--- a\n+++ b\n-old\n+new" }, { path: "d.ts" }] });
  assert.equal(codex.target, "c.ts (+1 more)");
  assert.equal(codex.preview, "-old\n+new");
  assert.deepEqual(describeToolInput("nope"), {});
});

test("waitForAgents 'all' with since needs one fresh settle but counts earlier ones as done; since without milliseconds compares as an instant", async () => {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({
    registry: testRegistry([codexAgentConfig()]),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });
  adapter.queueScript([]);
  adapter.queueScript([]);
  const first = String((await supervisor.spawnAgent({ agent: "general", prompt: "a", description: "a", run_in_background: true }))["agent_id"]);
  const second = String((await supervisor.spawnAgent({ agent: "general", prompt: "b", description: "b", run_in_background: true }))["agent_id"]);
  adapter.emit(first, "turn.completed", { turnId: "t1", status: "completed", finalText: "done" });
  await waitUntil(() => supervisor.listAgents().find((a) => a["agent_id"] === first)?.["state"] === "completed");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const since = new Date().toISOString().replace(/\.\d+Z$/, "Z"); // whole seconds, as a caller might send
  const waiting = supervisor.waitForAgents([first, second], "all", 2, since);
  await new Promise((resolve) => setTimeout(resolve, 10));
  adapter.emit(second, "turn.completed", { turnId: "t2", status: "completed", finalText: "done" });
  const result = await waiting;
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.newly_settled, [second]);
});
