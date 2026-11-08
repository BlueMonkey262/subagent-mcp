import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LiveConfig, missingConfigMessage } from "../src/config/live.js";
import { CODEX_RESUME_IDLE_ENV, MAX_CONCURRENT_ENV } from "../src/core/limits.js";
import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { Supervisor } from "../src/supervisor.js";

test("missing config tells the caller to write the files and reconnect", () => {
  const message = missingConfigMessage({
    agentsDirectory: "/work/.subagents",
    modelsFile: "/work/.subagents/models.yaml",
    cause: "ENOENT",
  });
  assert.match(message, /\/work\/\.subagents\/models\.yaml/);
  assert.match(message, /name: general/);
  assert.match(message, /ask the user to run `\/mcp` and then reconnect subagent-mcp/);
});

test("LiveConfig fails closed without files, then loads them on reload", async () => {
  const previousCap = process.env[MAX_CONCURRENT_ENV];
  const previousIdle = process.env[CODEX_RESUME_IDLE_ENV];
  delete process.env[MAX_CONCURRENT_ENV];
  delete process.env[CODEX_RESUME_IDLE_ENV];
  const root = await mkdtemp(join(tmpdir(), "subagent-live-config-"));
  const agents = join(root, ".subagents");
  const models = join(agents, "models.yaml");
  const live = new LiveConfig({ agentsDirectory: agents, modelsFile: models });
  try {
    await live.reload();
    assert.equal(live.hasConfig(), false);
    assert.throws(() => live.resolveAgent({ agent: "general" }), /reconnect subagent-mcp/);

    await mkdir(agents);
    await writeFile(models, `maxConcurrent: 3
models:
  claude: []
  codex: [gpt-5.6-luna]
  opencode: []
  antigravity: []
  cursor: []
`);
    await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
model: gpt-5.6-luna
description: General agent
---
Work.
`);
    await live.reload();
    assert.equal(live.hasConfig(), true);
    assert.equal(live.resolveAgent({ agent: "general" }).model, "gpt-5.6-luna");
    assert.equal(live.maxConcurrent(), 3);
    assert.equal(live.configWarning(), undefined);
  } finally {
    live.close();
    if (previousCap === undefined) delete process.env[MAX_CONCURRENT_ENV];
    else process.env[MAX_CONCURRENT_ENV] = previousCap;
    if (previousIdle === undefined) delete process.env[CODEX_RESUME_IDLE_ENV];
    else process.env[CODEX_RESUME_IDLE_ENV] = previousIdle;
  }
});

test("LiveConfig watches the roster and picks up a new model without a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-live-watch-"));
  const agents = join(root, ".subagents");
  const models = join(agents, "models.yaml");
  await mkdir(agents);
  await writeFile(models, `models:
  claude: []
  codex: [gpt-5.6-luna]
  opencode: []
  antigravity: []
  cursor: []
`);
  await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
model: gpt-5.6-luna
description: General agent
---
Work.
`);
  const live = new LiveConfig({ agentsDirectory: agents, modelsFile: models });
  try {
    await live.reload();
    let changed = 0;
    live.watch(() => {
      changed += 1;
    });
    await writeFile(models, `models:
  claude: []
  codex: [gpt-5.6-luna, gpt-5.6-sol]
  opencode: []
  antigravity: []
  cursor: []
`);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const roster = live.listModels("codex");
      if (Array.isArray(roster) && roster.some((entry) => entry.name === "gpt-5.6-sol")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const roster = live.listModels("codex");
    assert.equal(Array.isArray(roster) && roster.some((entry) => entry.name === "gpt-5.6-sol"), true);
    assert.ok(changed >= 1);
  } finally {
    live.close();
  }
});

test("an invalid hot reload blocks execution and queued delivery until a valid reload recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-live-invalid-"));
  const agents = join(root, ".subagents");
  const models = join(agents, "models.yaml");
  await mkdir(agents);
  const validModels = `models:
  claude: []
  codex: [gpt-5.6-luna]
  opencode: []
  antigravity: []
  cursor: []
`;
  await writeFile(models, validModels);
  await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
model: gpt-5.6-luna
description: General agent
---
Work.
`);
  const live = new LiveConfig({ agentsDirectory: agents, modelsFile: models });
  const adapter = new FakeAdapter("codex");
  try {
    await live.reload();
    const supervisor = new Supervisor({ registry: live, adapters: new AdapterRegistry([adapter]), cwd: root });
    const spawned = await supervisor.spawnAgent({ agent: "general", prompt: "first", description: "first", run_in_background: true });
    const agentId = String(spawned["agent_id"]);
    await supervisor.sendMessage({ agent: agentId, prompt: "queued while valid", run_in_background: true });

    await writeFile(models, `disabledBackends: [codxe]\n${validModels}`);
    await live.reload();
    assert.match(live.configWarning() ?? "", /codxe/);
    const invalid = (error: Error & { code?: string }) => error.code === "CONFIG_INVALID" && /codxe/.test(error.message);
    await assert.rejects(
      supervisor.spawnAgent({ agent: "general", prompt: "blocked", description: "invalid" }),
      invalid,
    );
    await assert.rejects(supervisor.sendMessage({ agent: agentId, prompt: "blocked while active" }), invalid);

    adapter.emit(agentId, "turn.completed", { turnId: "first", status: "completed" });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && supervisor.listAgents().find((entry) => entry["agent_id"] === agentId)?.["state"] !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(adapter.resumeRequests.length, 0, "the queued message is refused after the invalid reload");
    assert.equal((supervisor.getAgentResult(agentId) as { error?: { code: string } }).error?.code, "CONFIG_INVALID");
    await assert.rejects(supervisor.sendMessage({ agent: agentId, prompt: "blocked cold resume" }), invalid);

    await writeFile(models, validModels);
    await live.reload();
    assert.equal(live.configWarning(), undefined);
    await supervisor.sendMessage({ agent: agentId, prompt: "recovered", run_in_background: true });
    assert.equal(adapter.resumeRequests.length, 1);
  } finally {
    live.close();
  }
});
