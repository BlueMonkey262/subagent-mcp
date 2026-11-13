import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FileAntigravityAgentResolver } from "../src/adapters/antigravity/agent-definition.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { ConfigRegistry, defaultServerLimits } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { Supervisor } from "../src/supervisor.js";

const permission = { allow: [], deny: [], default: "escalate" as const };

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function writeDefinition(path: string, name: string, body = "Do the delegated work."): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `---
name: ${name}
description: Fixture Antigravity agent
tools: [view_file, grep_search]
---
${body}
`);
}

test("Antigravity definitions resolve project-first, explicit paths, and global fallback", async () => {
  const project = await mkdtemp(join(tmpdir(), "antigravity-def-"));
  const global = await mkdtemp(join(tmpdir(), "antigravity-global-"));
  const projectFile = join(project, ".agents", "agents", "reviewer.md");
  await writeDefinition(projectFile, "reviewer");
  const resolver = new FileAntigravityAgentResolver();

  const fromProject = await resolver.resolve({ name: "reviewer", cwd: project, globalDirectory: global });
  assert.equal(fromProject.source, "project");
  assert.equal(fromProject.portable, true);
  assert.deepEqual(fromProject.tools, ["view_file", "grep_search"]);
  assert.match(fromProject.body, /Do the delegated work/);
  assert.equal(fromProject.sha256.length, 64);

  const explicit = join(project, "tools", "reviewer.md");
  await writeDefinition(explicit, "reviewer");
  const fromExplicit = await resolver.resolve({ name: "reviewer", cwd: project, file: "tools/reviewer.md" });
  assert.equal(fromExplicit.source, "explicit");
  assert.equal(fromExplicit.portable, true);

  const globalFile = join(global, "missing-in-project.md");
  await writeDefinition(globalFile, "missing-in-project", "Global prompt.");
  const fromGlobal = await resolver.resolve({ name: "missing-in-project", cwd: project, globalDirectory: global });
  assert.equal(fromGlobal.source, "global");
  assert.equal(fromGlobal.portable, false);
  assert.match(fromGlobal.body, /Global prompt/);
});

test("a missing or mismatched Antigravity definition fails with a stable code", async () => {
  const project = await mkdtemp(join(tmpdir(), "antigravity-def-errors-"));
  const resolver = new FileAntigravityAgentResolver();
  await assert.rejects(
    resolver.resolve({ name: "absent", cwd: project, globalDirectory: join(project, "global") }),
    (error: Error & { code?: string }) => error.code === "ANTIGRAVITY_AGENT_NOT_FOUND",
  );
  const path = join(project, ".agents", "agents", "wrong.md");
  await writeDefinition(path, "wrong");
  await assert.rejects(
    resolver.resolve({ name: "expected", cwd: project, globalDirectory: join(project, "global") }),
    (error: Error & { code?: string }) => error.code === "ANTIGRAVITY_AGENT_NOT_FOUND",
  );
  await assert.rejects(
    new FileAntigravityAgentResolver().resolve({ name: "expected", cwd: project, file: ".agents/agents/wrong.md" }),
    (error: Error & { code?: string }) => error.code === "ANTIGRAVITY_AGENT_INVALID",
  );
});

test("spawn captures the real Antigravity definition, snapshots it, and refuses silent drift", async () => {
  const project = await mkdtemp(join(tmpdir(), "antigravity-supervisor-"));
  const global = await mkdtemp(join(tmpdir(), "antigravity-global-"));
  const definitionPath = join(project, ".agents", "agents", "reviewer.md");
  await writeDefinition(definitionPath, "reviewer");
  const agent: AgentConfig = {
    name: "reviewer",
    backend: "antigravity",
    model: "gemini-fixture",
    antigravityAgent: "reviewer",
    description: "Antigravity reviewer",
    systemPrompt: "",
    permission,
    env: {},
    sourcePath: join(project, ".subagents", "reviewer.md"),
  };
  const roster: ModelRoster = {
    claude: [],
    codex: [],
    opencode: [],
    antigravity: [{ name: "gemini-fixture" }],
    cursor: [],
  };
  const registry = new ConfigRegistry([agent], roster, defaultServerLimits());
  const adapter = new FakeAdapter("antigravity");
  const resolver = new FileAntigravityAgentResolver();
  const supervisor = new Supervisor({
    registry,
    adapters: new AdapterRegistry([adapter]),
    cwd: project,
    antigravityResolver: { resolve: input => resolver.resolve({ ...input, globalDirectory: global }) },
    sendMessageWaitMs: 0,
  });
  supervisor.enablePersistence(join(project, ".subagents", "memory", "sessions.json"));

  adapter.queueScript([]);
  const spawned = await supervisor.spawnAgent({
    agent: "reviewer",
    prompt: "review this",
    description: "review",
    run_in_background: true,
  });
  const metadata = spawned["agent_definition"] as { sha256: string; source: string; portable: boolean; snapshotPath: string };
  assert.equal(metadata.source, "project");
  assert.equal(metadata.portable, true);
  await access(metadata.snapshotPath);

  adapter.emit(String(spawned["agent_id"]), "turn.completed", { turnId: "first", status: "completed", finalText: "done" });
  await waitUntil(() => supervisor.listAgents().find(item => item["agent_id"] === spawned["agent_id"])?.["state"] === "completed");

  const listed = await supervisor.listAgentConfigs();
  const config = listed.configs.find(item => item.name === "reviewer") as {
    agent_definition?: { sha256: string; source: string; bridge_enforced: boolean };
  };
  assert.equal(config.agent_definition?.sha256, metadata.sha256);
  assert.equal(config.agent_definition?.source, "project");
  assert.equal(config.agent_definition?.bridge_enforced, false);

  await writeDefinition(definitionPath, "reviewer", "Changed instructions.");
  await assert.rejects(
    supervisor.sendMessage({ agent: String(spawned["agent_id"]), prompt: "continue", wait_seconds: 0 }),
    (error: Error & { code?: string }) => error.code === "ANTIGRAVITY_AGENT_CHANGED",
  );
  const resumed = await supervisor.sendMessage({
    agent: String(spawned["agent_id"]),
    prompt: "continue",
    wait_seconds: 0,
    allow_agent_definition_change: true,
  });
  assert.equal(resumed["status"], "running");
});
