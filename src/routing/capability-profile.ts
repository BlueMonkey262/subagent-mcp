import { z } from "zod";

import { ConfigurationError } from "../core/errors.js";
import { isBackend, type Backend } from "../core/types.js";

export const COST_TIERS = ["free", "low", "medium", "high"] as const;
export const LATENCY_TIERS = ["fast", "medium", "slow"] as const;
export type CostTier = (typeof COST_TIERS)[number];
export type LatencyTier = (typeof LATENCY_TIERS)[number];

const rating = z.number().min(1).max(5);

/**
 * Operator-declared facts about a model, under `routing.models` in ensembles.yaml, keyed
 * "<backend>/<model>" (e.g. "codex/gpt-5.6-sol", "opencode/opencode-go/deepseek-v4.1-flash").
 * Measured history refines reliability, cost and latency; quality and capabilities come only from here.
 */
export const modelProfileSchema = z.strictObject({
  /** 1-5 overall, or per task category with an optional `default`. */
  quality: z.union([rating, z.record(z.string(), rating)]).optional(),
  cost: z.enum(COST_TIERS).optional(),
  latency: z.enum(LATENCY_TIERS).optional(),
  /** Free-form tags matched by `select.require`, e.g. tools, long_context, vision. */
  capabilities: z.array(z.string()).optional(),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export interface CapabilityProfiles {
  get(backend: Backend, model: string): ModelProfile | undefined;
  readonly size: number;
}

export function profileKey(backend: Backend, model: string): string {
  return `${backend}/${model}`;
}

/** Earlier sources win per key, so project entries shadow user-global ones. */
export function parseCapabilityProfiles(sources: readonly { readonly path: string; readonly models: unknown }[]): CapabilityProfiles {
  const map = new Map<string, ModelProfile>();
  for (const source of sources) {
    if (source.models === undefined) continue;
    if (typeof source.models !== "object" || source.models === null || Array.isArray(source.models)) {
      throw new ConfigurationError(`${source.path}: routing.models must map "<backend>/<model>" to a profile`);
    }
    for (const [key, raw] of Object.entries(source.models)) {
      const slash = key.indexOf("/");
      const backend = key.slice(0, slash);
      if (slash <= 0 || !isBackend(backend) || key.length === slash + 1) {
        throw new ConfigurationError(`${source.path}: routing.models key "${key}" must be "<backend>/<model>"`);
      }
      const parsed = modelProfileSchema.safeParse(raw);
      if (!parsed.success) throw new ConfigurationError(`${source.path}: routing.models.${key}: ${z.prettifyError(parsed.error)}`);
      if (!map.has(key)) map.set(key, parsed.data);
    }
  }
  return { get: (backend, model) => map.get(profileKey(backend, model)), size: map.size };
}

export const EMPTY_PROFILES: CapabilityProfiles = { get: () => undefined, size: 0 };

/** Declared quality (1-5) for a category, falling back to the profile's default; undefined when unknown. */
export function declaredQuality(profile: ModelProfile | undefined, category: string | undefined): number | undefined {
  const quality = profile?.quality;
  if (quality === undefined) return undefined;
  if (typeof quality === "number") return quality;
  return (category === undefined ? undefined : quality[category]) ?? quality["default"];
}
