import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { providerErrorOf } from "../src/adapters/opencode/adapter.js";
import { VibeAdapter } from "../src/adapters/vibe/adapter.js";
import { buildVibeArguments } from "../src/adapters/vibe/arguments.js";
import { parseVibeExport } from "../src/adapters/vibe/parser.js";
import { ConfigRegistry, defaultServerLimits, loadAgentConfig, loadModelsFile } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { classifyProviderError, providerOf } from "../src/core/providers.js";
import type { AgentEvent } from "../src/events/schema.js";
import { Supervisor } from "../src/supervisor.js";
import { UsageLedger, usageByProvider } from "../src/usage.js";

const allow = { allow: [], deny: [], default: "allow" as const };
const fixture = path.join(process.cwd(), "test", "vibe-fixture.mjs");

async function tempDir(label: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), `mistral-${label}-`)));
}

// ------------------------------------------------------------------ Vibe limits

test("vibeMaxTokens and vibeMaxPriceUsd become --max-tokens and --max-price", () => {
  const args = buildVibeArguments({ model: "m", cwd: "/w", permission: allow, outputDir: "/o", vibeMaxTokens: 50_000, vibeMaxPriceUsd: 0.25 });
  assert.deepEqual(args.slice(args.indexOf("--max-tokens"), args.indexOf("--max-tokens") + 4), ["--max-tokens", "50000", "--max-price", "0.25"]);
  assert.ok(!buildVibeArguments({ model: "m", cwd: "/w", permission: allow, outputDir: "/o" }).includes("--max-tokens"));
});

test("Vibe caps load from an agent config and are refused on any other backend", async () => {
  const dir = await tempDir("caps");
  const file = path.join(dir, "capped.md");
  await writeFile(file, "---\nname: capped\nbackend: vibe\ndescription: d\nvibeMaxTokens: 1000\nvibeMaxPriceUsd: 0.5\npermission:\n  allow: []\n  deny: []\n  default: allow\n---\nbody\n");
  const agent = await loadAgentConfig(file);
  assert.equal(agent.vibeMaxTokens, 1000);
  assert.equal(agent.vibeMaxPriceUsd, 0.5);
  const roster: ModelRoster = { claude: [], codex: [{ name: "sol" }], opencode: [], antigravity: [], cursor: [], copilot: [], vibe: [{ name: "m" }] };
  const registry = new ConfigRegistry([agent], roster);
  const resolved = registry.resolveAgent({ agent: "capped", model: "m" });
  assert.equal(resolved.vibeMaxTokens, 1000);
  assert.throws(() => registry.resolveAgent({ agent: "capped", backend: "codex", model: "sol" }), /only the Vibe backend enforces/);
  await writeFile(file, "---\nname: capped\nbackend: vibe\ndescription: d\nvibeMaxPriceUsd: -1\npermission:\n  allow: []\n  deny: []\n  default: allow\n---\n");
  await assert.rejects(loadAgentConfig(file), /vibeMaxPriceUsd must be a positive number/);
});

// ------------------------------------------------------------------ Vibe discovery and provider attribution

test("the export's catalog and active model are parsed", () => {
  const parsed = parseVibeExport({
    outcome: "finished",
    config: { active_model: "a", models: { a: { alias: "a", provider: "mistral", name: "up-a", input_price: 1, output_price: 2, max_context_length: 100, thinking_levels: ["off", "high"] }, junk: 3 } },
  });
  assert.equal(parsed?.activeModel, "a");
  assert.deepEqual(parsed?.catalog, [{ id: "a", provider: "mistral", upstream_model: "up-a", context: 100, cost_per_mtok: { input: 1, output: 2 }, thinking_levels: ["off", "high"] }]);
});

