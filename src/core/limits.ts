import { CapacityError, ConfigurationError } from "./errors.js";

/** Default cap. Around a dozen live agents exhausts RAM; raise it via config or env. */
export const MAX_CONCURRENT_AGENTS = 12;
/** Bounded default wait for send_message before returning a running receipt. */
export const DEFAULT_SEND_MESSAGE_WAIT_MS = 30_000;
/** A running agent with no backend liveness signal for this long is reported stale. */
export const DEFAULT_STALE_AGENT_MS = 5 * 60 * 1000;
/** Codex resume replays the thread with no prompt cache. Refuse after this idle unless forced. */
export const DEFAULT_CODEX_RESUME_IDLE_MS = 30 * 60 * 1000;
export const MAX_AGENT_DEPTH = 3;
export const AGENT_DEPTH_ENV = "SUBAGENT_MCP_DEPTH";
export const MAX_CONCURRENT_ENV = "SUBAGENT_MCP_MAX_CONCURRENT";
export const CODEX_RESUME_IDLE_ENV = "SUBAGENT_MCP_CODEX_RESUME_IDLE_SECONDS";

export function readAgentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AGENT_DEPTH_ENV];
  if (raw === undefined || raw === "") return 0;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${AGENT_DEPTH_ENV} must be a non-negative integer`, {
      value: raw,
    });
  }
  const depth = Number(raw);
  if (!Number.isSafeInteger(depth)) {
    throw new ConfigurationError(`${AGENT_DEPTH_ENV} is outside the supported range`, {
      value: raw,
    });
  }
  return depth;
}

export function childDepthEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const depth = readAgentDepth(env);
  if (depth >= MAX_AGENT_DEPTH) {
    throw new CapacityError(`Cannot spawn below nesting depth ${MAX_AGENT_DEPTH}`, {
      currentDepth: depth,
      maxDepth: MAX_AGENT_DEPTH,
    });
  }
  return { ...env, [AGENT_DEPTH_ENV]: String(depth + 1) };
}

interface CapacityWaiter {
  readonly agentId: string;
  readonly keys: readonly string[];
  readonly resolve: (release: () => void) => void;
}

export interface CapacityPoolView {
  readonly key: string;
  readonly limit?: number;
  readonly active: number;
  readonly waiting: number;
}

/**
 * Process-local capacity guard with a global cap and optional named pools. `acquire` fails when
 * the cap is full; `acquireWhenFree` waits without blocking unrelated pools. Queue pumping scans
 * for the first waiter whose global and named pools all fit, so one saturated local model cannot
 * head-of-line block a spawn on another model.
 */
export class AgentCapacity {
  readonly #active = new Set<string>();
  readonly #queue: CapacityWaiter[] = [];
  #limit: number;
  readonly #poolLimits = new Map<string, number>();
  readonly #poolActive = new Map<string, Set<string>>();

  constructor(limit = MAX_CONCURRENT_AGENTS, poolLimits: Readonly<Record<string, number>> = {}) {
    this.#limit = requirePositiveInteger(limit, "maxConcurrent");
    this.setPoolLimits(poolLimits);
  }

  get limit(): number {
    return this.#limit;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get waitingCount(): number {
    return this.#queue.length;
  }

  has(agentId: string): boolean {
    return this.#active.has(agentId);
  }

  setLimit(limit: number): void {
    this.#limit = requirePositiveInteger(limit, "maxConcurrent");
    this.#pump();
  }

  setPoolLimits(limits: Readonly<Record<string, number>>): void {
    this.#poolLimits.clear();
    for (const [key, limit] of Object.entries(limits)) {
      if (key.trim() === "") throw new ConfigurationError("capacity pool key must not be empty");
      this.#poolLimits.set(key, requirePositiveInteger(limit, `capacity pool ${key}`));
    }
    this.#pump();
  }

  acquire(agentId: string, keys: readonly string[] = []): () => void {
    if (this.#active.has(agentId)) {
      throw new CapacityError(`Agent ${agentId} is already counted as active`, { agentId });
    }
    if (this.#active.size >= this.#limit || this.#queue.length > 0 || !this.#fits(keys)) {
      const blocked = this.#blockedPools(keys);
      throw new CapacityError(
        blocked.length > 0 ? `Concurrency pool limit reached: ${blocked.join(", ")}` : `Concurrent agent limit of ${this.#limit} reached`,
        {
          limit: this.#limit,
          active: this.#active.size,
          waiting: this.#queue.length,
          ...(blocked.length === 0 ? {} : { blocked_pools: blocked }),
        },
      );
    }
    return this.#hold(agentId, keys);
  }

  /** Resolves when the global slot and every named pool have room. */
  acquireWhenFree(agentId: string, keys: readonly string[] = []): Promise<() => void> {
    if (this.#active.has(agentId)) {
      return Promise.reject(new CapacityError(`Agent ${agentId} is already counted as active`, { agentId }));
    }
    if (this.#active.size < this.#limit && this.#queue.length === 0 && this.#fits(keys)) {
      return Promise.resolve(this.#hold(agentId, keys));
    }
    return new Promise((resolve) => {
      this.#queue.push({ agentId, keys, resolve });
      this.#pump();
    });
  }

  /** Configured and currently-held pools, for `list_agents` / `list_models`. */
  poolViews(): readonly CapacityPoolView[] {
    const keys = new Set([...this.#poolLimits.keys(), ...this.#poolActive.keys()]);
    return [...keys].sort().map((key) => {
      const limit = this.#poolLimits.get(key);
      return {
        key,
        ...(limit === undefined ? {} : { limit }),
        active: this.#poolActive.get(key)?.size ?? 0,
        waiting: this.#queue.filter((waiter) => waiter.keys.includes(key)).length,
      };
    });
  }

  #fits(keys: readonly string[]): boolean {
    if (this.#active.size >= this.#limit) return false;
    for (const key of keys) {
      const limit = this.#poolLimits.get(key);
      if (limit !== undefined && (this.#poolActive.get(key)?.size ?? 0) >= limit) return false;
    }
    return true;
  }

  #blockedPools(keys: readonly string[]): string[] {
    return keys.filter((key) => {
      const limit = this.#poolLimits.get(key);
      return limit !== undefined && (this.#poolActive.get(key)?.size ?? 0) >= limit;
    });
  }

  #hold(agentId: string, keys: readonly string[]): () => void {
    this.#active.add(agentId);
    for (const key of keys) {
      const active = this.#poolActive.get(key) ?? new Set<string>();
      active.add(agentId);
      this.#poolActive.set(key, active);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.delete(agentId);
      for (const key of keys) {
        const active = this.#poolActive.get(key);
        if (active === undefined) continue;
        active.delete(agentId);
        if (active.size === 0) this.#poolActive.delete(key);
      }
      this.#pump();
    };
  }

  #pump(): void {
    let granted = true;
    while (granted) {
      granted = false;
      for (let index = 0; index < this.#queue.length; index += 1) {
        const next = this.#queue[index];
        if (next === undefined || !this.#fits(next.keys)) continue;
        this.#queue.splice(index, 1);
        next.resolve(this.#hold(next.agentId, next.keys));
        granted = true;
        break;
      }
    }
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`, { value });
  }
  return value;
}

/** Positive integer from the environment, or undefined when unset. Invalid values throw. */
export function readPositiveIntEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${name} must be a positive integer`, { value: raw });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`, { value: raw });
  }
  return value;
}
