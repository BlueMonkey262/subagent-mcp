import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import type { SpawnRequest } from "../src/adapters/adapter.js";
import { VibeAcpAdapter } from "../src/adapters/vibe/acp-adapter.js";
import { toolCallFromUpdate, toolEndStatus, turnUsage } from "../src/adapters/vibe/acp-events.js";
import { selectPermissionOption, supportedDecisions, vibeAcpToolEnv } from "../src/adapters/vibe/acp-permissions.js";
import { VibeAdapter } from "../src/adapters/vibe/adapter.js";
import { ConfigRegistry, loadAgentConfig } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster, PermissionConfig } from "../src/config/schema.js";
import type { AgentEvent } from "../src/events/schema.js";
import { Supervisor } from "../src/supervisor.js";

const fixture = path.join(process.cwd(), "test", "vibe-acp-fixture.mjs");
const escalate: PermissionConfig = { allow: [], deny: [], default: "escalate" };
const VIBE_OPTIONS = [
  { optionId: "allow_once", kind: "allow_once" },
  { optionId: "allow_always", kind: "allow_always" },
  { optionId: "allow_always_permanent", kind: "allow_always" },
  { optionId: "reject_once", kind: "reject_once" },
];

async function tempDir(label: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), `vibe-acp-${label}-`)));
}

async function harness(env: Record<string, string> = {}, options: { idleTimeoutMs?: number; interruptGraceMs?: number } = {}) {
  const dir = await tempDir("h");
  const logPath = path.join(dir, "log.jsonl");
  const statePath = path.join(dir, "state.json");
  const make = () => new VibeAcpAdapter({
    executable: process.execPath,
    executableArgs: [fixture],
    env: { VIBE_ACP_FIXTURE_LOG: logPath, VIBE_ACP_FIXTURE_STATE: statePath, ...env },
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    usageBaselineWaitMs: 500,
    interruptGraceMs: options.interruptGraceMs ?? 1_000,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
  const entries = async () => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { dir, make, entries };
}

function request(cwd: string, prompt: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return { prompt, description: "d", model: "zai-glm-5-3-flash", cwd, systemPrompt: "", env: {}, permission: escalate, timeoutMs: 5_000, ...overrides };
}

async function until(adapter: VibeAcpAdapter, agentId: string, predicate: (event: AgentEvent) => boolean, since = 0): Promise<AgentEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8_000);
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
  throw new Error(`timed out; saw ${events.map((event) => event.type).join(",")}`);
}
const completed = (event: AgentEvent) => event.type === "turn.completed";
const done = (events: AgentEvent[]) => {
  const last = events.at(-1)!;
  assert.equal(last.type, "turn.completed");
  return last.data as unknown as { status: string; finalText?: string; usage?: Record<string, unknown> };
};

// ------------------------------------------------------------------ pure mappings

test("permission selection never picks a persistent option and fails closed", () => {
  assert.deepEqual(selectPermissionOption("allow", VIBE_OPTIONS), { outcome: "selected", optionId: "allow_once" });
  assert.deepEqual(selectPermissionOption("allow_for_session", VIBE_OPTIONS), { outcome: "selected", optionId: "allow_always" });
  assert.deepEqual(selectPermissionOption("deny", VIBE_OPTIONS), { outcome: "selected", optionId: "reject_once" });
  const permanentOnly = [{ optionId: "allow_always_permanent", kind: "allow_always" }];
  assert.equal(selectPermissionOption("allow_for_session", permanentOnly), undefined);
  assert.equal(selectPermissionOption("allow", permanentOnly), undefined);
  assert.deepEqual(selectPermissionOption("deny", permanentOnly), { outcome: "cancelled" });
  const scoped = [{ optionId: "allow_once" }, { optionId: "allow_session_directory_recursive" }, { optionId: "allow_session_exact" }, { optionId: "allow_permanent_exact" }, { optionId: "reject_once" }];
  assert.deepEqual(selectPermissionOption("allow_for_session", scoped), { outcome: "selected", optionId: "allow_session_exact" }, "narrowest scope first");
  assert.deepEqual(supportedDecisions([{ optionId: "allow_once" }, { optionId: "reject_once" }]), ["allow", "deny"]);
});

