import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CursorAdapter, CursorAdapterError, buildCursorArguments } from "../src/adapters/cursor/adapter.js";
import { AdapterRegistry } from "../src/adapters/adapter.js";
import type { ResumeRequest, SpawnRequest } from "../src/adapters/adapter.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentEvent } from "../src/events/schema.js";
import { Supervisor } from "../src/supervisor.js";

const fixture = path.join(process.cwd(), "test", "cursor-fixture.mjs");
const escalate = { allow: [], deny: ["Bash(sudo:*)"], default: "escalate" as const };
const allow = { allow: [], deny: [], default: "allow" as const };

function spawnRequest(cwd: string, prompt: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    prompt,
    description: "fixture delegation",
    model: "auto",
    cwd,
    systemPrompt: "",
    env: { SUBAGENT_MCP_DEPTH: "2", CURSOR_FIXTURE_CUSTOM: "propagated" },
    permission: allow,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function resumeRequest(request: SpawnRequest, agentId: string, prompt: string): ResumeRequest {
  return {
    agentId,
    prompt,
    cwd: request.cwd,
    model: request.model,
    systemPrompt: request.systemPrompt,
    env: request.env,
    permission: request.permission,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
}

function fixtureAdapter(extraEnv: Record<string, string> = {}): CursorAdapter {
  return new CursorAdapter({
    executable: process.execPath,
    executableArgs: [fixture],
    initTimeoutMs: 2_000,
    interruptGraceMs: 300,
    env: extraEnv,
  });
}

async function eventsThrough(
  adapter: CursorAdapter,
  agentId: string,
  predicate: (event: AgentEvent) => boolean,
  since = 0,
): Promise<AgentEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4_000);
  const events: AgentEvent[] = [];
  try {
    for await (const event of adapter.events(agentId, { since, signal: abort.signal })) {
      events.push(event);
      if (predicate(event)) return events;
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  throw new Error("Timed out waiting for Cursor fixture event");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("buildCursorArguments is one turn per process, maps permission to force/plan, and resumes", () => {
  const forced = buildCursorArguments({ prompt: "do it", model: "auto", cwd: "/work", permission: allow });
  assert.deepEqual(forced, [
    "-p", "--output-format", "stream-json", "--trust", "--sandbox", "enabled",
    "--workspace", "/work", "--model", "auto", "--force", "do it",
  ]);

  const planned = buildCursorArguments({ prompt: "do it", model: "composer-2.5", cwd: "/work", permission: escalate });
  assert.ok(!planned.includes("--force"), "escalate must not grant execution");
  assert.deepEqual(planned.slice(planned.indexOf("--mode"), planned.indexOf("--mode") + 2), ["--mode", "plan"]);

  const denied = buildCursorArguments({ prompt: "do it", model: "auto", cwd: "/work", permission: { allow: [], deny: [], default: "deny" } });
  assert.ok(denied.includes("--mode"));

  const resumed = buildCursorArguments({ prompt: "again", model: "auto", cwd: "/work", permission: allow }, "session-1");
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), ["--resume", "session-1"]);
  assert.equal(resumed.at(-1), "again");

  assert.throws(() => buildCursorArguments({ prompt: "x", model: "", cwd: "/work", permission: allow }), CursorAdapterError);
  assert.throws(() => buildCursorArguments({ prompt: "x", model: "auto", cwd: "", permission: allow }), CursorAdapterError);
});

test("a turn stores the session_id, maps text/tools/result/usage, and exits after result", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-normal-")));
  const invocation = path.join(cwd, "invocation.json");
  const adapter = fixtureAdapter({ CURSOR_FIXTURE_INVOCATION: invocation });
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "FIRST"));
    assert.equal(turn.agentId, "33333333-3333-4333-8333-333333333333");
    assert.equal(turn.backend, "cursor");

    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    assert.deepEqual(events.map((event) => event.type), [
      "thread.started", "message.delta", "tool.start", "tool.end", "message.delta", "turn.completed",
    ]);
    const toolStart = events.find((event) => event.type === "tool.start")?.data as { toolName: string; toolCallId: string; input: Record<string, unknown> };
    assert.equal(toolStart.toolCallId, "call-1");
    assert.equal(toolStart.toolName, "shell");
    assert.deepEqual(toolStart.input, { command: "echo hi", description: "fixture command" });
    const toolEnd = events.find((event) => event.type === "tool.end")?.data as { status: string; output?: Record<string, unknown> };
    assert.equal(toolEnd.status, "completed");
    assert.ok(toolEnd.output && "success" in toolEnd.output);
    const completed = events.find((event) => event.type === "turn.completed")?.data as unknown as { status: string; finalText?: string; usage?: Record<string, number> };
    assert.equal(completed.status, "completed");
    assert.equal(completed.finalText, "final 1");
    assert.deepEqual(completed.usage, { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, uncachedInputTokens: 13 }, "new input = input + cache writes");

    const data = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(data.cwd, cwd);
    assert.equal(data.depth, undefined);
    assert.equal(data.customEnv, "propagated");
    assert.equal(data.model, "auto");
    assert.equal(data.force, true);
    assert.equal(data.plan, false);
    assert.ok(data.argv.includes("--workspace"));
    assert.ok(data.argv.includes(cwd));
  } finally {
    await adapter.closeAll();
  }
});

