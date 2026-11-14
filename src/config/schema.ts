import type { Backend } from "../core/types.js";
import type { ModelPolicy } from "../core/model-policy.js";

export type PermissionDefault = "allow" | "deny" | "escalate";

/** Values accepted by `claude --permission-mode`. */
export const CLAUDE_PERMISSION_MODES = ["auto", "manual", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** Used when an agent config sets no `permission.mode`. */
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = "auto";

export interface PermissionConfig {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly default: PermissionDefault;
  /** Claude backend only (`--permission-mode`); other backends ignore it. Defaults to auto. */
  readonly mode?: ClaudePermissionMode;
}

export interface AgentConfig {
  readonly worktreeSetup?: readonly string[];
  readonly name: string;
  readonly backend: Backend;
  /** Pinned when present. Omission intentionally forces a model at spawn time. */
  readonly model?: string;
  /**
   * Pinned when present. Claude, Codex, Antigravity, and Copilot honor supported effort levels.
   * OpenCode and Cursor reject it: OpenCode has no effort parameter, and Cursor folds effort
   * into the model id.
   */
  readonly reasoningEffort?: string;
  /** Antigravity-only custom-agent name, passed to `agy --agent`. */
  readonly antigravityAgent?: string;
  /**
   * Vibe only: `cli` (default) runs headless `vibe -p`, which cannot ask for approval; `acp` runs
   * `vibe-acp` and routes each tool permission through the approval flow. Fixed per agent at spawn.
   */
  readonly vibeTransport?: "cli" | "acp";
  /** Vibe only: per-turn cap on prompt + completion tokens (`vibe --max-tokens`). */
  readonly vibeMaxTokens?: number;
  /**
   * Vibe only: per-turn cap in US dollars (`vibe --max-price`). Approximate: Vibe prices calls from
   * its own model price table, which Mistral notes may be missing or stale. Not a billing guarantee.
   */
  readonly vibeMaxPriceUsd?: number;
  readonly description: string;
  readonly systemPrompt: string;
  readonly maxTurns?: number;
  /** Seconds, matching the human-authored frontmatter. */
  readonly timeout?: number;
  readonly permission: PermissionConfig;
  readonly env: Readonly<Record<string, string>>;
  readonly sourcePath: string;
}

export interface ModelEntry {
  /** Exact value accepted by a spawn call and passed to the backend. */
  readonly name: string;
  /** Actual model id behind an endpoint alias; absent for ordinary roster entries. */
  readonly upstreamModel?: string;
  /** Provider/backend version identifier for non-stationary routing records. */
  readonly version?: string;
  readonly description?: string;
  /**
   * Backend-specific model-provider override (Codex's `modelProvider` on `thread/start` /
   * `thread/resume`, resolved against `~/.codex/config.toml`'s `[model_providers.*]`). Other
   * backends ignore it.
   */
  readonly provider?: string;
}

export type ModelRoster = Readonly<Record<Backend, readonly ModelEntry[]>>;

/** Optional spend ceiling for one backend. `list_models` subtracts observed usage from these. */
export interface Allowance {
  readonly maxSpawns?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxCostUsd?: number;
}

/**
 * Per-provider guard for models routed through OpenCode (`provider/model` ids), separate from the
 * global agent cap and from any backend's own plan limits.
 */
export interface ProviderLimit {
  /** Active agents using this provider at once; further spawns and resumes wait for a slot. */
  readonly maxConcurrent?: number;
  /** After a turn fails on a recognized rate limit, new turns for this provider wait this long. */
  readonly cooldownSeconds?: number;
}

export interface ServerLimits {
  readonly maxConcurrent: number;
  readonly codexResumeIdleMs: number;
  readonly allowances: Readonly<Partial<Record<Backend, Allowance>>>;
  /** Which backends and models are refused (see core/model-policy.ts). */
  readonly modelPolicy: ModelPolicy;
  /** Keyed by provider id (the part of an OpenCode model id before the first `/`). */
  readonly providerLimits: Readonly<Record<string, ProviderLimit>>;
}

export interface ResolvedAgentConfig extends Omit<AgentConfig, "model"> {
  readonly model: string;
  /** From the matching roster entry's `provider`. Only Codex honors this. */
  readonly modelProvider?: string;
}
