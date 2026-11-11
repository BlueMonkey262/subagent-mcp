import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter, type FakeStep } from "../src/adapters/fake.js";
import { createChannelNotifier, formatChannelEvent, isClaudeCodeClient } from "../src/channel.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentConfig } from "../src/config/schema.js";
import { EventBuffer } from "../src/events/buffer.js";
import { Supervisor } from "../src/supervisor.js";

const agentConfig: AgentConfig = {
  name: "general",
  backend: "codex",
  model: "fake-model",
  description: "General agent",
  systemPrompt: "",
  permission: { allow: [], deny: [], default: "escalate" },
  env: {},
  sourcePath: "test-fixture",
};

function completeScript(finalText: string): readonly FakeStep[] {
  return [{
    create: (context) => ({
      type: "turn.completed" as const,
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const, finalText },
    }),
  }];
}

function harness() {
  const adapter = new FakeAdapter("codex", new EventBuffer());
  const settled: Readonly<Record<string, unknown>>[] = [];
  const supervisor = new Supervisor({
    registry: new ConfigRegistry([agentConfig], { claude: [], codex: [{ name: "fake-model" }], opencode: [], antigravity: [], cursor: [], copilot: [] }),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
    onDetachedSettled: (result) => settled.push(result),
  });
  return { adapter, supervisor, settled };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("only Claude Code is treated as a channel client", () => {
  assert.equal(isClaudeCodeClient("claude-code"), true);
  assert.equal(isClaudeCodeClient("codex"), false);
  assert.equal(isClaudeCodeClient("opencode"), false);
  assert.equal(isClaudeCodeClient(undefined), false);
});

test("notifier stays silent for non-Claude-Code clients and emits a channel event for Claude Code", async () => {
  const sent: { method: string; params: { content: string; meta: Record<string, string> } }[] = [];
  const fakeServer = (name: string | undefined) => ({
    getClientVersion: () => (name === undefined ? undefined : { name, version: "1" }),
    notification: async (n: never) => void sent.push(n),
  });
  const result = { agent_id: "a1", backend: "codex", status: "completed", result: "done" };

  createChannelNotifier(fakeServer("some-other-client") as never)(result);
  createChannelNotifier(fakeServer(undefined) as never)(result);
  assert.equal(sent.length, 0);

  createChannelNotifier(fakeServer("claude-code") as never)(result);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, "notifications/claude/channel");
  assert.deepEqual(sent[0]?.params.meta, { agent_id: "a1", status: "completed", backend: "codex" });
  assert.match(sent[0]?.params.content ?? "", /completed\.\ndone$/);
});

test("formatChannelEvent truncates long results, includes approval details, and keeps meta keys valid", () => {
  const long = formatChannelEvent({ agent_id: "a1", name: "worker", backend: "codex", status: "completed", result: "x".repeat(5_000) });
  assert.match(long.content, /\[truncated\]$/);
  assert.ok(long.content.length < 4_200);
  assert.equal(long.meta.agent, "worker");
  for (const key of Object.keys(long.meta)) assert.match(key, /^[A-Za-z0-9_]+$/);

  const approval = formatChannelEvent({
    agent_id: "a1", backend: "codex", status: "needs_approval", request_id: "req-1", tool_name: "Bash", command: "npm test",
  });
  assert.match(approval.content, /needs approval\./);
  assert.match(approval.content, /request_id: req-1/);
  assert.match(approval.content, /command: npm test/);
});

test("a background agent's completion is pushed once; a foreground agent's is not", async () => {
  const { adapter, supervisor, settled } = harness();

  adapter.queueScript(completeScript("background result"));
  await supervisor.spawnAgent({ agent: "general", prompt: "p", description: "d", run_in_background: true });
  await waitUntil(() => settled.length === 1);
  assert.equal(settled[0]?.["status"], "completed");
  assert.match(String(settled[0]?.["name"]), /^[A-Z][a-z]+(-[A-Z][a-z]+)*$/);
  assert.equal(settled[0]?.["result"], "background result");

  adapter.queueScript(completeScript("foreground result"));
  const foreground = await supervisor.spawnAgent({ agent: "general", prompt: "p", description: "d" });
  assert.equal(foreground["status"], "completed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled.length, 1, "blocking callers already receive the outcome; no push");
});

test("a background send_message resume is pushed, a blocking one is not", async () => {
  const { adapter, supervisor, settled } = harness();
  adapter.queueScript(completeScript("first"));
  const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "p", description: "d" });
  const agent = spawned["agent_id"] as string;

  adapter.queueScript(completeScript("second"));
  await supervisor.sendMessage({ agent, prompt: "again" });
  assert.equal(settled.length, 0);

  adapter.queueScript(completeScript("third"));
  await supervisor.sendMessage({ agent, prompt: "again", run_in_background: true });
  await waitUntil(() => settled.length === 1);
  assert.equal(settled[0]?.["result"], "third");
});
