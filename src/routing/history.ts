import { AppendOnlyJsonlStore } from "../storage/jsonl.js";
import type { Backend } from "../core/types.js";

/** One settled ensemble member, as measured. Unknown cost or tokens stay null, never zero. */
export interface OutcomeRecord {
  readonly at: string;
  readonly backend: Backend;
  readonly model: string;
  readonly config: string;
  readonly category: string;
  /** completed, failed, interrupted or blocked. */
  readonly state: string;
  /** Completed with a usable (schema-valid when required) result. */
  readonly valid: boolean;
  readonly duration_ms: number | null;
  readonly cost_usd: number | null;
  readonly tokens: number | null;
  readonly ensemble_id?: string;
}

export interface ModelStats {
  readonly trials: number;
  readonly valid: number;
  /** Laplace-smoothed share of valid results: (valid + 1) / (trials + 2). */
  readonly reliability: number;
  readonly median_cost_usd: number | null;
  readonly median_duration_ms: number | null;
  /** True when the numbers come from this category; false when they fall back to all categories. */
  readonly category_specific: boolean;
}

const KEEP_PER_MODEL = 200;
/** Interrupted runs say nothing about the model (a user or the host stopped them). */
const COUNTED_STATES = new Set(["completed", "failed"]);

/** Measured outcomes per backend/model, kept in memory (last 200 per model) and appended to a JSONL file. */
export class RoutingHistory {
  readonly #byModel = new Map<string, OutcomeRecord[]>();
  readonly #store: AppendOnlyJsonlStore<OutcomeRecord> | undefined;

  constructor(path?: string) {
    this.#store = path === undefined ? undefined : new AppendOnlyJsonlStore<OutcomeRecord>(path);
  }

  async load(): Promise<void> {
    if (this.#store === undefined) return;
    await this.#store.repairTail();
    for (const { value } of await this.#store.readAll()) {
      if (typeof value?.backend === "string" && typeof value.model === "string") this.#remember(value);
    }
  }

  async record(outcome: OutcomeRecord): Promise<void> {
    this.#remember(outcome);
    await this.#store?.append(outcome);
  }

  stats(backend: Backend, model: string, category?: string): ModelStats {
    const all = (this.#byModel.get(`${backend}/${model}`) ?? []).filter((entry) => COUNTED_STATES.has(entry.state));
    const scoped = category === undefined ? [] : all.filter((entry) => entry.category === category);
    const entries = scoped.length > 0 ? scoped : all;
    const valid = entries.filter((entry) => entry.valid).length;
    return {
      trials: entries.length,
      valid,
      reliability: (valid + 1) / (entries.length + 2),
      median_cost_usd: median(entries.map((entry) => entry.cost_usd)),
      median_duration_ms: median(entries.map((entry) => entry.duration_ms)),
      category_specific: scoped.length > 0,
    };
  }

  /** Total counted trials across models, for exploration bonuses. */
  totalTrials(category?: string): number {
    let total = 0;
    for (const entries of this.#byModel.values()) {
      total += entries.filter((entry) => COUNTED_STATES.has(entry.state) && (category === undefined || entry.category === category)).length;
    }
    return total;
  }

  #remember(outcome: OutcomeRecord): void {
    const key = `${outcome.backend}/${outcome.model}`;
    const entries = this.#byModel.get(key) ?? [];
    entries.push(outcome);
    if (entries.length > KEEP_PER_MODEL) entries.splice(0, entries.length - KEEP_PER_MODEL);
    this.#byModel.set(key, entries);
  }
}

function median(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 1 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2;
}
