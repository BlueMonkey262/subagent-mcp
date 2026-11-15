import { z } from "zod";

import { BACKENDS, type Backend } from "../core/types.js";
import { declaredQuality, EMPTY_PROFILES, type CapabilityProfiles } from "./capability-profile.js";
import { RoutingHistory, type ModelStats } from "./history.js";

export const OBJECTIVES = ["balanced", "quality", "cost", "latency", "reliability"] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const selectionCriteriaSchema = z.strictObject({
  category: z.string().min(1).max(60).optional().describe("Task category, e.g. review, implementation, research"),
  objective: z.enum(OBJECTIVES).optional().describe("What to optimize; default balanced"),
  backends: z.array(z.enum(BACKENDS)).min(1).optional().describe("Only these backends"),
  exclude_backends: z.array(z.enum(BACKENDS)).optional(),
  configs: z.array(z.string()).min(1).optional().describe("Only these agent configs"),
  exclude_models: z.array(z.string()).optional().describe('"model" or "backend/model"'),
  require: z.array(z.string()).optional().describe("Capabilities every pick must declare in routing.models"),
  min_quality: z.number().min(1).max(5).optional().describe("Minimum declared quality (1-5); undeclared quality is excluded"),
  live_quota: z.boolean().optional().describe("Ask each backend for live plan usage and skip exhausted ones (slower)"),
  min_remaining_percent: z.number().min(0).max(100).optional().describe("live_quota threshold; default 5"),
  distinct: z.enum(["model", "backend", "none"]).optional().describe("Diversity across picks; default model"),
  explore: z.boolean().optional().describe("Give rarely tried models a bounded bonus; default true"),
});
export type SelectionCriteria = z.infer<typeof selectionCriteriaSchema>;

/** Where candidates and their availability come from; the Supervisor in production, a fixture in tests. */
export interface CandidateSource {
  configs(): readonly { readonly name: string; readonly backend: Backend; readonly model?: string; readonly blocked?: boolean }[];
  roster(backend: Backend): readonly { readonly name: string; readonly blocked?: boolean }[];
  /** Remaining local allowance per backend (models.yaml `allowances`); a backend without one is absent. */
  remaining(): Readonly<Partial<Record<Backend, Readonly<Record<string, number>>>>>;
  /** Agents currently starting, running or waiting for approval, per backend. */
  active(): ReadonlyMap<Backend, number>;
  /** The backend's live provider info (list_models live), when it has one. */
  live?(backend: Backend): Promise<Readonly<Record<string, unknown>> | undefined>;
}

export interface Candidate {
  readonly config: string;
  readonly backend: Backend;
  readonly model: string;
}

/** Quota is unknown unless something reports it: no allowance and no live data is not "unlimited". */
export type QuotaState =
  | { readonly state: "unknown" }
  | { readonly state: "available"; readonly remaining_percent?: number; readonly source: "allowance" | "live" }
  | { readonly state: "exhausted"; readonly source: "allowance" | "live"; readonly detail: string };

export interface ScoredCandidate extends Candidate {
  readonly score: number;
  readonly factors: { readonly quality: number; readonly reliability: number; readonly cost: number; readonly latency: number };
  readonly why: string;
}

export interface SelectionPick extends Candidate {
  readonly role: string;
  readonly score: number;
  readonly why: string;
}

export interface SelectionReport {
  readonly criteria: SelectionCriteria;
  readonly considered: number;
  readonly chosen: readonly SelectionPick[];
  readonly rejected?: readonly { readonly candidate: string; readonly reason: string }[];
  readonly notes?: readonly string[];
}

const WEIGHTS: Readonly<Record<Objective, { quality: number; reliability: number; cost: number; latency: number }>> = {
  balanced: { quality: 0.4, reliability: 0.3, cost: 0.15, latency: 0.15 },
  quality: { quality: 0.6, reliability: 0.3, cost: 0.05, latency: 0.05 },
  cost: { quality: 0.2, reliability: 0.3, cost: 0.4, latency: 0.1 },
  latency: { quality: 0.2, reliability: 0.3, cost: 0.1, latency: 0.4 },
  reliability: { quality: 0.2, reliability: 0.6, cost: 0.1, latency: 0.1 },
};
const COST_SCORE = { free: 1, low: 0.8, medium: 0.5, high: 0.2 } as const;
const LATENCY_SCORE = { fast: 0.9, medium: 0.5, slow: 0.2 } as const;
/** Unknown cost ranks below a declared medium tier: an unpriced model must never look free. */
const UNKNOWN_COST_SCORE = 0.4;
const UNKNOWN_SCORE = 0.5;
const EXPLORE_WEIGHT = 0.15;

const candidateId = (candidate: Candidate) => `${candidate.backend}/${candidate.model}`;