test("Vibe turns carry their provider, and list_models discovery survives a restart via the catalog cache", async () => {
  const cwd = await tempDir("catalog");
  const cache = path.join(cwd, "memory", "vibe-models.json");
  const make = () => new VibeAdapter({ executable: process.execPath, executableArgs: [fixture], initTimeoutMs: 3_000, interruptGraceMs: 500, outputRoot: cwd, catalogCachePath: cache });
  const adapter = make();
  try {
    assert.equal((await adapter.providerInfo()).models, undefined, "nothing is reported before any run");
    const turn = await adapter.spawn({ prompt: "CATALOG", description: "d", model: "mistral-medium-3.5", cwd, systemPrompt: "", env: {}, permission: allow, timeoutMs: 5_000 });
    const events: AgentEvent[] = [];
    for await (const event of adapter.events(turn.agentId)) { events.push(event); if (event.type === "turn.completed") break; }
    const done = events.at(-1)!;
    assert.equal(done.type === "turn.completed" ? done.data.usage?.provider : undefined, "mistral");
    const info = await adapter.providerInfo();
    assert.deepEqual((info.models ?? []).map((model) => model.id), ["mistral-medium-3.5", "zai-glm-5-3-flash"]);
    for (let i = 0; i < 50; i += 1) { try { await readFile(cache, "utf8"); break; } catch { await new Promise((r) => setTimeout(r, 10)); } }
  } finally {
    await adapter.closeAll();
  }
  const restarted = make();
  const info = await restarted.providerInfo();
  assert.equal(info.source, "latest run export");
  assert.equal((info.models ?? []).length, 2);
});

// ------------------------------------------------------------------ usage by provider

test("usage is grouped by provider so Mistral API and Vibe plan usage stay apart", async () => {
  const dir = await tempDir("usage");
  const file = path.join(dir, "usage.json");
  const ledger = new UsageLedger(file);
  ledger.recordSpawn("opencode", "mistral/codestral-latest");
  ledger.recordTurn("opencode", "mistral/codestral-latest", { inputTokens: 10, costUsd: 0.01 }, { failed: false, timedOut: false });
  ledger.recordTurn("opencode", "opencode-go/kimi", { inputTokens: 5 }, { failed: false, timedOut: false });
  ledger.recordTurn("vibe", "mistral-medium-3.5", { inputTokens: 7, costUsd: 0.02, costBasis: "estimated", provider: "mistral" }, { failed: false, timedOut: false });
  ledger.recordTurn("vibe", "unknown-alias", { inputTokens: 1 }, { failed: false, timedOut: false });
  const grouped = usageByProvider(ledger.snapshot());
  assert.deepEqual(Object.keys(grouped).sort(), ["mistral", "opencode-go"]);
  assert.equal(grouped.mistral?.opencode?.costUsd, 0.01);
  assert.equal(grouped.mistral?.opencode?.spawns, 1);
  assert.equal(grouped.mistral?.vibe?.estimatedCostUsd, 0.02, "Vibe's estimate stays an estimate");
  assert.equal(grouped.mistral?.vibe?.costUsd, 0);
  // A ledger written before provider grouping still loads.
  await writeFile(file, JSON.stringify({ opencode: { turns: 3, models: {} } }));
  const old = new UsageLedger(file);
  await old.load();
  assert.equal(old.snapshot().opencode.turns, 3);
  assert.deepEqual(old.snapshot().opencode.providers, {});
});

// ------------------------------------------------------------------ provider errors

test("provider errors are read from both OpenCode shapes and classified by status, then text", () => {
  assert.deepEqual(providerErrorOf({ name: "APIError", data: { message: "Too many requests", statusCode: 429 } }), { message: "Too many requests", statusCode: 429, type: "APIError" });
  assert.deepEqual(providerErrorOf({ type: "provider.no-route", message: "Model unavailable: mistral/x" }), { message: "Model unavailable: mistral/x", type: "provider.no-route" });
  assert.equal(providerErrorOf({}), undefined);
  assert.equal(classifyProviderError("whatever", 429), "rate_limit");
  assert.equal(classifyProviderError("Rate limit exceeded for requests per second"), "rate_limit");
  assert.equal(classifyProviderError("Unauthorized: invalid api key"), "auth");
  assert.equal(classifyProviderError("You exceeded your current quota"), "quota");
  assert.equal(classifyProviderError("Model unavailable: mistral/x"), undefined, "an unknown error never triggers a cooldown");
  assert.equal(providerOf("opencode", "mistral/codestral-latest"), "mistral");
  assert.equal(providerOf("vibe", "mistral-medium-3.5"), undefined);
});

// ------------------------------------------------------------------ provider limits

