import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CopilotAdapter, CopilotAdapterError, buildCopilotArguments, translateRules } from "../src/adapters/copilot/adapter.js";
import { AdapterRegistry } from "../src/adapters/adapter.js";
import type { ResumeRequest, SpawnRequest } from "../src/adapters/adapter.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentEvent } from "../src/events/schema.js";
import { Supervisor } from "../src/supervisor.js";

const fixture = path.join(process.cwd(), "test", "copilot-fixture.mjs");
const escalate = { allow: ["Bash(git *:*)", "Read", "WebFetch"], deny: ["Bash(sudo:*)"], default: "escalate" as const };
const allow = { allow: [], deny: ["Bash(sudo:*)"], default: "allow" as const };

function spawnRequest(cwd: string, prompt: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    prompt,
    description: "fixture delegation",
    model: "auto",
    cwd,
    systemPrompt: "",
    env: { COPILOT_FIXTURE_CUSTOM: "propagated" },
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

function fixtureAdapter(extraEnv: Record<string, string> = {}): CopilotAdapter {
  return new CopilotAdapter({
    executable: process.execPath,
    executableArgs: [fixture],
    initTimeoutMs: 2_000,
    interruptGraceMs: 300,
    env: extraEnv,
  });
}

async function eventsThrough(
  adapter: CopilotAdapter,
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
  throw new Error("Timed out waiting for Copilot fixture event");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("buildCopilotArguments maps permission, effort and resume, and passes the prompt with =", () => {
  const allowAll = buildCopilotArguments({ prompt: "-starts with a dash", model: "auto", cwd: "/work", permission: allow });
  assert.deepEqual(allowAll, [
    "--output-format", "json", "--no-auto-update", "--no-ask-user", "--model", "auto",
    "--allow-all-tools", "--deny-tool", "shell(sudo:*)", "--prompt=-starts with a dash",
  ]);

  const scoped = buildCopilotArguments({ prompt: "x", model: "auto", cwd: "/work", permission: escalate, reasoningEffort: "high" });
  assert.ok(!scoped.includes("--allow-all-tools"), "escalate must not grant every tool");
  assert.deepEqual(scoped.slice(scoped.indexOf("--reasoning-effort"), scoped.indexOf("--reasoning-effort") + 2), ["--reasoning-effort", "high"]);
  assert.deepEqual(scoped.filter((_, i) => scoped[i - 1] === "--allow-tool"), ["shell(git:*)", "read"]);
  assert.deepEqual(scoped.filter((_, i) => scoped[i - 1] === "--deny-tool"), ["shell(sudo:*)"]);

  const resumed = buildCopilotArguments({ prompt: "again", model: "auto", cwd: "/work", permission: allow }, "session-1");
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), ["--resume", "session-1"]);
  assert.equal(resumed.at(-1), "--prompt=again");

  assert.throws(() => buildCopilotArguments({ prompt: "x", model: "", cwd: "/work", permission: allow }), CopilotAdapterError);
  assert.throws(() => buildCopilotArguments({ prompt: "x", model: "auto", cwd: "", permission: allow }), CopilotAdapterError);
});

test("translateRules maps Claude-style rules, keeps native ones, and drops the rest", () => {
  assert.deepEqual(translateRules([
    "Bash", "Bash(git:*)", "Bash(npm run *:*)", "Read", "Grep(src/**)", "Write(.env)", "Edit",
    "shell(gh pr create)", "url(https://github.com)", "memory", "WebFetch", "mcp__x__y", "Read",
  ]), [
    "shell", "shell(git:*)", "shell(npm run:*)", "read", "read(src/**)", "write(.env)", "write",
    "shell(gh pr create)", "url(https://github.com)", "memory",
  ]);
});

