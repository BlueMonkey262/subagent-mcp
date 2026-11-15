import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { missingModelsFileMessage, resolveModelsFile } from "../src/config/models-file.js";
import { loadModelsFile } from "../src/config/registry.js";
import { BACKENDS } from "../src/core/types.js";

async function fixture(): Promise<{ cwd: string; install: string }> {
  const root = await mkdtemp(join(tmpdir(), "subagent-models-file-"));
  const cwd = join(root, "project");
  const install = join(root, "install");
  await Promise.all([
    mkdir(join(cwd, ".subagents"), { recursive: true }),
    mkdir(join(install, ".subagents"), { recursive: true }),
  ]);
  return { cwd, install };
}

test("models.yaml resolution prefers the environment, then the project, then the install", async () => {
  const { cwd, install } = await fixture();
  const environment = join(cwd, "custom-models.yaml");
  const project = join(cwd, ".subagents", "models.yaml");
  const installed = join(install, ".subagents", "models.yaml");
  await Promise.all([writeFile(environment, "models: {}\n"), writeFile(project, "models: {}\n"), writeFile(installed, "models: {}\n")]);

  const fromEnvironment = resolveModelsFile({ cwd, installDirectory: install, env: { SUBAGENT_MCP_MODELS_FILE: environment } });
  assert.deepEqual(fromEnvironment, {
    path: environment,
    exists: true,
    source: "environment",
    checked: [environment],
  });

  const fromProject = resolveModelsFile({ cwd, installDirectory: install, env: {} });
  assert.equal(fromProject.path, project);
  assert.equal(fromProject.source, "project");
  assert.deepEqual(fromProject.checked, [project]);

  await rm(project);
  const fromInstall = resolveModelsFile({ cwd, installDirectory: install, env: {} });
  assert.equal(fromInstall.path, installed);
  assert.equal(fromInstall.source, "install");
  assert.deepEqual(fromInstall.checked, [project, installed]);
});

test("a relative SUBAGENT_MCP_MODELS_FILE is resolved from the project directory", async () => {
  const { cwd, install } = await fixture();
  const resolved = resolveModelsFile({ cwd, installDirectory: install, env: { SUBAGENT_MCP_MODELS_FILE: "config/roster.yaml" } });
  assert.equal(resolved.path, join(cwd, "config", "roster.yaml"));
  assert.equal(resolved.exists, false);
  assert.equal(resolved.source, "environment");
});

test("a missing models.yaml reports every checked path and how to create it", async () => {
  const { cwd, install } = await fixture();
  const project = join(cwd, ".subagents", "models.yaml");
  const installed = join(install, ".subagents", "models.yaml");
  const resolved = resolveModelsFile({ cwd, installDirectory: install, env: {} });

  assert.equal(resolved.path, project);
  assert.equal(resolved.exists, false);
  assert.equal(resolved.source, "missing");
  assert.deepEqual(resolved.checked, [project, installed]);

  const message = missingModelsFileMessage(resolved.checked);
  assert.match(message, /No models\.yaml was found/);
  assert.ok(message.includes(project));
  assert.ok(message.includes(installed));
  assert.match(message, /Copy \.subagents\/models\.yaml\.example to \.subagents\/models\.yaml/);
  assert.match(message, /not a live roster/);
});

test("models.yaml.example parses and documents every backend and server-limit key", async () => {
  const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
  const path = join(root, ".subagents", "models.yaml.example");
  const text = await readFile(path, "utf8");
  const parsed = await loadModelsFile(path);

  assert.deepEqual(Object.keys(parsed.roster).sort(), [...BACKENDS].sort());
  for (const backend of BACKENDS) {
    assert.ok(parsed.roster[backend].length > 0, `the example has a ${backend} entry`);
  }
  for (const key of [
    "maxConcurrent",
    "codexResumeIdleSeconds",
    "staleAgentSeconds",
    "sendMessageWaitSeconds",
    "scheduledGraceSeconds",
    "allowances",
    "perBackendConcurrency",
    "perModelConcurrency",
    "providerLimits",
    "disabledBackends",
    "blockModels",
    "blockClaudeModels",
  ]) {
    assert.match(text, new RegExp(`^#?\\s*${key}:`, "m"), `the example documents ${key}`);
  }
});

test("every documented server-limit key parses with the current schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-models-example-"));
  const path = join(root, "models.yaml");
  await writeFile(path, `maxConcurrent: 12
codexResumeIdleSeconds: 1800
staleAgentSeconds: 300
sendMessageWaitSeconds: 30
scheduledGraceSeconds: 60
allowances:
  cursor:
    maxSpawns: 20
    maxCostUsd: 5
perBackendConcurrency:
  codex: 4
perModelConcurrency:
  "codex:gpt-5.6-sol": 2
providerLimits:
  mistral:
    maxConcurrent: 2
    cooldownSeconds: 60
disabledBackends: [antigravity]
blockModels: ["*grok*", "codex:gpt-5.6-sol"]
blockClaudeModels: true
models:
  claude: [claude-sonnet-5]
  codex: [gpt-5.6-sol]
  opencode: [mistral/mistral-medium-latest]
  antigravity: [gemini-3.8-flash-low]
  cursor: [auto]
  copilot: [auto]
  vibe: [mistral-medium-3.5]
`);
  const parsed = await loadModelsFile(path);
  assert.equal(parsed.limits.maxConcurrent, 12);
  assert.equal(parsed.limits.staleAgentMs, 300_000);
  assert.equal(parsed.limits.sendMessageWaitMs, 30_000);
  assert.equal(parsed.limits.scheduledGraceMs, 60_000);
  assert.equal(parsed.limits.allowances.cursor?.maxSpawns, 20);
  assert.equal(parsed.limits.perBackendConcurrency.codex, 4);
  assert.deepEqual(parsed.limits.perModelConcurrency, [{ pattern: "codex:gpt-5.6-sol", limit: 2 }]);
  assert.equal(parsed.limits.providerLimits.mistral?.maxConcurrent, 2);
  assert.equal(parsed.limits.providerLimits.mistral?.cooldownSeconds, 60);
  assert.deepEqual(parsed.limits.modelPolicy.disabledBackends, ["antigravity"]);
  assert.deepEqual(parsed.limits.modelPolicy.blockModels, ["*grok*", "codex:gpt-5.6-sol"]);
  assert.equal(parsed.limits.modelPolicy.blockClaudeModels, true);
  for (const backend of BACKENDS) assert.equal(parsed.roster[backend].length, 1, backend);
});
