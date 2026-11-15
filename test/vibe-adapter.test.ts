import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import type { ResumeRequest, SpawnRequest } from "../src/adapters/adapter.js";
import { VibeAdapter } from "../src/adapters/vibe/adapter.js";
import { buildVibeArguments, composeVibePrompt, VibeAdapterError } from "../src/adapters/vibe/arguments.js";
import { parseVibeExport, parseVibeStreamEntry, vibeTerminal, VIBE_OUTCOMES } from "../src/adapters/vibe/parser.js";
import { ConfigRegistry, loadAgentConfig, loadModelsFile } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import type { AgentEvent } from "../src/events/schema.js";
import { Supervisor } from "../src/supervisor.js";
import { UsageLedger, remainingAllowances } from "../src/usage.js";

const fixture = path.join(process.cwd(), "test", "vibe-fixture.mjs");
const DEFAULT_SESSION = "44444444-4444-4444-8444-444444444444";
const allow = { allow: [], deny: [], default: "allow" as const };
const escalate = { allow: [], deny: [], default: "escalate" as const };

function spawnRequest(cwd: string, prompt: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    prompt,
    description: "fixture delegation",
    model: "devstral-2",
    cwd,
    systemPrompt: "",
    env: { SUBAGENT_MCP_DEPTH: "2", VIBE_FIXTURE_CUSTOM: "propagated" },
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

async function tempDir(label: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), `vibe-adapter-${label}-`)));
}

async function fixtureAdapter(extraEnv: Record<string, string> = {}, options: { keepOutputDirs?: boolean; outputRoot?: string } = {}) {
  const outputRoot = options.outputRoot ?? await tempDir("out");
  const adapter = new VibeAdapter({
    executable: process.execPath,
    executableArgs: [fixture],
    initTimeoutMs: 3_000,
    interruptGraceMs: 500,
    timeoutBackstopMs: 100,
    env: extraEnv,
    outputRoot,
    ...(options.keepOutputDirs === undefined ? {} : { keepOutputDirs: options.keepOutputDirs }),
  });
  return { adapter, outputRoot };
}

async function eventsThrough(adapter: VibeAdapter, agentId: string, predicate: (event: AgentEvent) => boolean, since = 0): Promise<AgentEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
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
  throw new Error("Timed out waiting for Vibe fixture event");
}

const completedTurn = (event: AgentEvent) => event.type === "turn.completed";

function completion(events: AgentEvent[]) {
  const event = events.find((candidate) => candidate.type === "turn.completed");
  assert.ok(event && event.type === "turn.completed");
  return event.data;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// --- Pure argument and parser behaviour -------------------------------------------------------

test("buildVibeArguments maps profiles, keeps the prompt off argv, and omits --model on resume", () => {
  const trusted = buildVibeArguments({ model: "devstral-2", cwd: "/w", permission: allow, outputDir: "/o", maxTurns: 7, timeoutMs: 1_500 });
  assert.deepEqual(trusted, [
    "--output", "streaming", "--output-dir", "/o", "--workdir", "/w", "--model", "devstral-2",
    "--max-turns", "7", "--time-limit", "2", "--auto-approve", "--trust", "-p",
  ]);
  const restricted = buildVibeArguments({ model: "devstral-2", cwd: "/w", permission: escalate, outputDir: "/o" }, "sess-1");
  assert.ok(!restricted.includes("--model"), "Vibe rejects --model on a resumed session");
  assert.deepEqual(restricted.slice(restricted.indexOf("--resume"), restricted.indexOf("--resume") + 2), ["--resume", "sess-1"]);
  assert.ok(!restricted.includes("--auto-approve") && !restricted.includes("--trust"));
  assert.deepEqual(restricted.slice(restricted.indexOf("--agent")), [
    "--agent", "ask", "--enabled-tools", "read_file", "--enabled-tools", "grep", "-p",
  ]);
  assert.ok(!trusted.includes("--worktree") && !trusted.includes("--continue"));
  const denied = buildVibeArguments({ model: "m", cwd: "/w", permission: { allow: [], deny: [], default: "deny" }, outputDir: "/o" });
  assert.ok(denied.includes("--enabled-tools"), "deny runs read-only, like escalate");
});

test("permission rules Vibe cannot enforce are refused, not ignored", () => {
  for (const permission of [
    { allow: [], deny: ["Bash(sudo:*)"], default: "allow" as const },
    { allow: ["Bash(npm test)"], deny: [], default: "escalate" as const },
  ]) {
    assert.throws(() => buildVibeArguments({ model: "m", cwd: "/w", permission, outputDir: "/o" }), VibeAdapterError);
  }
  assert.throws(() => buildVibeArguments({ model: "", cwd: "/w", permission: allow, outputDir: "/o" }), /explicit model/);
});

test("composeVibePrompt keeps Vibe's own instructions and adds the agent's in the conversation", () => {
  assert.equal(composeVibePrompt("", "task"), "task");
  assert.equal(composeVibePrompt("  be brief  ", "task"), "<subagent_instructions>\nbe brief\n</subagent_instructions>\n\n<task>\ntask\n</task>");
});

test("stream entries normalize messages, settled tools, denials and unknown kinds", () => {
  const message = parseVibeStreamEntry({ type: "message", sessionId: "s", role: "assistant", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] });
  assert.deepEqual(message, { kind: "message", sessionId: "s", role: "assistant", text: "a\n\nb", discarded: false });
  const denied = parseVibeStreamEntry({ type: "effect", id: "e1", sessionId: "s", detail: { toolName: "bash", input: { command: "ls" } }, state: { status: "failed", error: { code: "tool_denied", message: "no" } } });
  assert.equal(denied.kind === "tool" ? denied.status : undefined, "denied");
  const failed = parseVibeStreamEntry({ type: "effect", id: "e2", sessionId: "s", detail: { toolName: "bash" }, state: { status: "failed", error: { code: "x" } } });
  assert.equal(failed.kind === "tool" ? failed.status : undefined, "failed");
  const skipped = parseVibeStreamEntry({ type: "effect", id: "e3", sessionId: "s", detail: { toolName: "bash" }, state: { status: "skipped" } });
  assert.equal(skipped.kind === "tool" ? skipped.status : undefined, "denied");
  assert.equal(parseVibeStreamEntry({ type: "reasoning", sessionId: "s" }).kind, "other");
  assert.equal(parseVibeStreamEntry({ type: "message" }).kind, "invalid");
});

