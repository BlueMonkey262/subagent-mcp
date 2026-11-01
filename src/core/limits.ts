import { CapacityError, ConfigurationError } from "./errors.js";

/** Default cap. Around a dozen live agents exhausts RAM; raise it via config or env. */
export const MAX_CONCURRENT_AGENTS = 12;
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
  readonly resolve: (release: () => void) => void;
}

/**
 * Process-local capacity guard. `acquire` fails when the cap is full.
 * `acquireWhenFree` waits in FIFO order so a spawn queues instead of failing.
 */
export class AgentCapacity {
  readonly #active = new Set<string>();
  readonly #queue: CapacityWaiter[] = [];
  #limit: number;

  constructor(limit = MAX_CONCURRENT_AGENTS) {
    this.#limit = requirePositiveInteger(limit, "maxConcurrent");
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

  acquire(agentId: string): () => void {
    if (this.#active.has(agentId)) {
      throw new CapacityError(`Agent ${agentId} is already counted as active`, { agentId });
    }
    if (this.#active.size >= this.#limit || this.#queue.length > 0) {
      throw new CapacityError(`Concurrent agent limit of ${this.#limit} reached`, {
        limit: this.#limit,
        active: this.#active.size,
        waiting: this.#queue.length,
      });
    }
    return this.#hold(agentId);
  }

  /** Resolves when a slot is free. Callers wait instead of receiving a capacity error. */
  acquireWhenFree(agentId: string): Promise<() => void> {
    if (this.#active.has(agentId)) {
      return Promise.reject(new CapacityError(`Agent ${agentId} is already counted as active`, { agentId }));
    }
    if (this.#active.size < this.#limit && this.#queue.length === 0) {
      return Promise.resolve(this.#hold(agentId));
    }
    return new Promise((resolve) => {
      this.#queue.push({ agentId, resolve });
    });
  }

  #hold(agentId: string): () => void {
    this.#active.add(agentId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.delete(agentId);
      this.#pump();
    };
  }

  #pump(): void {
    while (this.#queue.length > 0 && this.#active.size < this.#limit) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      next.resolve(this.#hold(next.agentId));
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