/**
 * Every runnable (config, model) pair the criteria allow. A config that pins a model offers only that
 * model; an unpinned config offers every unblocked roster model of its backend. When several configs
 * offer the same backend/model, the first in `criteria.configs` order (else by name) represents it.
 */
export function gatherCandidates(source: CandidateSource, criteria: SelectionCriteria): { candidates: Candidate[]; rejected: { candidate: string; reason: string }[] } {
  const rejected: { candidate: string; reason: string }[] = [];
  const configOrder = criteria.configs ?? [];
  const configs = [...source.configs()]
    .filter((config) => criteria.configs === undefined || configOrder.includes(config.name))
    .sort((a, b) => {
      const rank = (name: string) => { const index = configOrder.indexOf(name); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
      return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
    });
  const seen = new Map<string, Candidate>();
  for (const config of configs) {
    if (criteria.backends !== undefined && !criteria.backends.includes(config.backend)) continue;
    if (criteria.exclude_backends?.includes(config.backend)) continue;
    if (config.blocked === true) { rejected.push({ candidate: `config ${config.name}`, reason: "blocked by model policy" }); continue; }
    const roster = source.roster(config.backend);
    let models: readonly { readonly name: string; readonly blocked?: boolean }[] = roster;
    if (config.model !== undefined) {
      const pinned = roster.find((entry) => entry.name === config.model);
      if (pinned === undefined) {
        // Spawning it would fail with "Unknown model", so never pick it over a candidate that works.
        rejected.push({ candidate: `config ${config.name}`, reason: `pinned model ${config.model} is not in the ${config.backend} roster` });
        continue;
      }
      models = [pinned];
    }
    for (const entry of models) {
      const candidate = { config: config.name, backend: config.backend, model: entry.name };
      const id = candidateId(candidate);
      if (seen.has(id)) continue;
      if (entry.blocked === true) { rejected.push({ candidate: id, reason: "blocked by model policy" }); continue; }
      if (criteria.exclude_models?.some((pattern) => pattern === entry.name || pattern === id)) {
        rejected.push({ candidate: id, reason: "excluded by criteria" });
        continue;
      }
      seen.set(id, candidate);
    }
  }
  return { candidates: [...seen.values()], rejected };
}

/**
 * Local allowances, then (when asked) the backend's live plan usage. Missing data stays "unknown".
 * Keyed by backend, plus `config:<name>` for a config whose `env:` selects another signed-in
 * account (live `accounts`): that config is judged by its own account's plan usage.
 */
export async function quotaStates(
  source: CandidateSource,
  backends: readonly Backend[],
  criteria: SelectionCriteria,
): Promise<Map<string, QuotaState>> {
  const states = new Map<string, QuotaState>();
  const remaining = source.remaining();
  for (const backend of backends) {
    const allowance = remaining[backend];
    if (allowance === undefined) { states.set(backend, { state: "unknown" }); continue; }
    const spent = Object.entries(allowance).filter(([, value]) => value <= 0).map(([key]) => key);
    states.set(backend, spent.length > 0
      ? { state: "exhausted", source: "allowance", detail: `allowance used up: ${spent.join(", ")}` }
      : { state: "available", source: "allowance" });
  }
  if (criteria.live_quota === true && source.live !== undefined) {
    const threshold = criteria.min_remaining_percent ?? 5;
    await Promise.all(backends.map(async (backend) => {
      if (states.get(backend)?.state === "exhausted") return;
      let info: Readonly<Record<string, unknown>> | undefined;
      try { info = await source.live!(backend); } catch { return; }
      if (info === undefined) return;
      const { accounts, ...own } = info;
      const allowance = states.get(backend);
      const state = liveQuota(own, threshold);
      if (state !== undefined) states.set(backend, state);
      for (const account of liveAccounts(accounts)) {
        const accountState = liveQuota(account, threshold) ?? allowance;
        if (accountState === undefined) continue;
        for (const name of account.agents) states.set(`config:${name}`, accountState);
      }
    }));
  }
  return states;
}

function liveQuota(info: unknown, threshold: number): QuotaState | undefined {
  const percents = collectNumbers(info, "remaining_percent");
  if (percents.length === 0) return undefined;
  const lowest = Math.min(...percents);
  return lowest < threshold
    ? { state: "exhausted", source: "live", detail: `live plan usage has ${lowest}% left (< ${threshold}%)` }
    : { state: "available", source: "live", remaining_percent: lowest };
}

/** The live `accounts` entries (list_models): another signed-in account and the configs on it. */
function liveAccounts(value: unknown): (Readonly<Record<string, unknown>> & { readonly agents: readonly string[] })[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const agents = (entry as Record<string, unknown>)["agents"];
    return Array.isArray(agents) ? [{ ...(entry as Record<string, unknown>), agents: agents.filter((name): name is string => typeof name === "string") }] : [];
  });
}