test("export outcomes map to terminal states; the exit code alone never decides", () => {
  const flags = { interruptRequested: false, timedOut: false };
  const expected: Record<string, string> = {
    finished: "completed", terminated: "interrupted", deadline: "failed", turn_limit: "failed", token_limit: "failed",
    price_limit: "failed", length: "failed", refusal: "failed", usage_error: "failed", config_error: "failed",
    infrastructure_failure: "failed", aborted: "failed",
  };
  for (const outcome of VIBE_OUTCOMES) {
    assert.equal(vibeTerminal({ outcome, warnings: [] }, flags).status, expected[outcome], outcome);
  }
  assert.equal(vibeTerminal({ outcome: "terminated", warnings: [] }, { interruptRequested: true, timedOut: true }).status, "failed");
  assert.equal(vibeTerminal({ outcome: "something_new", warnings: [] }, flags).error?.code, "VIBE_UNKNOWN_OUTCOME");
  assert.equal(vibeTerminal({ outcome: "finished", warnings: [] }, flags).error, undefined);

  const parsed = parseVibeExport({ outcome: "finished", session_id: "s", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 }, cost_usd: 0.5, warnings: [{ message: "w", source: null }] });
  assert.deepEqual(parsed?.usage, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, uncachedInputTokens: 6, costUsd: 0.5, costBasis: "estimated" });
  assert.deepEqual(parsed?.warnings, ["w"]);
  assert.equal(parseVibeExport({ session_id: "s" }), undefined, "an export without an outcome is not an export");
});

// --- Process lifecycle against the fixture ----------------------------------------------------

