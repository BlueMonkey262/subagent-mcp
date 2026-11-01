export const BACKENDS = ["claude", "codex", "opencode", "antigravity", "cursor"] as const;
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
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}
