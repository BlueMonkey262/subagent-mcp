export const BACKENDS = ["claude", "codex", "opencode", "antigravity", "cursor", "copilot"] as const;
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
   * includes them; Claude, OpenCode and Cursor do not. Use `uncachedInputTokens` to compare.
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
}