test("a turn stores the sessionId and maps text, tools, denials and the final message", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-normal-")));
  const invocation = path.join(cwd, "invocation.json");
  const adapter = fixtureAdapter({ COPILOT_FIXTURE_INVOCATION: invocation });
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "FIRST", { systemPrompt: "You are a fixture." }));
    assert.equal(turn.agentId, "44444444-4444-4444-8444-444444444444");
    assert.equal(turn.backend, "copilot");

    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    assert.deepEqual(events.map((event) => event.type), [
      "thread.started", "message.delta", "tool.start", "tool.end", "tool.start", "tool.end", "message.delta", "turn.completed",
    ]);
    const toolStart = events.find((event) => event.type === "tool.start")?.data as { toolName: string; toolCallId: string; input: Record<string, unknown> };
    assert.equal(toolStart.toolCallId, "call-1");
    assert.equal(toolStart.toolName, "bash");
    assert.equal(toolStart.input["command"], "echo hi");
    const ends = events.filter((event) => event.type === "tool.end").map((event) => event.data as { status: string; toolName?: string });
    assert.deepEqual(ends.map((end) => end.status), ["completed", "denied"]);
    assert.equal(ends[1]?.toolName, "bash");
    const completed = events.find((event) => event.type === "turn.completed")?.data as { status: string; finalText?: string; usage?: unknown };
    assert.equal(completed.status, "completed");
    assert.equal(completed.finalText, "final 1");
    assert.equal(completed.usage, undefined, "Copilot reports premium requests, not tokens");

    const data = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(data.cwd, cwd);
    assert.equal(data.customEnv, "propagated");
    assert.equal(data.allowAll, true);
    assert.deepEqual(data.denyTools, ["shell(sudo:*)"]);
    assert.equal(data.prompt, "You are a fixture.\n\n---\n\nFIRST", "the agent config body leads the first prompt");
  } finally {
    await adapter.closeAll();
  }
});

test("resume launches a fresh process with --resume, keeps the session id, and skips the system prompt", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-resume-")));
  const invocation = path.join(cwd, "invocation.json");
  const adapter = fixtureAdapter({ COPILOT_FIXTURE_INVOCATION: invocation });
  const request = spawnRequest(cwd, "FIRST", { systemPrompt: "You are a fixture." });
  try {
    const first = await adapter.spawn(request);
    await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed");

    const resumed = await adapter.resume(resumeRequest(request, first.agentId, "SECOND"));
    assert.equal(resumed.agentId, first.agentId);
    const events = await eventsThrough(adapter, resumed.agentId, (event) =>
      event.type === "turn.completed" && event.data.turnId === resumed.turnId);
    const completed = events.at(-1);
    assert.equal(completed?.type === "turn.completed" ? completed.data.finalText : undefined, "final 2");

    const data = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(data.resume, first.agentId);
    assert.equal(data.prompt, "SECOND");
  } finally {
    await adapter.closeAll();
  }
});

test("resume waits for the previous turn's process to exit, since Copilot locks the session", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-linger-")));
  const adapter = fixtureAdapter({ COPILOT_FIXTURE_LOCK: path.join(cwd, "session.lock") });
  const request = spawnRequest(cwd, "FIRST LINGER");
  try {
    const first = await adapter.spawn(request);
    await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed");
    // The first process is still alive (and holding the lock) right after its result.
    const resumed = await adapter.resume(resumeRequest(request, first.agentId, "SECOND"));
    const events = await eventsThrough(adapter, resumed.agentId, (event) =>
      event.type === "turn.completed" && event.data.turnId === resumed.turnId);
    const completed = events.at(-1);
    assert.equal(completed?.type === "turn.completed" ? completed.data.status : undefined, "completed");
    assert.equal(completed?.type === "turn.completed" ? completed.data.finalText : undefined, "final 2");
  } finally {
    await adapter.closeAll();
  }
});

test("stop_agent interrupts the process group once, without reporting a process fault", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-interrupt-")));
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
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-timeout-")));
  const adapter = fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "HANG", { timeoutMs: 300 }));
    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    const error = events.find((event) => event.type === "error")?.data as { code: string; fatal: boolean };
    assert.equal(error.code, "COPILOT_TURN_TIMEOUT");
    assert.equal(error.fatal, true);
    assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
  } finally {
    await adapter.closeAll();
  }
});