test("tool env empties Vibe's shell allowlists and makes every tool a deny rule names ask", () => {
  const base = { VIBE_TOOLS__BASH__ALLOWLIST: "[]", VIBE_TOOLS__GIT_BASH__ALLOWLIST: "[]", VIBE_TOOLS__POWERSHELL__ALLOWLIST: "[]" };
  assert.deepEqual(vibeAcpToolEnv([]), base);
  assert.deepEqual(vibeAcpToolEnv(["Read(**/.env)", "Bash(rm:*)"]), {
    ...base, VIBE_TOOLS__READ_FILE__PERMISSION: "ask",
    VIBE_TOOLS__BASH__PERMISSION: "ask", VIBE_TOOLS__GIT_BASH__PERMISSION: "ask", VIBE_TOOLS__POWERSHELL__PERMISSION: "ask",
  });
  const all = vibeAcpToolEnv(["*"]);
  for (const tool of ["READ_FILE", "GREP", "WRITE_FILE", "EDIT", "WEB_FETCH", "WEB_SEARCH"]) assert.equal(all[`VIBE_TOOLS__${tool}__PERMISSION`], "ask");
  assert.equal(vibeAcpToolEnv(["skill"]).VIBE_TOOLS__SKILL__PERMISSION, "ask", "an unmapped tool name is passed through");
});

test("tool calls map to policy names, commands and absolute paths; denials are told apart", () => {
  const call = toolCallFromUpdate({ toolCallId: "e1", title: "Writing x", kind: "edit", locations: [{ path: "/w/x" }], rawInput: { filePath: "x" }, _meta: { tool_name: "write_file" } });
  assert.deepEqual(call, { toolCallId: "e1", toolName: "Write", vibeTool: "write_file", title: "Writing x", input: { filePath: "x" }, paths: ["/w/x"] });
  assert.equal(toolCallFromUpdate({ toolCallId: "e2", rawInput: { command: "ls" }, _meta: { tool_name: "bash" } })?.command, "ls");
  assert.equal(toolEndStatus({ status: "failed", rawOutput: { error: { code: "tool_denied" } } }), "denied");
  assert.equal(toolEndStatus({ status: "failed" }), "failed");
  assert.equal(toolEndStatus({ status: "in_progress" }), undefined);
  assert.deepEqual(turnUsage({ inputTokens: 150, outputTokens: 15, cachedInputTokens: 60, costUsd: 0.03 }, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, costUsd: 0.01 }, "mistral"),
    { inputTokens: 50, outputTokens: 5, cachedInputTokens: 20, uncachedInputTokens: 30, costUsd: 0.02, costBasis: "estimated", provider: "mistral" });
  assert.equal(turnUsage({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, undefined), undefined, "no baseline, no guess");
});

// ------------------------------------------------------------------ the transport against the fixture

test("a turn runs in ask mode with the model from the environment, never written to Vibe's config", async () => {
  const h = await harness();
  const adapter = h.make();
  try {
    const turn = await adapter.spawn(request(h.dir, "hi", { systemPrompt: "role", maxTurns: 7, vibeMaxTokens: 900 }));
    assert.equal(turn.agentId, "acp:acp-sess-1");
    const events = await until(adapter, turn.agentId, completed);
    assert.deepEqual(events.map((event) => event.type), ["thread.started", "usage.updated", "message.delta", "message.delta", "usage.updated", "turn.completed"]);
    const result = done(events);
    assert.equal(result.status, "completed");
    assert.equal(result.finalText, "Hello world");
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, uncachedInputTokens: 60, costUsd: 0.01, costBasis: "estimated" });
    const log = await h.entries();
    assert.ok(log.every((entry) => entry.model === "zai-glm-5-3-flash"), "VIBE_ACTIVE_MODEL set for the process");
    assert.ok(!log.some((entry) => entry.method === "session/set_config_option" && (entry.params as { configId: string }).configId === "model"), "the model option would rewrite ~/.vibe/config.toml");
    assert.deepEqual(log.filter((entry) => entry.method === "session/set_mode").map((entry) => (entry.params as { modeId: string }).modeId), ["ask"]);
    assert.deepEqual(log.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params), [
      { sessionId: "acp-sess-1", configId: "max_turns", value: "7" },
      { sessionId: "acp-sess-1", configId: "max_tokens", value: "900" },
    ]);
    assert.match(String(log.find((entry) => entry.method === "session/prompt")?.text), /<subagent_instructions>\nrole/);
  } finally {
    await adapter.closeAll();
  }
});