test("a turn adopts Vibe's session id, streams normalized events, and reads usage from the export", async () => {
  const cwd = await tempDir("normal");
  const invocation = path.join(cwd, "invocation.json");
  const { adapter, outputRoot } = await fixtureAdapter({ VIBE_FIXTURE_INVOCATION: invocation });
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "FIRST", { systemPrompt: "You are a subagent.", maxTurns: 9 }));
    assert.equal(turn.agentId, DEFAULT_SESSION);
    assert.equal(turn.backend, "vibe");
    const events = await eventsThrough(adapter, turn.agentId, completedTurn);
    assert.deepEqual(events.map((event) => event.type), ["thread.started", "tool.start", "tool.end", "message.delta", "turn.completed"]);
    const toolEnd = events.find((event) => event.type === "tool.end");
    assert.equal(toolEnd?.type === "tool.end" ? toolEnd.data.status : undefined, "completed");
    const done = completion(events);
    assert.equal(done.status, "completed");
    assert.equal(done.finalText, "done: fresh devstral-2", "discarded drafts are not the answer");
    assert.deepEqual(done.usage, { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 1000, uncachedInputTokens: 200, costUsd: 0.0042, costBasis: "estimated" });

    const data = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(data.cwd, cwd);
    assert.equal(data.workdir, cwd);
    assert.equal(data.customEnv, "propagated");
    assert.equal(data.model, "devstral-2");
    assert.equal(data.maxTurns, "9");
    assert.equal(data.timeLimit, "5");
    assert.equal(data.autoApprove, true);
    assert.equal(data.lastArg, "-p");
    assert.ok(!data.argv.some((arg: string) => arg.includes("FIRST")), "the prompt never goes on argv");
    assert.match(data.prompt, /<subagent_instructions>\nYou are a subagent\.\n<\/subagent_instructions>[\s\S]*FIRST/);
    const deadline = Date.now() + 2_000;
    while ((await readdir(outputRoot)).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await readdir(outputRoot), [], "per-turn output dirs are removed once read");
  } finally {
    await adapter.closeAll();
  }
});

test("resume runs --resume without --model, and works from a fresh adapter after a host restart", async () => {
  const cwd = await tempDir("resume");
  const invocation = path.join(cwd, "invocation.json");
  const { adapter } = await fixtureAdapter({ VIBE_FIXTURE_INVOCATION: invocation });
  const request = spawnRequest(cwd, "FIRST", { systemPrompt: "role" });
  try {
    const first = await adapter.spawn(request);
    await eventsThrough(adapter, first.agentId, completedTurn);
    const resumed = await adapter.resume(resumeRequest(request, first.agentId, "SECOND"));
    assert.equal(resumed.agentId, first.agentId);
    assert.notEqual(resumed.turnId, first.turnId);
    const events = await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed" && event.data.turnId === resumed.turnId);
    assert.equal(completion(events.filter((event) => event.type !== "turn.completed" || event.data.turnId === resumed.turnId)).finalText, "done: resumed (session model)");
    const data = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(data.resume, first.agentId);
    assert.equal(data.model, undefined);
    assert.equal(data.prompt, "SECOND", "instructions are sent once, at spawn");
  } finally {
    await adapter.closeAll();
  }

  const { adapter: restarted } = await fixtureAdapter({ VIBE_FIXTURE_INVOCATION: invocation });
  try {
    const turn = await restarted.resume(resumeRequest(request, DEFAULT_SESSION, "AFTER_RESTART"));
    assert.equal(turn.agentId, DEFAULT_SESSION);
    assert.equal(completion(await eventsThrough(restarted, turn.agentId, completedTurn)).status, "completed");
  } finally {
    await restarted.closeAll();
  }
});

test("a run that never opens a session fails the spawn with Vibe's reason, never a guessed id", async () => {
  const cwd = await tempDir("nosession");
  const { adapter } = await fixtureAdapter();
  try {
    await assert.rejects(adapter.spawn(spawnRequest(cwd, "NO_SESSION")), /usage_error.*unknown model alias/);
    await assert.rejects(adapter.spawn(spawnRequest(cwd, "CRASH_EARLY")), /wrote no export/);
  } finally {
    await adapter.closeAll();
  }
  const missing = new VibeAdapter({ executable: path.join(cwd, "no-such-vibe"), outputRoot: cwd });
  await assert.rejects(missing.spawn(spawnRequest(cwd, "FIRST")), /Vibe CLI not found/);
});

test("stop_agent lets Vibe write its export, emits one terminal event, and is not a fault", async () => {
  const cwd = await tempDir("interrupt");
  const { adapter } = await fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "HANG"));
    await Promise.all([adapter.interrupt(turn.agentId), adapter.interrupt(turn.agentId)]);
    const events = await eventsThrough(adapter, turn.agentId, completedTurn);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const all = adapter.buffer.read(turn.agentId, 0).events;
    assert.equal(all.filter((event) => event.type === "turn.completed").length, 1);
    const done = completion(events);
    assert.equal(done.status, "interrupted");
    assert.equal(done.finalText, "partial before stop", "partial output is kept");
    assert.ok(!events.some((event) => event.type === "error"));
  } finally {
    await adapter.closeAll();
  }
});

