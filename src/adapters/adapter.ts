import type { ApprovalResolution } from "../approval/types.js";
import type { PermissionConfig } from "../config/schema.js";
import type { Backend } from "../core/types.js";
import type { AgentEvent } from "../events/schema.js";

export interface SpawnRequest {
  readonly prompt: string;
  readonly description: string;
  /** Always resolved and roster-validated before reaching an adapter. */
  readonly model: string;
  /** From the matching roster entry's `provider`. Only Codex honors this. */
  readonly modelProvider?: string;
  /** Antigravity custom-agent name. Only Antigravity honors this. */
  readonly antigravityAgent?: string;
  readonly cwd: string;
  /** Resolved agent execution config; empty values are explicit, never backend defaults. */
  readonly systemPrompt: string;
  readonly env: Readonly<Record<string, string>>;
  readonly permission: PermissionConfig;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  /**
   * Reasoning effort (e.g. "low"/"medium"/"high"/"xhigh"/"max"). Claude maps it to `--effort` at
   * launch; Codex, Antigravity and Copilot apply it per turn. The registry rejects it for OpenCode and
   * Cursor before an adapter sees it (Cursor folds effort into the model name).
   */
  readonly reasoningEffort?: string;
}

export interface ResumeRequest {
  readonly agentId: string;
  readonly prompt: string;
  readonly cwd: string;
  /** The persisted model is explicit on resume too; adapters must never infer one. */
  readonly model: string;
  /** From the matching roster entry's `provider`. Only Codex honors this. */
  readonly modelProvider?: string;
  /** Antigravity custom-agent name. Only Antigravity honors this. */
  readonly antigravityAgent?: string;
  /** Re-resolved from the named config so a restarted adapter preserves execution policy. */
  readonly systemPrompt: string;
  readonly env: Readonly<Record<string, string>>;
  readonly permission: PermissionConfig;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  /**
   * Reasoning effort (e.g. "low"/"medium"/"high"/"xhigh"/"max"). Claude maps it to `--effort` at
   * launch; Codex, Antigravity and Copilot apply it per turn. The registry rejects it for OpenCode and
   * Cursor before an adapter sees it (Cursor folds effort into the model name).
   */
  readonly reasoningEffort?: string;
}

export interface AdapterTurn {
  readonly agentId: string;
  readonly turnId: string;
  readonly backend: Backend;
}

export interface EventOptions {
  readonly since?: number;
  readonly signal?: AbortSignal;
}

/**
 * Persistent backend boundary. A turn receipt is not completion; terminal state and
 * permission requests arrive through events().
 */
export interface BackendAdapter {
  readonly backend: Backend;
  /**
   * Whether `approve()`'s deny `message` reaches the child inline, as part of the approval
   * response itself. False means the backend's wire protocol has no field for it (Codex,
   * OpenCode today) — the caller must not assume a denied child ever sees `message` unless it
   * also delivers a follow-up turn.
   */
  readonly relaysDenyMessage: boolean;
  spawn(request: SpawnRequest): Promise<AdapterTurn>;
  resume(request: ResumeRequest): Promise<AdapterTurn>;
  interrupt(agentId: string): Promise<void>;
  events(agentId: string, options?: EventOptions): AsyncIterable<AgentEvent>;
  approve(agentId: string, resolution: ApprovalResolution): Promise<void>;
  /**
   * Optional live view of what the backend itself reports: models it can run and plan/quota usage.
   * Only backends with a queryable API implement it (OpenCode today); `list_models` surfaces it.
   */
  providerInfo?(signal?: AbortSignal): Promise<ProviderInfo>;
}

/** A model the backend reports as runnable, as `provider/model` (OpenCode) or the backend's own id. */
export interface ProviderModel {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface ProviderInfo {
  /** Every model the backend reports, when it reports models at all. */
  readonly models?: readonly ProviderModel[];
  readonly [key: string]: unknown;
}

export class AdapterRegistry {
  readonly #adapters = new Map<Backend, BackendAdapter>();

  constructor(adapters: readonly BackendAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: BackendAdapter): void {
    if (this.#adapters.has(adapter.backend)) {
      throw new Error(`Adapter already registered for ${adapter.backend}`);
    }
    this.#adapters.set(adapter.backend, adapter);
  }

  get(backend: Backend): BackendAdapter {
    const adapter = this.#adapters.get(backend);
    if (!adapter) throw new Error(`No adapter registered for ${backend}`);
    return adapter;
  }

  list(): readonly BackendAdapter[] {
    return [...this.#adapters.values()];
  }
}
