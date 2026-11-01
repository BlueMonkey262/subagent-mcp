import type { ApprovalRequest } from "../approval/types.js";
import type { Backend, Usage } from "../core/types.js";

export type NormalizedEventData = {
  "thread.started": { readonly threadId: string; readonly turnId?: string };
  "message.delta": { readonly text: string };
  "tool.start": {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: Readonly<Record<string, unknown>>;
  };
  "tool.end": {
    readonly toolCallId: string;
    readonly toolName?: string;
    readonly status: "completed" | "failed" | "denied" | "cancelled";
    readonly output?: unknown;
  };
  "approval.requested": ApprovalRequest;
  "turn.completed": {
    readonly turnId: string;
    readonly status: "completed" | "interrupted" | "failed";
    readonly finalText?: string;
    readonly usage?: Usage;
  };
  error: {
    readonly code: string;
    readonly message: string;
    readonly fatal: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  };
};

export type NormalizedEventType = keyof NormalizedEventData;

export type NewAgentEvent<T extends NormalizedEventType = NormalizedEventType> = {
  readonly [K in T]: {
    readonly type: K;
    readonly agentId: string;
    readonly backend: Backend;
    readonly timestamp?: string;
    readonly data: NormalizedEventData[K];
  };
}[T];

export type AgentEvent<T extends NormalizedEventType = NormalizedEventType> = {
  readonly [K in T]: Omit<NewAgentEvent<K>, "timestamp"> & {
    readonly sequence: number;
    readonly timestamp: string;
  };
}[T];
