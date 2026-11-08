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

export interface EventReadOptions {
  /** Keep only events whose `type` is in this list. Applied before `limit`. */
  readonly types?: readonly NormalizedEventType[];
  /**
   * Merge consecutive `message.delta` events (after the `types` filter) into one, concatenating
   * their text. The merged event keeps the first event's `sequence`; `nextSequence`/pagination use
   * the last merged event's sequence so a follow-up read doesn't re-fetch the merged deltas.
   * Default false: storage is never changed, only what a given `read()` returns.
   */
  readonly coalesce?: boolean;
}

/** One returned (possibly coalesced) event, paired with the true last sequence it covers. */
interface ReadGroup {
  readonly event: AgentEvent;
  readonly lastSequence: number;
}

function coalesceDeltaGroups(events: readonly AgentEvent[]): ReadGroup[] {
  const groups: ReadGroup[] = [];
  for (const event of events) {
    const prev = groups.at(-1);
    if (event.type === "message.delta" && prev !== undefined && prev.event.type === "message.delta") {
      const prevEvent = prev.event as AgentEvent<"message.delta">;
      const merged: AgentEvent<"message.delta"> = {
        ...prevEvent,
        data: { text: prevEvent.data.text + (event as AgentEvent<"message.delta">).data.text },
      };
      groups[groups.length - 1] = { event: merged, lastSequence: event.sequence };
    } else {
      groups.push({ event, lastSequence: event.sequence });
    }
  }
  return groups;
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

  /**
   * `limit`, when given, caps how many events are returned (earliest-first after `since`),
   * applied after `options.types` filtering and `options.coalesce` merging. `nextSequence`
   * always reflects the true last sequence consumed, so a filtered or coalesced follow-up read
   * doesn't loop on events that were filtered out or merged away.
   */
  read(agentId: string, since = 0, limit?: number, options?: EventReadOptions): EventReadResult {
    if (!Number.isSafeInteger(since) || since < 0) throw new RangeError("since must be a non-negative integer");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new RangeError("limit must be a positive integer");
    }
    const retained = this.#events.get(agentId) ?? [];
    const first = retained[0]?.sequence;
    let matching = retained.filter((event) => event.sequence > since);
    if (options?.types !== undefined) {
      const allowed = new Set<string>(options.types);
      matching = matching.filter((event) => allowed.has(event.type));
    }
    const groups = options?.coalesce ? coalesceDeltaGroups(matching) : matching.map((event) => ({ event, lastSequence: event.sequence }));
    const page = limit === undefined ? groups : groups.slice(0, limit);
    const events = page.map((group) => group.event);
    const currentSequence = this.#lastSequence.get(agentId) ?? since;
    const nextSequence = page.at(-1)?.lastSequence ?? since;
    return {
      events,
      nextSequence,
      currentSequence,
      ...(first !== undefined && since + 1 < first ? { truncatedBefore: first } : {}),
      ...(page.length < groups.length ? { hasMore: true } : {}),
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
