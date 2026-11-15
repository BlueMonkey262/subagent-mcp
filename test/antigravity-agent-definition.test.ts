import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FileAntigravityAgentResolver, ensureAntigravityAgent } from "../src/adapters/antigravity/agent-definition.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { ConfigRegistry, defaultServerLimits } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { Supervisor } from "../src/supervisor.js";


const definition = `---
name: subagent-general
description: Test definition
---
Do the work.
`;

test("a missing agent definition is copied from the install's .example template", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-agy-definition-"));
  const cwd = join(root, "project");
  const install = join(root, "install");
  const example = join(install, ".agents", "agents", "subagent-general.md.example");
  await mkdir(join(install, ".agents", "agents"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(example, definition);

  const ensured = await ensureAntigravityAgent({ cwd, name: "subagent-general", installDirectory: install });
  assert.equal(ensured.copied, true);
  assert.equal(ensured.copiedFrom, example);
  assert.equal(ensured.path, join(cwd, ".agents", "agents", "subagent-general.md"));
  assert.equal(await readFile(ensured.path, "utf8"), definition);
});

test("a project .example template wins over the install's, and an existing file is never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-agy-definition-"));
  const cwd = join(root, "project");
  const install = join(root, "install");
  const projectDirectory = join(cwd, ".agents", "agents");
  const projectExample = join(projectDirectory, "subagent-general.md.example");
  const installExample = join(install, ".agents", "agents", "subagent-general.md.example");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(join(install, ".agents", "agents"), { recursive: true });
  await writeFile(projectExample, definition);
  await writeFile(installExample, "---\nname: subagent-general\n---\nInstall copy.\n");

  const first = await ensureAntigravityAgent({ cwd, name: "subagent-general", installDirectory: install });
  assert.equal(first.copiedFrom, projectExample);
  assert.equal(await readFile(first.path, "utf8"), definition);

  await writeFile(first.path, "my edits\n");
  const second = await ensureAntigravityAgent({ cwd, name: "subagent-general", installDirectory: install });
  assert.equal(second.copied, false);
  assert.equal(second.copiedFrom, undefined);
  assert.equal(await readFile(first.path, "utf8"), "my edits\n");
});

test("with no real file and no template, nothing is created", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-agy-definition-"));
  const ensured = await ensureAntigravityAgent({ cwd, name: "missing", installDirectory: join(cwd, "install") });
  assert.equal(ensured.copied, false);
  assert.equal(ensured.copiedFrom, undefined);
  assert.equal(ensured.path, join(cwd, ".agents", "agents", "missing.md"));
});

test("the resolver seeds a missing project definition from its .example template", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-def-seed-"));
  const project = join(root, "project");
  const install = join(root, "install");
  const example = join(install, ".agents", "agents", "reviewer.md.example");
  await mkdir(join(install, ".agents", "agents"), { recursive: true });
  await writeDefinition(example, "reviewer", "Seeded prompt.");
  const resolver = new FileAntigravityAgentResolver();

  const definition = await resolver.resolve({ name: "reviewer", cwd: project, installDirectory: install });
  assert.equal(definition.source, "project");
  assert.equal(definition.sourcePath, join(project, ".agents", "agents", "reviewer.md"));
  assert.match(definition.body, /Seeded prompt/);
  assert.equal(await readFile(definition.sourcePath, "utf8"), await readFile(example, "utf8"));
});

test("the resolver can skip seeding for a read-only audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-def-audit-"));
  const project = join(root, "project");
  const install = join(root, "install");
  await mkdir(join(install, ".agents", "agents"), { recursive: true });
  await writeDefinition(join(install, ".agents", "agents", "reviewer.md.example"), "reviewer");
  const resolver = new FileAntigravityAgentResolver();
  await assert.rejects(
    resolver.resolve({ name: "reviewer", cwd: project, installDirectory: install, prepare: false }),
    (error: Error & { code?: string }) => error.code === "ANTIGRAVITY_AGENT_NOT_FOUND",
  );
  await assert.rejects(access(join(project, ".agents", "agents", "reviewer.md")));
});

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
    copilot: [],
    vibe: [],
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

