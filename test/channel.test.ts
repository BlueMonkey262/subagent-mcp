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
    registry: new ConfigRegistry([agentConfig], { claude: [], codex: [{ name: "fake-model" }], opencode: [], antigravity: [], cursor: [], copilot: [], vibe: [] }),
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

test('background Codex origins survive snapshots and are not exposed in ordinary results', async () => {
  const { adapter, supervisor, settled } = harness();
  adapter.queueScript([]);
  const thread = '01a1e113-23c3-7203-a5ca-cc754be5b4df';
  const receipt = await supervisor.spawnAgent({ agent: 'general', prompt: 'p', description: 'd', run_in_background: true, codexThread: thread });
  const id = String(receipt.agent_id);
  assert.equal(receipt.codex_thread, undefined);
  assert.equal(supervisor.exportSnapshot()[0]?.meta?.codexThread, thread);
  adapter.emit(id, 'turn.completed', { turnId: 'one', status: 'completed', finalText: 'done' });
  await waitUntil(() => settled.length === 1);
  assert.equal(settled[0]?.codex_thread, thread);
});

test('queued pings can be selectively delivered without consuming another client target', async () => {
  const { supervisor } = harness();
  await supervisor.enqueueUndeliveredPing({ agent_id: 'claude' });
  await supervisor.enqueueUndeliveredPing({ agent_id: 'codex', codex_thread: 'thread' });
  const delivered: unknown[] = [];
  await supervisor.flushUndeliveredPings(event => { if (event.codex_thread) return false; delivered.push(event.agent_id); return true; });
  assert.deepEqual(delivered, ['claude']);
  assert.equal(supervisor.hasUndeliveredCodexPings(), true);
  await supervisor.flushUndeliveredPings(event => event.codex_thread === 'thread');
  assert.equal(supervisor.undeliveredPingCount(), 0);
});

test('a queued message does not redirect an in-flight approval to a different Codex thread', async () => {
  const { adapter, supervisor, settled } = harness();
  const first = '01a1e113-23c3-7203-a5ca-cc754be5b4df';
  const second = '01a1e113-23c3-7203-a5ca-cc754be5b4de';
  adapter.queueScript([]);
  const receipt = await supervisor.spawnAgent({ agent: 'general', prompt: 'p', description: 'd', run_in_background: true, codexThread: first });
  const id = String(receipt.agent_id);
  await supervisor.sendMessage({ agent: id, prompt: 'later', run_in_background: true, codexThread: second });
  adapter.emit(id, 'approval.requested', { requestId: 'route-request', agentId: id, backend: 'codex', toolName: 'Bash', input: {}, cwd: '/work', requestedAt: new Date().toISOString() });
  await waitUntil(() => settled.length > 0);
  assert.equal(settled[0]?.codex_thread, first);
});
