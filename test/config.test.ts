import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationError } from "../src/core/errors.js";
import { loadConfigRegistry } from "../src/config/registry.js";

async function fixture(): Promise<{ root: string; agents: string; models: string }> {
  const root = await mkdtemp(join(tmpdir(), "subagent-config-"));
  const agents = join(root, ".subagents");
  const models = join(agents, "models.yaml");
  await mkdir(agents);
  await writeFile(models, `models:
  claude: [claude-sonnet-4-5]
  codex:
    - name: gpt-5.6-luna
      version: gpt-5.6-luna-2026-08-15
  opencode: []
  antigravity: []
  cursor: []
`);
  return { root, agents, models };
}

test("loads frontmatter agents and resolves only roster models", async () => {
  const { agents, models } = await fixture();
  await writeFile(join(agents, "reviewer.md"), `---
name: reviewer
backend: codex
description: Reviews diffs
maxTurns: 30
timeout: 900
permission:
  allow: [Read, "Bash(git diff:*)"]
  deny: ["Write(.git/**)"]
  default: escalate
env:
  FOO: bar
---
Review carefully.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  assert.equal(registry.getAgent("reviewer").systemPrompt, "Review carefully.");
  assert.equal(registry.resolveAgent({ agent: "reviewer", model: "gpt-5.6-luna" }).model, "gpt-5.6-luna");
  assert.deepEqual(registry.listModels("codex"), [
    { name: "gpt-5.6-luna", version: "gpt-5.6-luna-2026-08-15" },
  ]);
});

test("missing and invalid models fail with the config-sourced valid roster", async () => {
  const { agents, models } = await fixture();
  await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
description: General agent
---
Work.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  assert.throws(
    () => registry.resolveAgent({ agent: "general" }),
    (error: unknown) => error instanceof ConfigurationError
      && /No model selected/.test(error.message)
      && /gpt-5\.6-luna/.test(error.message),
  );
  assert.throws(
    () => registry.resolveAgent({ agent: "general", model: "made-up" }),
    (error: unknown) => error instanceof ConfigurationError
      && /Unknown model/.test(error.message)
      && /gpt-5\.6-luna/.test(error.message),
  );
});

test("a pinned agent model cannot be overridden", async () => {
  const { agents, models } = await fixture();
  await writeFile(join(agents, "pinned.md"), `---
name: pinned
backend: codex
model: gpt-5.6-luna
description: Pinned
---
Work.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  assert.equal(registry.resolveAgent({ agent: "pinned" }).model, "gpt-5.6-luna");
  assert.throws(() => registry.resolveAgent({ agent: "pinned", model: "other" }), /pins model/);
});

test("reasoningEffort is optional, merges with a spawn-time override, and rejects a pin conflict", async () => {
  const { agents, models } = await fixture();
  await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
model: gpt-5.6-luna
description: General agent
---
Work.
`);
  await writeFile(join(agents, "pinned-effort.md"), `---
name: pinned-effort
backend: codex
model: gpt-5.6-luna
reasoningEffort: high
description: Pins its own effort
---
Work.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });

  // No effort requested and none pinned: field is simply absent, not an error (unlike model).
  assert.equal(registry.resolveAgent({ agent: "general" }).reasoningEffort, undefined);

  // Caller-supplied effort passes through when nothing is pinned.
  assert.equal(
    registry.resolveAgent({ agent: "general", reasoningEffort: "xhigh" }).reasoningEffort,
    "xhigh",
  );

  // A pinned effort is used when the caller doesn't ask for one.
  assert.equal(registry.resolveAgent({ agent: "pinned-effort" }).reasoningEffort, "high");

  // A caller-supplied effort matching the pin is fine.
  assert.equal(
    registry.resolveAgent({ agent: "pinned-effort", reasoningEffort: "high" }).reasoningEffort,
    "high",
  );

  // A caller-supplied effort conflicting with the pin is rejected, mirroring model pins.
  assert.throws(
    () => registry.resolveAgent({ agent: "pinned-effort", reasoningEffort: "low" }),
    /pins reasoningEffort/,
  );
});