test("a queued send_message keeps allow_agent_definition_change and classifies definition errors", async () => {
  const project = await mkdtemp(join(tmpdir(), "antigravity-queued-"));
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
    copilot: [],
    vibe: [],
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
  const spawnAgent = () => supervisor.spawnAgent({
    agent: "reviewer",
    prompt: "review this",
    description: "review",
    run_in_background: true,
  });
  const isState = (id: unknown, state: string) =>
    supervisor.listAgents().some(item => item["agent_id"] === id && item["state"] === state);

  // Queueing without the opt-in must end the agent with the real definition error, not a
  // retryable supervisor stream error from the pump's outer catch.
  adapter.queueScript([]);
  const refused = await spawnAgent();
  const refusedId = String(refused["agent_id"]);
  await waitUntil(() => isState(refusedId, "running"));
  await writeDefinition(definitionPath, "reviewer", "Changed instructions.");
  const queued = await supervisor.sendMessage({ agent: refusedId, prompt: "continue", run_in_background: true });
  assert.equal(queued["queued"], true);
  adapter.emit(refusedId, "turn.completed", { turnId: "first", status: "completed", finalText: "done" });
  await waitUntil(() => isState(refusedId, "completed"));
  const refusedResult = supervisor.getAgentResult(refusedId) as Record<string, unknown>;
  assert.equal((refusedResult["error"] as { code: string }).code, "ANTIGRAVITY_AGENT_CHANGED");
  assert.equal(adapter.resumeRequests.length, 0);

  // Queueing with the opt-in carries it through delivery and resumes normally.
  adapter.queueScript([]);
  const allowed = await spawnAgent();
  const allowedId = String(allowed["agent_id"]);
  await waitUntil(() => isState(allowedId, "running"));
  await writeDefinition(definitionPath, "reviewer", "Third instructions.");
  await supervisor.sendMessage({
    agent: allowedId,
    prompt: "continue",
    run_in_background: true,
    allow_agent_definition_change: true,
  });
  adapter.emit(allowedId, "turn.completed", { turnId: "first-allowed", status: "completed", finalText: "done" });
  await waitUntil(() => adapter.resumeRequests.length === 1);
  assert.equal(adapter.resumeRequests[0]?.agentId, allowedId);
  adapter.emit(allowedId, "turn.completed", { turnId: "second-allowed", status: "completed", finalText: "resumed" });
  await waitUntil(() => isState(allowedId, "completed"));
  assert.equal((supervisor.getAgentResult(allowedId) as Record<string, unknown>)["error"], undefined);
});

test("a task does not launch if shutdown begins during agent-definition capture", async () => {
  const project = await mkdtemp(join(tmpdir(), "antigravity-shutdown-"));
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
    copilot: [],
    vibe: [],
  };
  const adapter = new FakeAdapter("antigravity");
  const resolver = new FileAntigravityAgentResolver();
  let releaseGate: (() => void) | undefined;
  let enteredGate: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredGate = resolve; });
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const supervisor = new Supervisor({
    registry: new ConfigRegistry([agent], roster, defaultServerLimits()),
    adapters: new AdapterRegistry([adapter]),
    cwd: project,
    antigravityResolver: {
      resolve: async input => {
        enteredGate?.();
        await gate;
        return resolver.resolve({ ...input, globalDirectory: global });
      },
    },
  });

  const task = await supervisor.spawnAgent({
    agent: "reviewer",
    prompt: "review this",
    description: "review",
    run_in_background: true,
    delay_seconds: 1,
  });
  const keepAlive = setTimeout(() => undefined, 5_000);
  try {
    await entered;
    const quiescing = supervisor.quiesce();
    releaseGate?.();
    await quiescing;
  } finally {
    clearTimeout(keepAlive);
  }

  assert.equal(adapter.spawnRequests.length, 0, "shutdown refused the launch after capacity was acquired");
  assert.equal(supervisor.getAgentResult(String(task["task_id"]))?.state, "queued");
});