test("a Vibe that ignores SIGTERM is killed and the turn is interrupted", async () => {
  const cwd = await tempDir("kill");
  const { adapter } = await fixtureAdapter();
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "IGNORE_TERM"));
    await adapter.interrupt(turn.agentId);
    assert.equal(completion(await eventsThrough(adapter, turn.agentId, completedTurn)).status, "interrupted");
  } finally {
    await adapter.closeAll();
  }
});

test("the timeout backstop fails the turn with a timeout error", async () => {
  const cwd = await tempDir("timeout");
  const { adapter } = await fixtureAdapter();
  try {
    // Long enough for the fixture to open its session under a loaded parallel test run; HANG never ends on its own.
    const turn = await adapter.spawn(spawnRequest(cwd, "HANG", { timeoutMs: 1_500 }));
    const events = await eventsThrough(adapter, turn.agentId, completedTurn);
    const error = events.find((event) => event.type === "error");
    assert.equal(error?.type === "error" ? error.data.code : undefined, "VIBE_TURN_TIMEOUT");
    assert.equal(completion(events).status, "failed");
  } finally {
    await adapter.closeAll();
  }
});

test("missing, torn, or mismatched exports are failures that keep partial output", async () => {
  const cwd = await tempDir("export");
  const { adapter } = await fixtureAdapter();
  try {
    for (const [prompt, code] of [["NO_EXPORT", "VIBE_EXPORT_MISSING"], ["BAD_EXPORT", "VIBE_EXPORT_MISSING"], ["WRONG_EXPORT_SESSION", "VIBE_PROTOCOL_ERROR"]] as const) {
      const turn = await adapter.spawn(spawnRequest(cwd, prompt, { env: { VIBE_FIXTURE_SESSION_ID: `sess-${prompt}` } }));
      const events = await eventsThrough(adapter, turn.agentId, completedTurn);
      const error = events.find((event) => event.type === "error");
      assert.equal(error?.type === "error" ? error.data.code : undefined, code, prompt);
      const done = completion(events);
      assert.equal(done.status, "failed", prompt);
      assert.equal(done.finalText, "done: fresh devstral-2", prompt);
    }
  } finally {
    await adapter.closeAll();
  }
});

test("budget stops, infrastructure failures, denials, subagent entries and malformed lines", async () => {
  const cwd = await tempDir("outcomes");
  const { adapter } = await fixtureAdapter();
  const run = async (prompt: string) => {
    const turn = await adapter.spawn(spawnRequest(cwd, prompt, { env: { VIBE_FIXTURE_SESSION_ID: `sess-${prompt}` } }));
    return eventsThrough(adapter, turn.agentId, completedTurn);
  };
  try {
    const limit = await run("LIMIT");
    const limitError = limit.find((event) => event.type === "error");
    assert.ok(limitError?.type === "error" && limitError.data.code === "VIBE_LIMIT_REACHED" && !limitError.data.fatal);
    assert.equal(completion(limit).status, "failed");
    assert.ok(completion(limit).usage, "a budget stop still reports its usage");

    const infra = await run("INFRA");
    const infraError = infra.find((event) => event.type === "error");
    assert.ok(infraError?.type === "error" && infraError.data.fatal && /model API unavailable/.test(infraError.data.message));

    const denied = await run("DENIED");
    const end = denied.find((event) => event.type === "tool.end");
    assert.equal(end?.type === "tool.end" ? end.data.status : undefined, "denied");
    assert.equal(completion(denied).status, "completed");

    const subagent = await run("SUBAGENT");
    assert.equal(subagent.filter((event) => event.type === "tool.start").length, 1, "the child session's tool call is not this agent's");
    assert.ok(!subagent.some((event) => event.type === "message.delta" && event.data.text.includes("subagent chatter")));

    const malformed = await run("MALFORMED");
    const warning = malformed.find((event) => event.type === "error");
    assert.ok(warning?.type === "error" && warning.data.code === "VIBE_PROTOCOL_WARNING" && !warning.data.fatal);
    assert.equal(completion(malformed).status, "completed", "the export stays authoritative");

    const warned = await run("WARN");
    assert.equal(completion(warned).status, "completed");
  } finally {
    await adapter.closeAll();
  }
});