function notOffered(info: unknown): readonly string[] {
  const list = typeof info === "object" && info !== null ? (info as Record<string, unknown>)["roster_not_offered"] : undefined;
  return Array.isArray(list) ? list.filter((model): model is string => typeof model === "string") : [];
}

/**
 * Models the backend's live catalog says it does not offer: `backend/model` ids for the default
 * account, and per config for a config on another account (its plan may offer less).
 */
export async function unofferedModels(source: CandidateSource, backends: readonly Backend[]): Promise<{ byBackend: Set<string>; byConfig: Map<string, Set<string>> }> {
  const byBackend = new Set<string>();
  const byConfig = new Map<string, Set<string>>();
  if (source.live === undefined) return { byBackend, byConfig };
  await Promise.all(backends.map(async (backend) => {
    try {
      const info = await source.live!(backend);
      for (const model of notOffered(info)) byBackend.add(`${backend}/${model}`);
      for (const account of liveAccounts(info?.["accounts"])) {
        const missing = new Set(notOffered(account).map((model) => `${backend}/${model}`));
        for (const name of account.agents) byConfig.set(name, missing);
      }
    } catch { /* unknown: keep */ }
  }));
  return { byBackend, byConfig };
}

/** Deterministic, explainable score. Reliability, cost and latency prefer measured history over declarations. */
export function scoreCandidates(
  candidates: readonly Candidate[],
  criteria: SelectionCriteria,
  options: { readonly profiles?: CapabilityProfiles; readonly history?: RoutingHistory; readonly quotas?: ReadonlyMap<string, QuotaState>; readonly active?: ReadonlyMap<Backend, number> } = {},
): { scored: ScoredCandidate[]; rejected: { candidate: string; reason: string }[] } {
  const profiles = options.profiles ?? EMPTY_PROFILES;
  const history = options.history ?? new RoutingHistory();
  const weights = WEIGHTS[criteria.objective ?? "balanced"];
  const rejected: { candidate: string; reason: string }[] = [];
  const stats = new Map<string, ModelStats>(candidates.map((candidate) =>
    [candidateId(candidate), history.stats(candidate.backend, candidate.model, criteria.category)]));
  const knownCosts = [...stats.values()].map((entry) => entry.median_cost_usd).filter((value): value is number => value !== null);
  const knownDurations = [...stats.values()].map((entry) => entry.median_duration_ms).filter((value): value is number => value !== null);
  const maxCost = Math.max(0, ...knownCosts);
  const maxDuration = Math.max(0, ...knownDurations);
  const total = history.totalTrials(criteria.category);
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const id = candidateId(candidate);
    const profile = profiles.get(candidate.backend, candidate.model);
    const quota = options.quotas?.get(`config:${candidate.config}`) ?? options.quotas?.get(candidate.backend) ?? { state: "unknown" as const };
    if (quota.state === "exhausted") { rejected.push({ candidate: id, reason: quota.detail }); continue; }
    const missingCapabilities = (criteria.require ?? []).filter((capability) => !(profile?.capabilities ?? []).includes(capability));
    if (missingCapabilities.length > 0) {
      rejected.push({ candidate: id, reason: profile === undefined ? "no routing profile declares its capabilities" : `lacks ${missingCapabilities.join(", ")}` });
      continue;
    }
    const rating = declaredQuality(profile, criteria.category);
    if (criteria.min_quality !== undefined && (rating === undefined || rating < criteria.min_quality)) {
      rejected.push({ candidate: id, reason: rating === undefined ? "quality not declared" : `quality ${rating} < ${criteria.min_quality}` });
      continue;
    }
    const why: string[] = [];
    const quality = rating === undefined ? UNKNOWN_SCORE : (rating - 1) / 4;
    why.push(rating === undefined ? "quality unknown" : `quality ${rating}/5`);

    const measured = stats.get(id)!;
    const reliability = measured.reliability;
    why.push(measured.trials === 0 ? "no history" : `${measured.valid}/${measured.trials} valid${measured.category_specific ? "" : " (all categories)"}`);
    const explore = criteria.explore === false ? 0 : EXPLORE_WEIGHT * Math.min(1, Math.sqrt(Math.log(total + 1) / (measured.trials + 1)));

    let cost: number;
    if (measured.median_cost_usd !== null) {
      cost = maxCost === 0 ? 1 : 1 - measured.median_cost_usd / maxCost;
      why.push(`~$${round(measured.median_cost_usd)}/run`);
    } else if (profile?.cost !== undefined) {
      cost = COST_SCORE[profile.cost];
      why.push(`cost ${profile.cost}`);
    } else {
      cost = UNKNOWN_COST_SCORE;
      why.push("cost unknown");
    }

    let latency: number;
    if (measured.median_duration_ms !== null) {
      latency = maxDuration === 0 ? 1 : 1 - (measured.median_duration_ms / maxDuration) * 0.8;
      why.push(`~${Math.round(measured.median_duration_ms / 1000)}s`);
    } else {
      latency = profile?.latency === undefined ? UNKNOWN_SCORE : LATENCY_SCORE[profile.latency];
      if (profile?.latency !== undefined) why.push(profile.latency);
    }

    let score = weights.quality * quality + weights.reliability * reliability + weights.cost * cost + weights.latency * latency + weights.reliability * explore;
    if (quota.state === "available" && quota.remaining_percent !== undefined && quota.remaining_percent < 20) {
      score -= 0.1;
      why.push(`${quota.remaining_percent}% plan left`);
    }
    const busy = options.active?.get(candidate.backend) ?? 0;
    if (busy > 0) score -= Math.min(0.1, 0.02 * busy);
    scored.push({ ...candidate, score: round(score), factors: { quality: round(quality), reliability: round(reliability), cost: round(cost), latency: round(latency) }, why: why.join("; ") });
  }
  scored.sort((a, b) => b.score - a.score || candidateId(a).localeCompare(candidateId(b)));
  return { scored, rejected };
}

