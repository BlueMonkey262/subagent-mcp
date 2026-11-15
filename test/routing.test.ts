import assert from "node:assert/strict";
import test from "node:test";

import type { Backend } from "../src/core/types.js";
import { parseCapabilityProfiles } from "../src/routing/capability-profile.js";
import { RoutingHistory } from "../src/routing/history.js";
import { selectModels, type CandidateSource } from "../src/routing/model-selector.js";

function source(overrides: Partial<CandidateSource> = {}): CandidateSource {
  const roster: Record<string, { name: string; blocked?: boolean }[]> = {
    codex: [{ name: "big" }, { name: "small" }, { name: "banned", blocked: true }],
    opencode: [{ name: "cheap/one" }],
    cursor: [{ name: "auto" }],
  };
  return {
    configs: () => [
      { name: "codex-general", backend: "codex" },
      { name: "opencode-general", backend: "opencode" },
      { name: "cursor-general", backend: "cursor" },
      { name: "codex-pinned", backend: "codex", model: "big" },
    ],
    roster: (backend) => roster[backend] ?? [],
    remaining: () => ({}),
    active: () => new Map(),
    ...overrides,
  };
}

const profiles = parseCapabilityProfiles([{ path: "test", models: {
  "codex/big": { quality: { review: 5, default: 4 }, cost: "high", latency: "slow", capabilities: ["tools", "long_context"] },
  "codex/small": { quality: 3, cost: "low", latency: "fast", capabilities: ["tools"] },
  "opencode/cheap/one": { quality: { review: 3 }, cost: "free", capabilities: ["tools"] },
} }]);

test("policy-blocked models never appear; pins and duplicates collapse to one candidate", async () => {
  const result = await selectModels(source(), {}, 10, { profiles });
  const ids = result.picks.map((pick) => `${pick.backend}/${pick.model}`);
  assert.ok(!ids.includes("codex/banned"));
  assert.equal(ids.filter((id) => id === "codex/big").length, 1);
  assert.deepEqual(result.rejected.find((entry) => entry.candidate === "codex/banned")?.reason, "blocked by model policy");
});

test("objective changes the ranking, and unknown cost never ranks as free", async () => {
  const quality = await selectModels(source(), { category: "review", objective: "quality" }, 1, { profiles });
  assert.equal(quality.picks[0]!.model, "big");
  const cost = await selectModels(source(), { category: "review", objective: "cost" }, 1, { profiles });
  assert.equal(cost.picks[0]!.model, "cheap/one");
  const all = await selectModels(source(), { objective: "cost" }, 4, { profiles });
  const cursor = all.picks.find((pick) => pick.backend === "cursor")!;
  assert.match(cursor.why, /cost unknown/);
  assert.ok(cursor.factors.cost < all.picks.find((pick) => pick.model === "cheap/one")!.factors.cost);
});

test("requirements, minimum quality, exclusions and backend filters reject with reasons", async () => {
  const strict = await selectModels(source(), { require: ["long_context"], min_quality: 4 }, 3, { profiles });
  assert.deepEqual(strict.picks.map((pick) => pick.model), ["big"]);
  assert.match(strict.rejected.find((entry) => entry.candidate === "cursor/auto")!.reason, /no routing profile/);
  assert.match(strict.notes.join(" "), /only 1 of 3/);
  const filtered = await selectModels(source(), { backends: ["codex"], exclude_models: ["codex/big"] }, 3, { profiles });
  assert.deepEqual(filtered.picks.map((pick) => pick.model), ["small"]);
});

test("quota: exhausted allowances and low live plan usage exclude a backend; missing data is unknown, not unlimited", async () => {
  const exhausted = await selectModels(source({ remaining: () => ({ codex: { spawns: 0 } }) }), {}, 5, { profiles });
  assert.ok(exhausted.picks.every((pick) => pick.backend !== "codex"));
  assert.match(exhausted.rejected.find((entry) => entry.candidate === "codex/big")!.reason, /allowance used up: spawns/);

  const live = source({ live: async (backend: Backend) => backend === "opencode"
    ? { usage: { rolling: { remaining_percent: 2 } }, roster_not_offered: [] }
    : backend === "cursor" ? { roster_not_offered: ["auto"] } : undefined });
  const result = await selectModels(live, { live_quota: true }, 5, { profiles });
  const backends = result.picks.map((pick) => pick.backend);
  assert.ok(!backends.includes("opencode"), "2% left is below the default 5% threshold");
  assert.ok(!backends.includes("cursor"), "not offered by the live catalog");
  assert.ok(backends.includes("codex"), "no live data for codex: unknown, still eligible");

  const none = await selectModels(source(), {}, 1, { profiles });
  assert.match(none.notes.join(" "), /no quota information/);
});