test("OpenCode and Cursor reject effort instead of dropping it", async () => {
  const { agents, models } = await fixture();
  await writeFile(models, `models:
  claude: []
  codex: []
  opencode: [ollama/local]
  antigravity: []
  cursor: [grok-4.7-high]
`);
  await writeFile(join(agents, "oc.md"), `---
name: oc
backend: opencode
model: ollama/local
description: OpenCode agent
---
Work.
`);
  await writeFile(join(agents, "cursor.md"), `---
name: cursor
backend: cursor
description: Cursor agent
---
Work.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  assert.throws(
    () => registry.resolveAgent({ agent: "oc", reasoningEffort: "xhigh" }),
    /does not honor effort/,
  );
  assert.throws(
    () => registry.resolveAgent({ agent: "cursor", model: "grok-4.7-high", reasoningEffort: "high" }),
    /folds effort into the model id/,
  );
});

test("models.yaml can set the concurrency cap, Codex resume idle, and allowances", async () => {
  const { agents, models } = await fixture();
  await writeFile(models, `maxConcurrent: 4
codexResumeIdleSeconds: 600
allowances:
  cursor:
    maxSpawns: 8
    maxCostUsd: 1.5
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
description: General agent
---
Work.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  assert.equal(registry.maxConcurrent(), 4);
  assert.equal(registry.codexResumeIdleMs(), 600_000);
  assert.deepEqual(registry.allowances().cursor, { maxSpawns: 8, maxCostUsd: 1.5 });
});

test("permission.mode is optional, validated, and carried on the resolved agent", async () => {
  const { agents, models } = await fixture();
  await writeFile(join(agents, "planner.md"), `---
name: planner
backend: codex
description: Plans
permission:
  mode: plan
---
Plan.
`);
  await writeFile(join(agents, "plain.md"), `---
name: plain
backend: codex
description: No mode
---
Plain.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  assert.equal(registry.resolveAgent({ agent: "planner", model: "gpt-5.6-luna" }).permission.mode, "plan");
  assert.equal(registry.resolveAgent({ agent: "plain", model: "gpt-5.6-luna" }).permission.mode, undefined);

  await writeFile(join(agents, "bad.md"), `---
name: bad
backend: codex
description: Bad mode
permission:
  mode: yolo
---
Bad.
`);
  await assert.rejects(loadConfigRegistry({ agentsDirectory: agents, modelsFile: models }), /permission\.mode must be one of/);
});

test("Antigravity agents require a named custom agent and preserve it when resolved", async () => {
  const { agents, models } = await fixture();
  await writeFile(models, `models:
  claude: []
  codex: []
  opencode: []
  antigravity: [gemini-3.8-flash-high]
`);
  await writeFile(join(agents, "antigravity.md"), `---
name: antigravity
backend: antigravity
description: Antigravity code reviewer
antigravityAgent: code-reviewer
---
This must be mirrored by the Antigravity custom-agent Markdown body.
`);
  await writeFile(join(agents, "missing-agent.md"), `---
name: missing-agent
backend: antigravity
description: Invalid Antigravity configuration
---
No custom agent.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  const resolved = registry.resolveAgent({ agent: "antigravity", model: "gemini-3.8-flash-high" });
  assert.equal(resolved.antigravityAgent, "code-reviewer");
  assert.throws(
    () => registry.resolveAgent({ agent: "missing-agent", model: "gemini-3.8-flash-high" }),
    /does not set antigravityAgent/,
  );
});

test("older rosters without an Antigravity key load with an empty Antigravity model list", async () => {
  const { agents, models } = await fixture();
  await writeFile(models, `models:
  claude: []
  codex: [gpt-5.6-luna]
  opencode: []
`);
  await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
description: General agent
---
Work.
`);
  const registry = await loadConfigRegistry({ agentsDirectory: agents, modelsFile: models });
  assert.deepEqual(registry.listModels("antigravity"), []);
});
