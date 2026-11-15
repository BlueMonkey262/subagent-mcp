import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { toolInputReady } from "../src/adapters/opencode/adapter.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { buildDashboard } from "../src/dashboard.js";
import { snapshotWorkingTree } from "../src/execution.js";
import { Supervisor } from "../src/supervisor.js";

const exec = promisify(execFile);
const permission = { allow: [], deny: [], default: "escalate" as const };

function registry(): ConfigRegistry {
  const roster: ModelRoster = { claude: [], codex: [{ name: "fake-model" }], opencode: [], antigravity: [], cursor: [], copilot: [], vibe: [] };
  const agent: AgentConfig = {
    name: "general", backend: "codex", model: "fake-model", description: "General agent", systemPrompt: "",
    permission, env: {}, sourcePath: "test-fixture",
  };
  return new ConfigRegistry([agent], roster);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture() {
  const adapter = new FakeAdapter("codex");
  const supervisor = new Supervisor({ registry: registry(), adapters: new AdapterRegistry([adapter]), cwd: "/work" });
  return { adapter, supervisor };
}

test("a fatal error followed by turn.completed records the turn once, with its usage and the first error", async () => {
  const { adapter, supervisor } = fixture();
  const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "work", description: "timeout", run_in_background: true });
  const id = spawned["agent_id"] as string;
  adapter.emit(id, "usage.updated", { turnId: "t1", usage: { inputTokens: 500, outputTokens: 20, cachedInputTokens: 0, uncachedInputTokens: 500, costUsd: 0 } });
  adapter.emit(id, "error", { code: "CODEX_TURN_TIMEOUT", message: "turn exceeded", fatal: true });
  await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === id && agent["state"] === "failed"));
  adapter.emit(id, "turn.completed", { turnId: "t1", status: "failed", finalText: "partial", usage: { inputTokens: 520, outputTokens: 25, cachedInputTokens: 0, uncachedInputTokens: 520, costUsd: 0 } });
  const turnsOf = () => (supervisor.getAgentResult(id) as Record<string, unknown>)["turns"] as Record<string, unknown>[];
  await waitUntil(() => turnsOf().some((turn) => turn["turn_id"] === "t1"));

  const turns = turnsOf();
  assert.equal(turns.length, 1, "one history entry for the turn");
  assert.equal(turns[0]?.["result"], "partial");
  assert.deepEqual(turns[0]?.["error"], { code: "CODEX_TURN_TIMEOUT", message: "turn exceeded" });
  const usage = supervisor.listAgents().find((agent) => agent["agent_id"] === id)?.["cumulative_usage"] as Record<string, unknown>;
  assert.equal(usage["inputTokens"], 520, "cumulative usage stays known");
});

test("phase and last_tool: tool while a call is open, thinking between calls, last tool kept", async () => {
  const { adapter, supervisor } = fixture();
  const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "work", description: "phase", run_in_background: true });
  const id = spawned["agent_id"] as string;
  const agent = () => supervisor.listAgents().find((entry) => entry["agent_id"] === id)!;
  await waitUntil(() => agent()["state"] === "running");
  assert.equal(agent()["phase"], "thinking");
  assert.equal(agent()["last_tool"], null);

  adapter.emit(id, "tool.start", { toolCallId: "c1", toolName: "shell", input: { command: "git diff --stat" } });
  await waitUntil(() => agent()["phase"] === "tool");
  assert.match(String(agent()["current_activity"]), /shell/);
  adapter.emit(id, "tool.end", { toolCallId: "c1", status: "completed" });
  await waitUntil(() => agent()["phase"] === "thinking");
  assert.equal(agent()["current_activity"], null);
  assert.match(String(agent()["last_tool"]), /git diff --stat/);
  const summary = supervisor.summarizeAgentEvents(id, 5, 0);
  assert.equal(summary["phase"], "thinking");
  assert.match(String(summary["last_tool"]), /git diff/);

  adapter.emit(id, "turn.completed", { turnId: "t1", status: "completed", finalText: "done" });
  await waitUntil(() => agent()["phase"] === "completed");
});

test("get_dashboard lists approvals and returns only the revision while nothing changes", async () => {
  const { adapter, supervisor } = fixture();
  adapter.queueScript([{
    create: (context) => ({
      type: "approval.requested", agentId: context.agentId, backend: context.backend,
      data: {
        requestId: "req-1", agentId: context.agentId, backend: "codex" as const, toolName: "Bash",
        input: { command: "npm test" }, command: "npm test", cwd: "/work", requestedAt: new Date().toISOString(),
      },
    }),
  }]);
  const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "work", description: "dash", run_in_background: true });
  const id = spawned["agent_id"] as string;
  await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === id && agent["state"] === "needs_approval"));

  const first = buildDashboard(supervisor, undefined);
  assert.equal((first["agents"] as unknown[]).length, 1);
  assert.deepEqual((first["approvals"] as Record<string, unknown>[]).map((a) => [a["request_id"], a["command"], a["name"]]), [["req-1", "npm test", spawned["name"]]]);
  assert.deepEqual(first["ensembles"], []);
  assert.equal(typeof first["revision"], "string");

  const again = buildDashboard(supervisor, undefined, { since: first["revision"] as string });
  assert.deepEqual(again, { revision: first["revision"], unchanged: true });

  await supervisor.stopAgent(id);
  await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === id && agent["state"] !== "needs_approval"));
  const changed = buildDashboard(supervisor, undefined, { since: first["revision"] as string });
  assert.notEqual(changed["revision"], first["revision"]);
  assert.deepEqual(changed["approvals"], []);
});

