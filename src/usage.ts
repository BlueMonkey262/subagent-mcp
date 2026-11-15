import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Allowance } from "./config/schema.js";
import { providerOf } from "./core/providers.js";
import { BACKENDS, type Backend } from "./core/types.js";

export interface UsageTotals {
  spawns: number;
  resumes: number;
  turns: number;
  failures: number;
  timeouts: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Provider-reported (or unknown-basis) cost. */
  costUsd: number;
  /**
   * Cost computed locally from configured prices (Vibe's `cost_usd`), kept apart from `costUsd` so an
   * estimate is never summed into a figure that reads as a bill. Both count against `maxCostUsd`.
   */
  estimatedCostUsd: number;
}

export interface BackendUsage extends UsageTotals {
  models: Record<string, UsageTotals>;
  /**
   * The same usage split by upstream provider, where it is known: OpenCode's `provider/model`
   * prefix, or the provider Vibe reports for its alias. Lets Mistral API usage through OpenCode be
   * told apart from Vibe plan usage and from other OpenCode providers.
   */
  providers: Record<string, UsageTotals>;
}

/** Usage per provider, then per backend that reached it (`{ mistral: { opencode, vibe } }`). */
export function usageByProvider(usage: UsageSnapshot): Record<string, Partial<Record<Backend, UsageTotals>>> {
  const grouped: Record<string, Partial<Record<Backend, UsageTotals>>> = {};
  for (const backend of BACKENDS) {
    for (const [provider, totals] of Object.entries(usage[backend].providers)) {
      (grouped[provider] ??= {})[backend] = totals;
    }
  }
  return grouped;
}

export type UsageSnapshot = Record<Backend, BackendUsage>;

const ZERO = (): UsageTotals => ({
  spawns: 0,
  resumes: 0,
  turns: 0,
  failures: 0,
  timeouts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0,
  estimatedCostUsd: 0,
});

function emptySnapshot(): UsageSnapshot {
  return Object.fromEntries(BACKENDS.map((backend) => [backend, { ...ZERO(), models: {}, providers: {} }])) as UsageSnapshot;
}

/** Observed spend for this project. Persisted so a reconnect does not reset the counters. */
export class UsageLedger {
  #usage = emptySnapshot();
  #write: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string) {}

  async load(): Promise<void> {
    if (this.path === undefined) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isRecord(parsed)) return;
      const next = emptySnapshot();
      for (const backend of BACKENDS) {
        const raw = parsed[backend];
        if (!isRecord(raw)) continue;
        next[backend] = {
          ...ZERO(),
          ...readTotals(raw),
          models: readModels(raw["models"]),
          providers: readModels(raw["providers"]),
        };
      }
      this.#usage = next;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  snapshot(): UsageSnapshot {
    return structuredClone(this.#usage);
  }

  recordSpawn(backend: Backend, model: string): void {
    const totals = this.#model(backend, model);
    totals.spawns += 1;
    const provider = this.#provider(backend, providerOf(backend, model));
    if (provider) provider.spawns += 1;
    this.#usage[backend].spawns += 1;
    this.#schedule();
  }

  recordResume(backend: Backend, model: string): void {
    const totals = this.#model(backend, model);
    totals.resumes += 1;
    const provider = this.#provider(backend, providerOf(backend, model));
    if (provider) provider.resumes += 1;
    this.#usage[backend].resumes += 1;
    this.#schedule();
  }