test("models.yaml providerLimits parse, and bad entries are refused", async () => {
  const dir = await tempDir("limits");
  const file = path.join(dir, "models.yaml");
  await writeFile(file, "providerLimits:\n  mistral:\n    maxConcurrent: 2\n    cooldownSeconds: 30\nmodels:\n  claude: []\n  codex: []\n  opencode: []\n");
  assert.deepEqual((await loadModelsFile(file)).limits.providerLimits, { mistral: { maxConcurrent: 2, cooldownSeconds: 30 } });
  await writeFile(file, "providerLimits:\n  mistral:\n    maxConcurent: 2\nmodels:\n  claude: []\n  codex: []\n  opencode: []\n");
  await assert.rejects(loadModelsFile(file), /unknown field\(s\) maxConcurent/);
  await writeFile(file, "providerLimits:\n  mistral/x:\n    maxConcurrent: 2\nmodels:\n  claude: []\n  codex: []\n  opencode: []\n");
  await assert.rejects(loadModelsFile(file), /is not a provider id/);
});

function opencodeSupervisor(providerLimits: Record<string, { maxConcurrent?: number; cooldownSeconds?: number }>) {
  const agent: AgentConfig = { name: "oc", backend: "opencode", description: "d", systemPrompt: "", permission: allow, env: {}, sourcePath: "/configs/oc.md" };
  const roster: ModelRoster = { claude: [], codex: [], opencode: [{ name: "mistral/a" }, { name: "other/b" }], antigravity: [], cursor: [], copilot: [], vibe: [] };
  const adapter = new FakeAdapter("opencode");
  const supervisor = new Supervisor({
    registry: new ConfigRegistry([agent], roster, { ...defaultServerLimits(), providerLimits }),
    adapters: new AdapterRegistry([adapter]),
    cwd: "/work",
  });
  const spawn = (model: string) => supervisor.spawnAgent({ agent: "oc", model, prompt: "p", description: "d", run_in_background: true });
  const finish = (id: string) => adapter.emit(id, "turn.completed", { turnId: `${id}-t`, status: "completed", finalText: "ok" });
  return { adapter, supervisor, spawn, finish };
}

async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a provider's maxConcurrent queues its own agents without blocking other providers", async () => {
  const f = opencodeSupervisor({ mistral: { maxConcurrent: 1 } });
  const first = await f.spawn("mistral/a");
  let secondStarted = false;
  const second = f.spawn("mistral/a").then((result) => { secondStarted = true; return result; });
  await f.spawn("other/b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondStarted, false, "the second Mistral agent waits for the provider slot");
  assert.equal(f.adapter.spawnRequests.length, 2, "another provider is not held up");
  const view = (await f.supervisor.listModels()).providers as Record<string, Record<string, unknown>>;
  assert.equal(view.mistral?.active, 1);
  assert.equal(view.mistral?.waiting, 1);
  f.finish(String(first.agent_id));
  await second;
  assert.equal(f.adapter.spawnRequests.length, 3);
});

test("a recognized rate limit puts the provider in cooldown; auth failures are counted but never cool down", async () => {
  const f = opencodeSupervisor({ mistral: { cooldownSeconds: 1 } });
  const first = await f.spawn("mistral/a");
  const id = String(first.agent_id);
  f.adapter.emit(id, "error", { code: "OPENCODE_RATE_LIMITED", message: "Too many requests", fatal: false, details: { statusCode: 429, class: "rate_limit" } });
  f.adapter.emit(id, "turn.completed", { turnId: `${id}-t`, status: "failed" });
  await until(() => ((f.supervisor.providersView().mistral as Record<string, unknown>)?.rate_limited) === 1);
  const view = f.supervisor.providersView().mistral as Record<string, unknown>;
  assert.equal(typeof view.cooling_down_until, "string");
  const started = Date.now();
  await f.spawn("mistral/a");
  assert.ok(Date.now() - started >= 700, `waited ${Date.now() - started}ms for the cooldown`);
  const other = await f.spawn("other/b");
  f.adapter.emit(String(other.agent_id), "error", { code: "OPENCODE_AUTH_FAILED", message: "Unauthorized", fatal: false, details: { statusCode: 401, class: "auth" } });
  await until(() => ((f.supervisor.providersView().other as Record<string, unknown>)?.auth_failures) === 1);
  assert.equal((f.supervisor.providersView().other as Record<string, unknown>).cooling_down_until, undefined);
});