test("live_quota judges a config on another signed-in account by that account, not the default one", async () => {
  const configs = () => [
    { name: "codex-general", backend: "codex" as const },
    { name: "codex-alt", backend: "codex" as const },
  ];
  const live = (alt: Readonly<Record<string, unknown>>) => source({
    configs,
    live: async (backend: Backend) => backend === "codex"
      ? { usage_limits: { plan: { weekly: { remaining_percent: 60 } } }, roster_not_offered: [], accounts: [{ account: "/alt", agents: ["codex-alt"], ...alt }] }
      : undefined,
  });

  const lowAlt = live({ usage_limits: { plan: { weekly: { remaining_percent: 1 } } }, roster_not_offered: [] });
  const onAlt = await selectModels(lowAlt, { live_quota: true, configs: ["codex-alt"] }, 2, { profiles });
  assert.deepEqual(onAlt.picks, [], "the second account is exhausted");
  assert.match(onAlt.rejected.find((entry) => entry.candidate === "codex/big")!.reason, /1% left/);
  const onDefault = await selectModels(lowAlt, { live_quota: true, configs: ["codex-general"] }, 2, { profiles });
  assert.equal(onDefault.picks.length, 2, "the second account's usage does not count against the default one");

  const smallerPlan = live({ usage_limits: { plan: { weekly: { remaining_percent: 90 } } }, roster_not_offered: ["big"] });
  const offered = await selectModels(smallerPlan, { live_quota: true, configs: ["codex-alt"] }, 2, { profiles });
  assert.deepEqual(offered.picks.map((pick) => pick.model), ["small"]);
  assert.match(offered.rejected.find((entry) => entry.candidate === "codex/big")!.reason, /not offered/);
});

test("diversity: distinct models by default, distinct backends on request", async () => {
  const byModel = await selectModels(source(), { category: "review", objective: "quality" }, 2, { profiles });
  assert.notEqual(byModel.picks[0]!.model, byModel.picks[1]!.model);
  const byBackend = await selectModels(source(), { category: "review", objective: "quality", distinct: "backend" }, 2, { profiles });
  assert.notEqual(byBackend.picks[0]!.backend, byBackend.picks[1]!.backend);
  const taken = await selectModels(source(), { category: "review", objective: "quality" }, 1, { profiles, taken: [{ config: "x", backend: "codex", model: "big" }] });
  assert.notEqual(taken.picks[0]!.model, "big");
});

test("history outranks declarations: a model that keeps failing loses to one that keeps succeeding", async () => {
  const history = new RoutingHistory();
  for (let index = 0; index < 10; index += 1) {
    await history.record({ at: "", backend: "codex", model: "big", config: "c", category: "review", state: index < 3 ? "completed" : "failed", valid: index < 3, duration_ms: 60_000, cost_usd: 0.5, tokens: 1 });
    await history.record({ at: "", backend: "codex", model: "small", config: "c", category: "review", state: "completed", valid: true, duration_ms: 20_000, cost_usd: 0.05, tokens: 1 });
  }
  const result = await selectModels(source(), { category: "review", backends: ["codex"] }, 1, { profiles, history });
  assert.equal(result.picks[0]!.model, "small");
  assert.match(result.picks[0]!.why, /10\/10 valid/);
  // Interrupted runs carry no signal about the model.
  await history.record({ at: "", backend: "codex", model: "small", config: "c", category: "review", state: "interrupted", valid: false, duration_ms: 1, cost_usd: null, tokens: null });
  assert.equal(history.stats("codex", "small", "review").trials, 10);
});

/**
 * Measured routing improvement. Three models with hidden success rates per category; the
 * baseline always uses the operator's configured model, the router picks with selectModels and
 * learns from the outcomes it records. Seeded, so the comparison is deterministic.
 */
test("routing performs at least as well as a fixed baseline and converges on the best model", async () => {
  const truth: Record<string, number> = { "codex/big": 0.55, "codex/small": 0.9, "opencode/cheap/one": 0.35 };
  let seed = 42;
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const history = new RoutingHistory();
  const rounds = 300;
  let routed = 0, baseline = 0;
  const picks: Record<string, number> = {};
  for (let round = 0; round < rounds; round += 1) {
    // Baseline: the configured default (the highest declared quality), never revisited.
    if (random() < truth["codex/big"]!) baseline += 1;
    const pick = (await selectModels(source(), { category: "review", backends: ["codex", "opencode"] }, 1, { profiles, history })).picks[0]!;
    const id = `${pick.backend}/${pick.model}`;
    picks[id] = (picks[id] ?? 0) + 1;
    const valid = random() < truth[id]!;
    if (valid) routed += 1;
    await history.record({ at: "", backend: pick.backend, model: pick.model, config: pick.config, category: "review", state: valid ? "completed" : "failed", valid, duration_ms: null, cost_usd: null, tokens: null });
  }
  assert.ok(routed >= baseline, `routed ${routed} vs baseline ${baseline}`);
  assert.ok(routed / rounds > 0.8, `routed success ${routed / rounds}`);
  const favorite = Object.entries(picks).sort((a, b) => b[1] - a[1])[0]![0];
  assert.equal(favorite, "codex/small");
});

test("a config pinned to a model missing from the roster is rejected, not picked", async () => {
  const result = await selectModels(source({
    configs: () => [{ name: "codex-gone", backend: "codex", model: "removed" }, { name: "codex-general", backend: "codex" }],
  }), {}, 3, { profiles });
  assert.ok(!result.picks.some((pick) => pick.model === "removed"));
  assert.ok(result.picks.length > 0, "the other candidates are still picked");
  assert.match(result.rejected.find((entry) => entry.candidate === "config codex-gone")!.reason, /not in the codex roster/);
});