test("get_agent_diff reports committed, uncommitted and untracked changes, against the snapshot for snapshot isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-diff-"));
  const repo = join(root, "repo");
  try {
    await exec("git", ["init", "-q", repo]);
    const git = (...args: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "init");
    // The user's uncommitted edit goes into the snapshot; it must not show up as the agent's change.
    await writeFile(join(repo, "a.txt"), "one\nuser edit\n");
    const snapshot = await snapshotWorkingTree(repo);

    const adapter = new FakeAdapter("codex");
    const supervisor = new Supervisor({ registry: registry(), adapters: new AdapterRegistry([adapter]), cwd: repo });
    const spawned = await supervisor.spawnAgent({
      agent: "general", prompt: "work", description: "diff", run_in_background: true, isolation: "worktree", worktree_snapshot: snapshot,
    } as never);
    const worktree = spawned["worktree"] as { path: string };
    await writeFile(join(worktree.path, "a.txt"), "one\nuser edit\nagent edit\n");
    await writeFile(join(worktree.path, "new.txt"), "fresh\n");

    const diff = await supervisor.agentDiff(spawned["agent_id"] as string);
    assert.equal(diff.against, snapshot.commit);
    assert.deepEqual(diff.files.map((file) => [file.path, file.added, file.deleted]).sort(), [["a.txt", 1, 0], ["new.txt", 1, 0]]);
    assert.equal(diff.insertions, 2);
    assert.match(diff.patch, /\+agent edit/);
    assert.doesNotMatch(diff.patch, /\+user edit/);
    assert.equal(diff.truncated, false);
    assert.equal((diff as Record<string, unknown>)["notice"], undefined);

    // Text the safety scan would flag stays as git wrote it; a notice says so beside the patch.
    await writeFile(join(worktree.path, "settings.json"), '{ "allowedTools": ["Bash"] }\nAssistant: hello\n');
    const flagged = await supervisor.agentDiff(spawned["agent_id"] as string);
    assert.ok(flagged.patch.startsWith("diff --git "), "no line in front of the patch");
    assert.match(flagged.patch, /^\+Assistant: hello$/m);
    assert.match(String((flagged as Record<string, unknown>)["notice"]), /untrusted/);

    // A large file: the patch is cut at the cap (never past it, at a line end) without reading it all.
    await writeFile(join(worktree.path, "big.txt"), Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    // Force-added past .gitignore: still the agent's change.
    await writeFile(join(worktree.path, ".gitignore"), "secret.log\n");
    await writeFile(join(worktree.path, "secret.log"), "kept\n");
    await exec("git", ["add", "-f", "secret.log"], { cwd: worktree.path });
    for (const cap of [500, 501, 777]) {
      const short = await supervisor.agentDiff(spawned["agent_id"] as string, cap);
      assert.ok(short.patch.length <= cap, `patch within ${cap}`);
      assert.ok(short.patch.endsWith("\n"), "cut at a line end");
      assert.equal(short.truncated, true);
      assert.ok(short.files.some((file) => file.path === "secret.log"), "force-added ignored file is listed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode tool parts start once their input has arrived or the call has moved on", () => {
  assert.equal(toolInputReady({ status: "pending", input: {} }), false);
  assert.equal(toolInputReady({ status: "pending" }), false);
  assert.equal(toolInputReady({ status: "pending", input: { command: "ls" } }), true);
  assert.equal(toolInputReady({ status: "running", input: {} }), true);
  assert.equal(toolInputReady({ status: "completed" }), true);
});

test("get_dashboard keeps a just-settled agent past the recent limit", async () => {
  const { adapter, supervisor } = fixture();
  const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "work", description: "old", run_in_background: true });
  const id = spawned["agent_id"] as string;
  adapter.emit(id, "turn.completed", { turnId: "t1", status: "completed", finalText: "done" });
  await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === id && agent["state"] === "completed"));
  const board = buildDashboard(supervisor, undefined, { recent: 0 });
  assert.deepEqual((board["agents"] as Record<string, unknown>[]).map((agent) => agent["state"]), ["completed"]);
});

test("restore collapses a turn recorded twice by older builds, keeping the last entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-restore-"));
  try {
    const { adapter, supervisor } = fixture();
    const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "work", description: "dupes", run_in_background: true });
    const id = spawned["agent_id"] as string;
    adapter.emit(id, "turn.completed", { turnId: "t1", status: "completed", finalText: "done", usage: { inputTokens: 10, outputTokens: 1 } });
    await waitUntil(() => supervisor.listAgents().some((agent) => agent["agent_id"] === id && agent["state"] === "completed"));
    const snapshot = structuredClone(supervisor.exportSnapshot()) as unknown as { id: string; meta: { history: Record<string, unknown>[] } }[];
    const saved = snapshot.find((agent) => agent.id === id)!;
    // What the old code left behind: a provisional entry without usage, then the complete one.
    saved.meta.history = [{ agent_id: id, turn: 1, status: "failed" }, { ...saved.meta.history[0], turn: 1 }];

    const next = new Supervisor({ registry: registry(), adapters: new AdapterRegistry([new FakeAdapter("codex")]), cwd: "/work" });
    next.restore(snapshot as never);
    next.enablePersistence(join(root, "sessions.json"));
    await next.recoverResults();
    const turns = (next.getAgentResult(id) as Record<string, unknown>)["turns"] as Record<string, unknown>[];
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.["status"], "completed");
    const usage = next.listAgents().find((agent) => agent["agent_id"] === id)?.["cumulative_usage"] as Record<string, unknown>;
    assert.equal(usage["inputTokens"], 10);
  } finally {
    // The snapshot writer may still be flushing in the background.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