test("session.error fails the turn and its message becomes the result", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-fail-")));
  const adapter = fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "MODEL_UNAVAILABLE", { model: "gpt-6-luna" }));
    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    const errors = events.filter((event) => event.type === "error").map((event) => event.data as { code: string; fatal: boolean });
    assert.deepEqual(errors.map((error) => error.code), ["COPILOT_SESSION_ERROR"]);
    const completed = events.find((event) => event.type === "turn.completed")?.data as { status: string; finalText?: string };
    assert.equal(completed.status, "failed");
    assert.equal(completed.finalText, 'Execution failed: Model "gpt-6-luna" is not available.');
  } finally {
    await adapter.closeAll();
  }
});

test("a startup error printed as text, with only a result, still fails the turn with that text", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-startup-")));
  const adapter = fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "STARTUP_ERROR"));
    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    assert.equal(events.find((event) => event.type === "error")?.data.code, "COPILOT_TURN_FAILED");
    const completed = events.find((event) => event.type === "turn.completed")?.data as { status: string; finalText?: string };
    assert.equal(completed.status, "failed");
    assert.match(completed.finalText ?? "", /does not support reasoning effort/);
  } finally {
    await adapter.closeAll();
  }
});

test("early exit and malformed output become bounded normalized failures", async (t) => {
  await t.test("early exit", async () => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-exit-")));
    const adapter = fixtureAdapter();
    try {
      const turn = await adapter.spawn(spawnRequest(cwd, "EXIT_EARLY"));
      const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
      assert.equal(events.find((event) => event.type === "error")?.data.code, "COPILOT_PROCESS_EXIT");
      assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("malformed", async () => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-malformed-")));
    const adapter = fixtureAdapter();
    try {
      const turn = await adapter.spawn(spawnRequest(cwd, "MALFORMED"));
      const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
      assert.equal(events.find((event) => event.type === "error")?.data.code, "COPILOT_PROTOCOL_ERROR");
      assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
    } finally {
      await adapter.closeAll();
    }
  });
});

test("a background Copilot turn pushes the settled channel event on completion, failure, and interrupt", async (t) => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-settled-")));
  const agentConfig: AgentConfig = {
    name: "copilot-general",
    backend: "copilot",
    model: "auto",
    description: "Fixture Copilot agent",
    systemPrompt: "",
    permission: allow,
    env: {},
    sourcePath: "test-fixture",
  };
  const roster: ModelRoster = { claude: [], codex: [], opencode: [], antigravity: [], cursor: [], copilot: [{ name: "auto" }] };

  async function harness(): Promise<{ adapter: CopilotAdapter; supervisor: Supervisor; settled: Readonly<Record<string, unknown>>[] }> {
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
      await supervisor.spawnAgent({ agent: "copilot-general", prompt: "FIRST", description: "d", run_in_background: true });
      await waitUntil(() => settled.length === 1);
      assert.equal(settled[0]?.["status"], "completed");
      assert.equal(settled[0]?.["backend"], "copilot");
      assert.equal(settled[0]?.["result"], "final 1");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("failure carries the error text", async () => {
    const { adapter, supervisor, settled } = await harness();
    try {
      await supervisor.spawnAgent({ agent: "copilot-general", prompt: "MODEL_UNAVAILABLE", description: "d", run_in_background: true });
      await waitUntil(() => settled.length === 1);
      assert.equal(settled[0]?.["status"], "failed");
      assert.match(String(settled[0]?.["result"]), /is not available/);
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("interrupt notifies once with interrupted status", async () => {
    const { adapter, supervisor, settled } = await harness();
    try {
      const spawned = await supervisor.spawnAgent({ agent: "copilot-general", prompt: "HANG", description: "d", run_in_background: true });
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
