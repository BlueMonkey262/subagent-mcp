import type { Backend } from "../core/types.js";

export type ApprovalDecision = "allow" | "allow_for_session" | "deny";

export interface ApprovalRequest {
  readonly requestId: string;
  readonly agentId: string;
  readonly backend: Backend;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly command?: string | undefined;
  readonly paths?: readonly string[];
  readonly diffSummary?: string;
  /** Untrusted child-provided explanation. It must never determine policy by itself. */
  readonly reason?: string;
  readonly requestedAt: string;
}

export interface ApprovalResolution {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly message?: string;
}

export type ApprovalState =
  | { readonly status: "pending"; readonly request: ApprovalRequest; readonly expiresAt: string }
  | { readonly status: "resolving"; readonly request: ApprovalRequest; readonly decision: ApprovalDecision }
  | { readonly status: "resolved"; readonly request: ApprovalRequest; readonly decision: ApprovalDecision; readonly resolvedAt: string }
  | { readonly status: "expired"; readonly request: ApprovalRequest; readonly expiredAt: string }
  | { readonly status: "cancelled"; readonly request: ApprovalRequest; readonly cancelledAt: string };