test("an alias Vibe does not run is refused instead of silently using the default model", async () => {
  const h = await harness();
  const adapter = h.make();
  await assert.rejects(adapter.spawn(request(h.dir, "hi", { model: "unknown-alias" })), /running model "mistral-medium-3\.5", not "unknown-alias"/);
  await assert.rejects(adapter.spawn(request(h.dir, "hi", { vibeMaxPriceUsd: 1 })), /not available over ACP/);
});

test("permission requests become approvals; each decision maps to Vibe's option, never the permanent one", async () => {
  for (const [decision, expected, status] of [["allow", "allow_once", "completed"], ["allow_for_session", "allow_always", "completed"], ["deny", "reject_once", "denied"]] as const) {
    const h = await harness();
    const adapter = h.make();
    try {
      const turn = await adapter.spawn(request(h.dir, "APPROVE"));
      const asked = await until(adapter, turn.agentId, (event) => event.type === "approval.requested");
      const approval = asked.at(-1)!.data as unknown as { requestId: string; toolName: string; paths?: string[]; cwd: string; reason?: string };
      assert.equal(approval.toolName, "Write");
      assert.deepEqual(approval.paths, [path.join(h.dir, "out.txt")]);
      assert.equal(approval.reason, "Writing out.txt");
      await adapter.approve(turn.agentId, { requestId: approval.requestId, decision });
      const events = await until(adapter, turn.agentId, completed, asked.at(-1)!.sequence);
      assert.equal(events.find((event) => event.type === "tool.end")?.data.status as string, status);
      assert.equal(done(events).finalText, `done:${expected}`);
      assert.equal(((await h.entries()).find((entry) => entry.method === "permission-response")?.response as { outcome: { optionId: string } }).outcome.optionId, expected);
      await assert.rejects(adapter.approve(turn.agentId, { requestId: approval.requestId, decision: "allow" }), /No pending Vibe approval/);
    } finally {
      await adapter.closeAll();
    }
  }
});

test("a decision Vibe did not offer fails closed and leaves the request answerable", async () => {
  const h = await harness({ VIBE_ACP_FIXTURE_OPTIONS: "once_only" });
  const adapter = h.make();
  try {
    const turn = await adapter.spawn(request(h.dir, "APPROVE SHELL"));
    const asked = await until(adapter, turn.agentId, (event) => event.type === "approval.requested");
    const approval = asked.at(-1)!.data as unknown as { requestId: string; toolName: string; command?: string };
    assert.equal(approval.toolName, "Bash");
    assert.equal(approval.command, "rm -rf build");
    await assert.rejects(adapter.approve(turn.agentId, { requestId: approval.requestId, decision: "allow_for_session" }), /answer with one of: allow, deny/);
    await adapter.approve(turn.agentId, { requestId: approval.requestId, decision: "deny" });
    assert.equal(done(await until(adapter, turn.agentId, completed, asked.at(-1)!.sequence)).finalText, "done:reject_once");
  } finally {
    await adapter.closeAll();
  }
});

test("a fresh adapter resumes the session, and only the new turn's usage is reported", async () => {
  const h = await harness();
  const first = h.make();
  const turn = await first.spawn(request(h.dir, "hi"));
  await until(first, turn.agentId, completed);
  await first.closeAll();
  const second = h.make();
  try {
    const resumed = await second.resume({ agentId: turn.agentId, prompt: "again", cwd: h.dir, model: "zai-glm-5-3-flash", systemPrompt: "", env: {}, permission: escalate, timeoutMs: 5_000 });
    assert.equal(resumed.agentId, turn.agentId);
    const result = done(await until(second, turn.agentId, completed));
    assert.equal(result.usage?.inputTokens, 100, "the session's earlier 100 tokens are the baseline, not this turn's");
    const methods = (await h.entries()).map((entry) => entry.method);
    assert.ok(methods.includes("session/resume"));
  } finally {
    await second.closeAll();
  }
});

