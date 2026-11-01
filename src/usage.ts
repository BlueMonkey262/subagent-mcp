import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Allowance } from "./config/schema.js";
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
  costUsd: number;
}

export interface BackendUsage extends UsageTotals {
  models: Record<string, UsageTotals>;
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
});

function emptySnapshot(): UsageSnapshot {
  return Object.fromEntries(BACKENDS.map((backend) => [backend, { ...ZERO(), models: {} }])) as UsageSnapshot;
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
    this.#usage[backend].spawns += 1;
    this.#schedule();
  }

  recordResume(backend: Backend, model: string): void {
    const totals = this.#model(backend, model);
    totals.resumes += 1;
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
      totals.costUsd += extracted.costUsd;
    };
    apply(this.#model(backend, model));
    apply(this.#usage[backend]);
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
      ...(allowance.maxCostUsd === undefined ? {} : { costUsd: allowance.maxCostUsd - spent.costUsd }),
    };
  }
  return remaining;
}

function extractUsage(usage: Readonly<Record<string, unknown>> | undefined): Pick<UsageTotals, "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd"> {
  if (usage === undefined) return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
  return {
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