/** Greedy picks with diversity: distinct models by default, and a soft penalty for reusing a backend. */
export function pickDiverse(scored: readonly ScoredCandidate[], count: number, distinct: "model" | "backend" | "none" = "model", taken: readonly Candidate[] = []): ScoredCandidate[] {
  const picks: ScoredCandidate[] = [];
  const chosen = [...taken];
  for (let index = 0; index < count; index += 1) {
    let best: { candidate: ScoredCandidate; value: number } | undefined;
    for (const candidate of scored) {
      const sameModel = chosen.some((other) => candidateId(other) === candidateId(candidate));
      if (sameModel && distinct !== "none") continue;
      const sameBackend = chosen.filter((other) => other.backend === candidate.backend).length;
      const value = candidate.score - (distinct === "backend" ? 0.3 : 0.05) * sameBackend;
      if (best === undefined || value > best.value) best = { candidate, value };
    }
    if (best === undefined) break;
    picks.push(best.candidate);
    chosen.push(best.candidate);
  }
  return picks;
}

export interface SelectOptions {
  readonly profiles?: CapabilityProfiles;
  readonly history?: RoutingHistory;
  /** Members already chosen (explicitly or by an earlier selection), for diversity. */
  readonly taken?: readonly Candidate[];
}

/** The whole pipeline: gather, check quota and availability, score, pick. */
export async function selectModels(
  source: CandidateSource,
  criteria: SelectionCriteria,
  count: number,
  options: SelectOptions = {},
): Promise<{ picks: ScoredCandidate[]; considered: number; rejected: { candidate: string; reason: string }[]; notes: string[] }> {
  const gathered = gatherCandidates(source, criteria);
  const backends = [...new Set(gathered.candidates.map((candidate) => candidate.backend))];
  const notes: string[] = [];
  let candidates = gathered.candidates;
  const rejected = [...gathered.rejected];
  if (criteria.live_quota === true) {
    const unoffered = await unofferedModels(source, backends);
    candidates = candidates.filter((candidate) => {
      const missing = unoffered.byConfig.get(candidate.config) ?? unoffered.byBackend;
      if (!missing.has(candidateId(candidate))) return true;
      rejected.push({ candidate: candidateId(candidate), reason: "not offered by the backend's live catalog" });
      return false;
    });
  }
  const quotas = await quotaStates(source, backends, criteria);
  const { scored, rejected: scoreRejected } = scoreCandidates(candidates, criteria, {
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    ...(options.history === undefined ? {} : { history: options.history }),
    quotas,
    active: source.active(),
  });
  rejected.push(...scoreRejected);
  const picks = pickDiverse(scored, count, criteria.distinct ?? "model", options.taken ?? []);
  if (picks.length < count) notes.push(`only ${picks.length} of ${count} requested picks satisfy the criteria`);
  if ([...quotas.values()].every((quota) => quota.state === "unknown")) notes.push("no quota information: allowances unset and live_quota off");
  return { picks, considered: candidates.length, rejected, notes };
}

function collectNumbers(value: unknown, key: string, out: number[] = []): number[] {
  if (Array.isArray(value)) for (const item of value) collectNumbers(item, key, out);
  else if (typeof value === "object" && value !== null) {
    for (const [name, item] of Object.entries(value)) {
      if (name === key && typeof item === "number" && Number.isFinite(item)) out.push(item);
      else collectNumbers(item, key, out);
    }
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
