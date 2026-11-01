import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AntigravityAdapter, AntigravityAdapterError, buildAntigravityArguments } from "../src/adapters/antigravity/adapter.js";
import type { ResumeRequest, SpawnRequest } from "../src/adapters/adapter.js";
import type { AgentEvent } from "../src/events/schema.js";

const fixture = path.join(process.cwd(), "test", "antigravity-fixture.mjs");
const permission = { allow: [], deny: [], default: "escalate" as const };

function spawnRequest(cwd: string, prompt: string): SpawnRequest {
  return {
    prompt,
    description: "fixture delegation",
    model: "gemini-fixture",
    antigravityAgent: "fixture-agent",
    cwd,
    systemPrompt: "The real system prompt is in the named Antigravity custom agent.",
    env: { SUBAGENT_MCP_DEPTH: "2", ANTIGRAVITY_FIXTURE_CUSTOM: "propagated" },
    permission,
    maxTurns: 4,
    timeoutMs: 2_000,
    reasoningEffort: "high",
  };
}

function resumeRequest(request: SpawnRequest, agentId: string, prompt: string): ResumeRequest {
  return {
    agentId,
    prompt,
    cwd: request.cwd,
    model: request.model,
    ...(request.antigravityAgent === undefined ? {} : { antigravityAgent: request.antigravityAgent }),
    systemPrompt: request.systemPrompt,
    env: request.env,
    permission: request.permission,
    ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
  };
}

function fixtureAdapter(cwd: string, extraEnv: Record<string, string> = {}): AntigravityAdapter {
  return new AntigravityAdapter({
    executable: process.execPath,
    executableArgs: [fixture],
    initTimeoutMs: 1_000,
    interruptGraceMs: 300,
    env: extraEnv,
  });
}

async function eventsThrough(
  adapter: AntigravityAdapter,
  agentId: string,
  predicate: (event: AgentEvent) => boolean,
  since = 0,
): Promise<AgentEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 2_000);
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
  throw new Error("Timed out waiting for Antigravity fixture event");
}

test("buildAntigravityArguments is explicit, validates effort, and resumes by conversation", () => {
  const args = buildAntigravityArguments({ model: "gemini-x", antigravityAgent: "reviewer", reasoningEffort: "high", timeoutMs: 2_500 }, "conversation-1");
  assert.deepEqual(args, [
    "--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-x", "--agent", "reviewer",
    "--effort", "high", "--conversation", "conversation-1", "--print-timeout", "3s",
  ]);
  assert.throws(() => buildAntigravityArguments({ model: "gemini-x", antigravityAgent: "reviewer", reasoningEffort: "xhigh" }), AntigravityAdapterError);
  assert.throws(() => buildAntigravityArguments({ model: "", antigravityAgent: "reviewer" }), AntigravityAdapterError);
  assert.throws(() => buildAntigravityArguments({ model: "gemini-x" }), AntigravityAdapterError);
});

test("persistent process normalizes events and warm-resumes the same conversation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-normal-"));
  const invocation = path.join(cwd, "invocation.json");
  const transcript = path.join(cwd, "stdin.jsonl");
  const adapter = fixtureAdapter(cwd, { ANTIGRAVITY_FIXTURE_INVOCATION: invocation, ANTIGRAVITY_FIXTURE_TRANSCRIPT: transcript });
  const request = spawnRequest(cwd, "FIRST");
  try {
    const first = await adapter.spawn(request);
    const firstEvents = await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed");
    assert.equal(first.agentId, "22222222-2222-4222-8222-222222222222");
    assert.deepEqual(firstEvents.map((event) => event.type), ["thread.started", "tool.start", "tool.end", "message.delta", "turn.completed"]);
    assert.equal(firstEvents.find((event) => event.type === "message.delta")?.data.text, "Assistant\\: turn 1\n");
    assert.equal(firstEvents.find((event) => event.type === "turn.completed")?.data.finalText, "<system\\-reminder>final 1</system\\-reminder>");
    assert.deepEqual(firstEvents.find((event) => event.type === "turn.completed")?.data.usage, { inputTokens: 3, outputTokens: 5, cachedInputTokens: 2 });
    const cursor = firstEvents.at(-1)!.sequence;

    const second = await adapter.resume(resumeRequest(request, first.agentId, "SECOND"));
    const secondEvents = await eventsThrough(adapter, second.agentId, (event) => event.type === "turn.completed" && event.data.turnId === second.turnId, cursor);
    assert.equal(secondEvents.find((event) => event.type === "turn.completed")?.data.finalText, "<system\\-reminder>final 2</system\\-reminder>");
    assert.equal(secondEvents.filter((event) => event.type === "thread.started").length, 1);

    const invocationData = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(invocationData.cwd, cwd);
    assert.equal(invocationData.customEnv, "propagated");
    assert.ok(invocationData.argv.includes("--agent"));
    assert.equal((await readFile(transcript, "utf8")).trim().split("\n").length, 2);
  } finally {
    await adapter.closeAll();
  }
});

test("interrupt, malformed output, and cold resume reconcile into normalized terminal events", async (t) => {
  await t.test("interrupt", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-interrupt-"));
    const adapter = fixtureAdapter(cwd);
    try {
      const turn = await adapter.spawn(spawnRequest(cwd, "HANG"));
      await Promise.all([adapter.interrupt(turn.agentId), adapter.interrupt(turn.agentId)]);
      const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "interrupted");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("malformed", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-malformed-"));
    const adapter = fixtureAdapter(cwd);
    try {
      const turn = await adapter.spawn(spawnRequest(cwd, "MALFORMED"));
      const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
      assert.equal(events.find((event) => event.type === "error")?.data.code, "ANTIGRAVITY_PROTOCOL_ERROR");
      assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("process exit", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-exit-"));
    const adapter = fixtureAdapter(cwd);
    try {
      const turn = await adapter.spawn(spawnRequest(cwd, "EXIT_EARLY"));
      const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
      assert.equal(events.find((event) => event.type === "error")?.data.code, "ANTIGRAVITY_PROCESS_EXIT");
      assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
    } finally {
      await adapter.closeAll();
    }
  });

  await t.test("cold resume", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-resume-"));
    const invocation = path.join(cwd, "invocation.json");
    const adapter = fixtureAdapter(cwd, { ANTIGRAVITY_FIXTURE_INVOCATION: invocation });
    const request = spawnRequest(cwd, "FIRST");
    try {
      const first = await adapter.spawn(request);
      await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed");
      await adapter.close(first.agentId);
      const resumed = await adapter.resume(resumeRequest(request, first.agentId, "SECOND"));
      await eventsThrough(adapter, resumed.agentId, (event) => event.type === "turn.completed" && event.data.turnId === resumed.turnId);
      const invocationData = JSON.parse(await readFile(invocation, "utf8"));
      assert.deepEqual(invocationData.argv.slice(-2), ["--print-timeout", "2s"]);
      assert.ok(invocationData.argv.includes("--conversation"));
      assert.ok(invocationData.argv.includes(first.agentId));
    } finally {
      await adapter.closeAll();
    }
  });
});