test("independent sessions run concurrently without crossing events", async () => {
  const cwd = await tempDir("concurrent");
  const { adapter } = await fixtureAdapter();
  try {
    const turns = await Promise.all(["a", "b", "c"].map((id) =>
      adapter.spawn(spawnRequest(cwd, "FIRST", { env: { VIBE_FIXTURE_SESSION_ID: `sess-${id}` } }))));
    assert.deepEqual(turns.map((turn) => turn.agentId).sort(), ["sess-a", "sess-b", "sess-c"]);
    for (const turn of turns) {
      const events = await eventsThrough(adapter, turn.agentId, completedTurn);
      assert.ok(events.every((event) => event.agentId === turn.agentId));
      assert.equal(completion(events).status, "completed");
    }
    await assert.rejects(adapter.approve("sess-a", { requestId: "r", decision: "allow" } as never), /does not expose approval/);
  } finally {
    await adapter.closeAll();
  }
});

// --- Supervisor, config and usage integration ------------------------------------------------

test("supervisor runs a Vibe agent end to end with structured results and estimated cost accounting", async () => {
  const cwd = await tempDir("supervisor");
  const agentConfig: AgentConfig = {
    name: "vibe-general",
    backend: "vibe",
    model: "devstral-2",
    description: "Fixture Vibe agent",
    systemPrompt: "role",
    permission: allow,
    env: {},
    sourcePath: "test-fixture",
  };
  const roster: ModelRoster = { claude: [], codex: [], opencode: [], antigravity: [], cursor: [], copilot: [], vibe: [{ name: "devstral-2" }] };
  const { adapter } = await fixtureAdapter();
  const usage = new UsageLedger();
  const supervisor = new Supervisor({
    registry: new ConfigRegistry([agentConfig], roster),
    adapters: new AdapterRegistry([adapter]),
    cwd,
    usage,
  });
  try {
    const result = await supervisor.spawnAgent({
      agent: "vibe-general",
      prompt: "JSON_ANSWER",
      description: "d",
      result_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    });
    assert.equal(result["status"], "completed");
    assert.equal(result["backend"], "vibe");
    assert.deepEqual(result["structured_result"], { ok: true });
    const resumed = await supervisor.sendMessage({ agent: result["agent_id"] as string, prompt: "SECOND" });
    assert.equal(resumed["status"], "completed");

    const snapshot = usage.snapshot();
    assert.equal(snapshot.vibe.turns, 2);
    assert.equal(snapshot.vibe.costUsd, 0, "an estimate is never booked as reported cost");
    assert.ok(Math.abs(snapshot.vibe.estimatedCostUsd - 0.0084) < 1e-9);
    assert.equal(snapshot.vibe.inputTokens, 2400, "each export counts its own run only: no double counting on resume");
    const remaining = remainingAllowances({ vibe: { maxCostUsd: 1 } }, snapshot);
    assert.ok(Math.abs((remaining.vibe?.costUsd ?? 0) - (1 - 0.0084)) < 1e-9, "estimates still count against a cost allowance");

    await assert.rejects(
      supervisor.spawnAgent({ agent: "vibe-general", prompt: "x", description: "d", effort: "high" }),
      /does not honor effort/,
    );
  } finally {
    await adapter.closeAll();
  }
});

test("models.yaml may omit vibe, and a vibe roster and agent config load", async () => {
  const dir = await tempDir("config");
  const legacy = path.join(dir, "legacy.yaml");
  await writeFile(legacy, "models:\n  claude: []\n  codex: []\n  opencode: []\n");
  assert.deepEqual((await loadModelsFile(legacy)).roster.vibe, []);
  const withVibe = path.join(dir, "models.yaml");
  await writeFile(withVibe, "models:\n  claude: []\n  codex: []\n  opencode: []\n  vibe:\n    - name: devstral-2\n      description: Vibe default\n");
  assert.deepEqual((await loadModelsFile(withVibe)).roster.vibe, [{ name: "devstral-2", description: "Vibe default" }]);
  await writeFile(path.join(dir, "broken.yaml"), "models:\n  claude: []\n  codex: []\n  opencode: []\n  vibe: devstral-2\n");
  await assert.rejects(loadModelsFile(path.join(dir, "broken.yaml")), /models\.vibe must be an array/);

  const agents = path.join(dir, "agents");
  await mkdir(agents);
  await writeFile(path.join(agents, "vibe-general.md"), await readFile(path.join(process.cwd(), ".subagents", "vibe-general.md"), "utf8"));
  const config = await loadAgentConfig(path.join(agents, "vibe-general.md"));
  assert.equal(config.backend, "vibe");
  assert.deepEqual(config.permission.allow, []);
  assert.deepEqual(config.permission.deny, [], "the sample config must be one the Vibe adapter accepts");
});
