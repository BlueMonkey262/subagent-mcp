export const BACKENDS = ["claude", "codex", "opencode", "antigravity", "cursor", "copilot", "vibe"] as const;
export type Backend = (typeof BACKENDS)[number];

export function isBackend(value: unknown): value is Backend {
  return typeof value === "string" && BACKENDS.includes(value as Backend);
}

export type AgentLifecycleState =
  | "starting"
  | "running"
  | "needs_approval"
  | "completed"
  | "interrupted"
  | "failed";

export interface Usage {
  /**
   * Input tokens as the backend reports them. Whether this includes cache reads differs: Codex
   * and Vibe include them; Claude, OpenCode and Cursor do not. Use `uncachedInputTokens` to compare.
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Input tokens served from the prompt cache. */
  readonly cachedInputTokens?: number;
  /**
   * Input tokens processed fresh (not cache reads; cache writes count as fresh). Set only by
   * adapters whose `inputTokens` semantics are known, so new and cached input can be told apart.
   */
  readonly uncachedInputTokens?: number;
  readonly costUsd?: number;
  /**
   * How `costUsd` was obtained. "reported" is the provider's own figure; "estimated" is computed
   * locally from configured per-token prices (Vibe), which may be stale and is not a bill —
   * subscription usage in particular is not charged per token. Absent means unknown.
   */
  readonly costBasis?: "reported" | "estimated";
  /**
   * Upstream provider that served the turn, when the backend reports it (Vibe: the alias's
   * `provider` in its config). OpenCode's provider is the model id's prefix instead.
   */
  readonly provider?: string;
}