  recordTurn(
    backend: Backend,
    model: string,
    usage: object | undefined,
    flags: { readonly failed: boolean; readonly timedOut: boolean },
  ): void {
    const extracted = extractUsage(isRecord(usage) ? usage : undefined);
    const apply = (totals: UsageTotals): void => {
      totals.turns += 1;
      if (flags.failed) totals.failures += 1;
      if (flags.timedOut) totals.timeouts += 1;
      totals.inputTokens += extracted.inputTokens;
      totals.outputTokens += extracted.outputTokens;
      totals.cachedInputTokens += extracted.cachedInputTokens;
      if (extracted.estimated) totals.estimatedCostUsd += extracted.costUsd;
      else totals.costUsd += extracted.costUsd;
    };
    apply(this.#model(backend, model));
    apply(this.#usage[backend]);
    const reported = isRecord(usage) && typeof usage["provider"] === "string" && usage["provider"] !== "" ? usage["provider"] : undefined;
    const provider = this.#provider(backend, reported ?? providerOf(backend, model));
    if (provider) apply(provider);
    this.#schedule();
  }

  #model(backend: Backend, model: string): UsageTotals {
    const models = this.#usage[backend].models;
    const existing = models[model];
    if (existing) return existing;
    const created = ZERO();
    models[model] = created;
    return created;
  }

  #provider(backend: Backend, provider: string | undefined): UsageTotals | undefined {
    if (provider === undefined) return undefined;
    const providers = this.#usage[backend].providers;
    return (providers[provider] ??= ZERO());
  }

  #schedule(): void {
    if (this.path === undefined) return;
    this.#write = this.#write.then(() => this.#flush()).catch(() => undefined);
  }

  async #flush(): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#usage, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

export function remainingAllowances(
  allowances: Readonly<Partial<Record<Backend, Allowance>>>,
  usage: UsageSnapshot,
): Partial<Record<Backend, Partial<UsageTotals>>> {
  const remaining: Partial<Record<Backend, Partial<UsageTotals>>> = {};
  for (const backend of BACKENDS) {
    const allowance = allowances[backend];
    if (allowance === undefined) continue;
    const spent = usage[backend];
    remaining[backend] = {
      ...(allowance.maxSpawns === undefined ? {} : { spawns: allowance.maxSpawns - spent.spawns }),
      ...(allowance.maxInputTokens === undefined ? {} : { inputTokens: allowance.maxInputTokens - spent.inputTokens }),
      ...(allowance.maxOutputTokens === undefined ? {} : { outputTokens: allowance.maxOutputTokens - spent.outputTokens }),
      ...(allowance.maxCostUsd === undefined ? {} : { costUsd: allowance.maxCostUsd - spent.costUsd - spent.estimatedCostUsd }),
    };
  }
  return remaining;
}

function extractUsage(usage: Readonly<Record<string, unknown>> | undefined):
  Pick<UsageTotals, "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd"> & { readonly estimated: boolean } {
  if (usage === undefined) return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, estimated: false };
  return {
    estimated: usage["costBasis"] === "estimated",
    inputTokens: numberField(usage, ["inputTokens", "input_tokens", "prompt_tokens"]),
    outputTokens: numberField(usage, ["outputTokens", "output_tokens", "completion_tokens"]),
    cachedInputTokens: numberField(usage, ["cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens"]),
    costUsd: numberField(usage, ["costUsd", "cost_usd", "total_cost_usd", "cost"]),
  };
}

function readTotals(raw: Readonly<Record<string, unknown>>): UsageTotals {
  const zero = ZERO();
  return {
    spawns: nonNegative(raw["spawns"], zero.spawns),
    resumes: nonNegative(raw["resumes"], zero.resumes),
    turns: nonNegative(raw["turns"], zero.turns),
    failures: nonNegative(raw["failures"], zero.failures),
    timeouts: nonNegative(raw["timeouts"], zero.timeouts),
    inputTokens: nonNegative(raw["inputTokens"], zero.inputTokens),
    outputTokens: nonNegative(raw["outputTokens"], zero.outputTokens),
    cachedInputTokens: nonNegative(raw["cachedInputTokens"], zero.cachedInputTokens),
    costUsd: nonNegative(raw["costUsd"], zero.costUsd),
    estimatedCostUsd: nonNegative(raw["estimatedCostUsd"], zero.estimatedCostUsd),
  };
}

function readModels(value: unknown): Record<string, UsageTotals> {
  if (!isRecord(value)) return {};
  const models: Record<string, UsageTotals> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (isRecord(raw)) models[name] = readTotals(raw);
  }
  return models;
}

function numberField(record: Readonly<Record<string, unknown>>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