test("resume launches a fresh process with --resume and preserves the session id", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-resume-")));
  const invocation = path.join(cwd, "invocation.json");
  const adapter = fixtureAdapter({ CURSOR_FIXTURE_INVOCATION: invocation });
  const request = spawnRequest(cwd, "FIRST");
  try {
    const first = await adapter.spawn(request);
    await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed");

    const resumed = await adapter.resume(resumeRequest(request, first.agentId, "SECOND"));
    assert.equal(resumed.agentId, first.agentId);
    const events = await eventsThrough(adapter, resumed.agentId, (event) =>
      event.type === "turn.completed" && event.data.turnId === resumed.turnId);
    // The stream stops at the resumed turn's completion, so the last event is that turn.
    const completed = events.at(-1);
    assert.equal(completed?.type === "turn.completed" ? completed.data.finalText : undefined, "final 2");

    const data = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(data.resume, first.agentId);
    assert.deepEqual(data.argv.slice(data.argv.indexOf("--resume"), data.argv.indexOf("--resume") + 2), ["--resume", first.agentId]);
  } finally {
    await adapter.closeAll();
  }
});

test("stop_agent interrupts the process group once, without reporting a process fault", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-interrupt-")));
  const adapter = fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "HANG"));
    await Promise.all([adapter.interrupt(turn.agentId), adapter.interrupt(turn.agentId)]);
    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "interrupted");
    assert.ok(!events.some((event) => event.type === "error"), "a deliberate stop is not a process fault");
  } finally {
    await adapter.closeAll();
  }
});

test("a timeout emits a fatal error and fails the turn", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-timeout-")));
  const adapter = fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "HANG", { timeoutMs: 300 }));
    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    const error = events.find((event) => event.type === "error")?.data as { code: string; fatal: boolean };
    assert.equal(error.code, "CURSOR_TURN_TIMEOUT");
    assert.equal(error.fatal, true);
    assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
  } finally {
    await adapter.closeAll();
  }
});

test("a result with is_error is a failed turn with its text as finalText", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-fail-")));
  const adapter = fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "FAIL"));
    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    const error = events.find((event) => event.type === "error")?.data as { code: string; fatal: boolean };
    assert.equal(error.code, "CURSOR_TURN_FAILED");
    assert.equal(error.fatal, false);
    const completed = events.find((event) => event.type === "turn.completed")?.data as { status: string; finalText?: string };
    assert.equal(completed.status, "failed");
    assert.equal(completed.finalText, "fixture failure");
  } finally {
    await adapter.closeAll();
  }
});

test("early exit and malformed output become bounded normalized failures", async (t) => {
  await t.test("early exit", async () => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-exit-")));
    const adapter = fixtureAdapter();
    try {
      const turn = await adapter.spawn(spawnRequest(cwd, "EXIT_EARLY"));
      const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
      assert.equal(events.find((event) => event.type === "error")?.data.code, "CURSOR_PROCESS_EXIT");
      assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("malformed", async () => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-malformed-")));
    const adapter = fixtureAdapter();
    try {
      const turn = await adapter.spawn(spawnRequest(cwd, "MALFORMED"));
      const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
      assert.equal(events.find((event) => event.type === "error")?.data.code, "CURSOR_PROTOCOL_ERROR");
      assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
    } finally {
      await adapter.closeAll();
    }
  });
});

test("a background Cursor turn pushes the settled channel event on completion, failure, and interrupt", async (t) => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-settled-")));
  const agentConfig: AgentConfig = {
    name: "cursor-general",
    backend: "cursor",
    model: "auto",
    description: "Fixture Cursor agent",
    systemPrompt: "",
    permission: allow,
    env: {},
    sourcePath: "test-fixture",
  };
  const roster: ModelRoster = { claude: [], codex: [], opencode: [], antigravity: [], cursor: [{ name: "auto" }] };

  async function harness(): Promise<{ adapter: CursorAdapter; supervisor: Supervisor; settled: Readonly<Record<string, unknown>>[] }> {
    const adapter = fixtureAdapter();
    const settled: Readonly<Record<string, unknown>>[] = [];
    const supervisor = new Supervisor({
      registry: new ConfigRegistry([agentConfig], roster),
      adapters: new AdapterRegistry([adapter]),
      cwd,
      onDetachedSettled: (result) => settled.push(result),
    });
    return { adapter, supervisor, settled };
  }

  await t.test("completion carries the result text", async () => {
    const { adapter, supervisor, settled } = await harness();
    try {
      await supervisor.spawnAgent({ agent: "cursor-general", prompt: "FIRST", description: "d", run_in_background: true });
      await waitUntil(() => settled.length === 1);
      assert.equal(settled[0]?.["status"], "completed");
      assert.equal(settled[0]?.["backend"], "cursor");
      assert.equal(settled[0]?.["result"], "final 1");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("failure carries the failure text", async () => {
    const { adapter, supervisor, settled } = await harness();
    try {
      await supervisor.spawnAgent({ agent: "cursor-general", prompt: "FAIL", description: "d", run_in_background: true });
      await waitUntil(() => settled.length === 1);
      assert.equal(settled[0]?.["status"], "failed");
      assert.equal(settled[0]?.["result"], "fixture failure");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("interrupt notifies once with interrupted status", async () => {
    const { adapter, supervisor, settled } = await harness();
    try {
      const spawned = await supervisor.spawnAgent({ agent: "cursor-general", prompt: "HANG", description: "d", run_in_background: true });
      const agentId = spawned["agent_id"] as string;
      await waitUntil(() => supervisor.listAgents().some((a) => a["agent_id"] === agentId && a["state"] === "running"));
      await adapter.interrupt(agentId);
      await waitUntil(() => settled.length === 1);
      assert.equal(settled[0]?.["status"], "interrupted");
    } finally {
      await adapter.closeAll();
    }
  });
});