test("without session/resume, session/load is used and its replayed history is not emitted", async () => {
  const h = await harness({ VIBE_ACP_FIXTURE_NO_RESUME: "1" });
  const adapter = h.make();
  try {
    const turn = await adapter.resume({ agentId: "acp:acp-sess-1", prompt: "hi", cwd: h.dir, model: "zai-glm-5-3-flash", systemPrompt: "", env: {}, permission: escalate, timeoutMs: 5_000 });
    const events = await until(adapter, turn.agentId, completed);
    assert.ok(!events.some((event) => event.type === "message.delta" && String(event.data.text).includes("OLD HISTORY")));
    assert.ok(!events.some((event) => event.type === "tool.start"));
    assert.equal(done(events).finalText, "Hello world");
  } finally {
    await adapter.closeAll();
  }
});

test("interrupt cancels the turn and answers an open permission request as cancelled", async () => {
  const h = await harness();
  const adapter = h.make();
  try {
    const turn = await adapter.spawn(request(h.dir, "SLOW PERMISSION"));
    await until(adapter, turn.agentId, (event) => event.type === "approval.requested");
    await adapter.interrupt(turn.agentId);
    const result = done(await until(adapter, turn.agentId, completed));
    assert.equal(result.status, "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const answered = (await h.entries()).find((entry) => entry.method === "permission-after-cancel");
    assert.deepEqual(answered?.response, { outcome: { outcome: "cancelled" } });
  } finally {
    await adapter.closeAll();
  }
});

test("a timeout fails the turn; an agent that ignores cancel is killed after the grace period", async () => {
  const h = await harness({}, { interruptGraceMs: 200 });
  const adapter = h.make();
  try {
    const slow = await adapter.spawn(request(h.dir, "SLOW", { timeoutMs: 200 }));
    const events = await until(adapter, slow.agentId, completed);
    assert.equal(done(events).status, "failed");
    assert.ok(events.some((event) => event.type === "error" && event.data.code === "VIBE_TURN_TIMEOUT"));
    const stuck = await adapter.resume({ agentId: slow.agentId, prompt: "SLOW IGNORE_CANCEL", cwd: h.dir, model: "zai-glm-5-3-flash", systemPrompt: "", env: {}, permission: escalate });
    const since = events.at(-1)!.sequence;
    await adapter.interrupt(stuck.agentId);
    assert.equal(done(await until(adapter, stuck.agentId, completed, since)).status, "interrupted");
  } finally {
    await adapter.closeAll();
  }
});

test("a crash fails the turn with Vibe's stderr, and the next message resumes in a new process", async () => {
  const h = await harness();
  const adapter = h.make();
  try {
    const turn = await adapter.spawn(request(h.dir, "CRASH"));
    const events = await until(adapter, turn.agentId, completed);
    assert.equal(done(events).status, "failed");
    const error = events.find((event) => event.type === "error");
    assert.equal(error?.data.code, "VIBE_ACP_EXITED");
    assert.match(JSON.stringify(error?.data.details), /fixture crashed/);
    await adapter.resume({ agentId: turn.agentId, prompt: "hi", cwd: h.dir, model: "zai-glm-5-3-flash", systemPrompt: "", env: {}, permission: escalate, timeoutMs: 5_000 });
    assert.equal(done(await until(adapter, turn.agentId, completed, events.at(-1)!.sequence)).status, "completed");
    assert.equal(new Set((await h.entries()).map((entry) => entry.pid)).size, 2);
  } finally {
    await adapter.closeAll();
  }
});

test("an idle process is closed, the next turn reattaches; fs requests and limits are handled", async () => {
  const h = await harness({}, { idleTimeoutMs: 100 });
  const adapter = h.make();
  try {
    const turn = await adapter.spawn(request(h.dir, "FSREQ"));
    const first = await until(adapter, turn.agentId, completed);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const log = await h.entries();
    assert.deepEqual((log.find((entry) => entry.method === "fs-response")?.response as { error: { code: number } }).error.code, -32601);
    await adapter.resume({ agentId: turn.agentId, prompt: "LIMIT", cwd: h.dir, model: "zai-glm-5-3-flash", systemPrompt: "", env: {}, permission: escalate, timeoutMs: 5_000 });
    const events = await until(adapter, turn.agentId, completed, first.at(-1)!.sequence);
    assert.equal(done(events).status, "failed");
    assert.ok(events.some((event) => event.type === "error" && event.data.code === "VIBE_LIMIT_REACHED"));
    assert.equal(new Set((await h.entries()).map((entry) => entry.pid)).size, 2, "the idle process was replaced");
  } finally {
    await adapter.closeAll();
  }
});

// ------------------------------------------------------------------ config and supervisor

test("vibeTransport loads, is refused off Vibe, and acp refuses an unenforceable price cap", async () => {
  const dir = await tempDir("cfg");
  const file = path.join(dir, "acp.md");
  const write = (extra: string) => writeFile(file, `---\nname: acp\nbackend: vibe\ndescription: d\n${extra}permission:\n  allow: []\n  deny: []\n  default: escalate\n---\n`);
  await write("vibeTransport: acp\n");
  const agent = await loadAgentConfig(file);
  assert.equal(agent.vibeTransport, "acp");
  const roster: ModelRoster = { claude: [], codex: [{ name: "sol" }], opencode: [], antigravity: [], cursor: [], copilot: [], vibe: [{ name: "m" }] };
  assert.throws(() => new ConfigRegistry([agent], roster).resolveAgent({ agent: "acp", backend: "codex", model: "sol" }), /only applies to the Vibe backend/);
  await write("vibeTransport: acp\nvibeMaxPriceUsd: 1\n");
  const priced = await loadAgentConfig(file);
  assert.throws(() => new ConfigRegistry([priced], roster).resolveAgent({ agent: "acp", model: "m" }), /vibe-acp cannot enforce/);
  await write("vibeTransport: sse\n");
  await assert.rejects(loadAgentConfig(file), /must be "cli" or "acp"/);
});

test("supervisor: deny rules answer Vibe without asking; dangerous requests wait for resolve_approval", async () => {
  const h = await harness();
  const agent: AgentConfig = {
    name: "vibe-acp", backend: "vibe", model: "zai-glm-5-3-flash", vibeTransport: "acp", description: "d", systemPrompt: "",
    permission: { allow: [], deny: ["Write(**/out.txt)"], default: "escalate" }, env: {}, sourcePath: "test",
  };
  const roster: ModelRoster = { claude: [], codex: [], opencode: [], antigravity: [], cursor: [], copilot: [], vibe: [{ name: "zai-glm-5-3-flash" }] };
  const vibe = new VibeAdapter({ acp: {
    executable: process.execPath, executableArgs: [fixture], startupTimeoutMs: 5_000, usageBaselineWaitMs: 500,
    env: { VIBE_ACP_FIXTURE_LOG: path.join(h.dir, "log.jsonl"), VIBE_ACP_FIXTURE_STATE: path.join(h.dir, "state.json") },
  } });
  const supervisor = new Supervisor({ registry: new ConfigRegistry([agent], roster), adapters: new AdapterRegistry([vibe]), cwd: h.dir });
  try {
    const denied = await supervisor.spawnAgent({ agent: "vibe-acp", prompt: "APPROVE", description: "d" });
    assert.equal(denied.status, "completed");
    assert.equal(denied.result, "done:reject_once", "the deny rule answered without escalating");
    assert.match(String(denied.agent_id), /^acp:/);

    // rm -rf is a dangerous command: escalated to the orchestrator whatever the default.
    const asked = await supervisor.sendMessage({ agent: String(denied.agent_id), prompt: "APPROVE SHELL" });
    assert.equal(asked.status, "needs_approval");
    assert.equal(asked.tool_name, "Bash");
    assert.equal(asked.command, "rm -rf build");
    const requestId = String(asked.request_id);
    const resolved = await supervisor.resolveApproval(requestId, "allow");
    assert.equal(resolved.status, "completed");
    assert.equal(resolved.result, "done:allow_once");
  } finally {
    await vibe.closeAll();
  }
});
