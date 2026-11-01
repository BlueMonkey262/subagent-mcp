import type { AgentEvent, NewAgentEvent, NormalizedEventType } from "./schema.js";

interface Waiter {
  readonly after: number;
  readonly resolve: () => void;
}

export interface EventReadResult {
  readonly events: readonly AgentEvent[];
  readonly nextSequence: number;
  readonly truncatedBefore?: number;
  /**
   * The true current sequence for this agent — the sequence of the last event ever appended,
   * independent of retention eviction and of any `limit` truncation on this call. Returned
   * unconditionally, including when `events` is empty, so a caller with a stale or out-of-range
   * `since` can seek straight to "now" instead of bisecting to find it.
   */
  readonly currentSequence: number;
  /** True when `limit` capped this result and more matching events remain past `nextSequence`. */
  readonly hasMore?: boolean;
}

/** In-memory reliable floor for background progress. Sequences are global and monotonic. */
export class EventBuffer {
  readonly #events = new Map<string, AgentEvent[]>();
  readonly #waiters = new Map<string, Set<Waiter>>();
  /** Last-appended sequence per agent, kept even after older events are evicted or cleared. */
  readonly #lastSequence = new Map<string, number>();
  #nextSequence = 1;

  constructor(readonly maxEventsPerAgent = 10_000) {
    if (!Number.isSafeInteger(maxEventsPerAgent) || maxEventsPerAgent < 1) {
      throw new RangeError("maxEventsPerAgent must be a positive integer");
    }
  }

  append<T extends NormalizedEventType>(event: NewAgentEvent<T>): AgentEvent<T> {
    const stored = {
      ...event,
      sequence: this.#nextSequence++,
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as AgentEvent<T>;
    const events = this.#events.get(event.agentId) ?? [];
    events.push(stored as AgentEvent);
    if (events.length > this.maxEventsPerAgent) events.splice(0, events.length - this.maxEventsPerAgent);
    this.#events.set(event.agentId, events);
    this.#lastSequence.set(event.agentId, stored.sequence);
    this.#wake(event.agentId, stored.sequence);
    return stored;
  }

  /** `limit`, when given, caps how many events are returned (earliest-first after `since`). */
  read(agentId: string, since = 0, limit?: number): EventReadResult {
    if (!Number.isSafeInteger(since) || since < 0) throw new RangeError("since must be a non-negative integer");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new RangeError("limit must be a positive integer");
    }
    const retained = this.#events.get(agentId) ?? [];
    const first = retained[0]?.sequence;
    const matching = retained.filter((event) => event.sequence > since);
    const events = limit === undefined ? matching : matching.slice(0, limit);
    const currentSequence = this.#lastSequence.get(agentId) ?? since;
    const nextSequence = events.at(-1)?.sequence ?? since;
    return {
      events,
      nextSequence,
      currentSequence,
      ...(first !== undefined && since + 1 < first ? { truncatedBefore: first } : {}),
      ...(events.length < matching.length ? { hasMore: true } : {}),
    };
  }

  async *subscribe(agentId: string, since = 0, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    let cursor = since;
    while (!signal?.aborted) {
      const batch = this.read(agentId, cursor).events;
      if (batch.length > 0) {
        for (const event of batch) {
          cursor = event.sequence;
          yield event;
        }
        continue;
      }
      await this.#wait(agentId, cursor, signal);
    }
  }

  clear(agentId: string): void {
    this.#events.delete(agentId);
    this.#lastSequence.delete(agentId);
    this.#wake(agentId, Number.MAX_SAFE_INTEGER);
  }

  #wake(agentId: string, sequence: number): void {
    const waiters = this.#waiters.get(agentId);
    if (!waiters) return;
    for (const waiter of waiters) {
      if (sequence > waiter.after) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
    if (waiters.size === 0) this.#waiters.delete(agentId);
  }

  #wait(agentId: string, after: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(agentId) ?? new Set<Waiter>();
      const waiter: Waiter = { after, resolve };
      waiters.add(waiter);
      this.#waiters.set(agentId, waiters);
      signal?.addEventListener(
        "abort",
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.#waiters.delete(agentId);
          resolve();
        },
        { once: true },
      );
    });
  }
}
