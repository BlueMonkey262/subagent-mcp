import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LiveConfig, missingConfigMessage } from "../src/config/live.js";
import { CODEX_RESUME_IDLE_ENV, MAX_CONCURRENT_ENV } from "../src/core/limits.js";

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
