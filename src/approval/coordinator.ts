import type { BackendAdapter } from "../adapters/adapter.js";
import type { PermissionConfig } from "../config/schema.js";
import { ApprovalError } from "../core/errors.js";
import type { PolicyEvaluation } from "./policy.js";
import { approvalFingerprint, evaluateApprovalPolicy, sessionRuleForRequest } from "./policy.js";
import type { ApprovalDecision, ApprovalRequest, ApprovalResolution, ApprovalState } from "./types.js";

export const APPROVAL_WATCHDOG_MS = 240_000;

interface Clock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

interface PendingEntry {
  state: ApprovalState;
  timer?: unknown;
  /** Absolute watchdog deadline in ms, fixed at park() and never reset by resolve() attempts. */
  deadlineMs?: number;
  /** True once a terminal outcome (resolved/expired/cancelled) is final and irreversible. */
  settled: boolean;
}

export type RoutedApproval =
  | { readonly status: "pending"; readonly state: ApprovalState; readonly evaluation: PolicyEvaluation }
  | { readonly status: "resolved"; readonly state: ApprovalState; readonly evaluation: PolicyEvaluation };

export interface ApprovalCoordinatorOptions {
  readonly adapterFor: (request: ApprovalRequest) => BackendAdapter;
  readonly watchdogMs?: number;
  readonly clock?: Clock;
  readonly onWatchdogError?: (error: unknown, request: ApprovalRequest) => void;
}

/** Backend-neutral, single-transition approval parking with per-agent session memory. */
export class ApprovalCoordinator {
  readonly #entries = new Map<string, PendingEntry>();
  readonly #sessionAllows = new Map<string, Set<string>>();
  readonly #sessionRules = new Map<string, Set<string>>();
  readonly #adapterFor: (request: ApprovalRequest) => BackendAdapter;
  readonly #watchdogMs: number;
  readonly #clock: Clock;
  readonly #onWatchdogError: ((error: unknown, request: ApprovalRequest) => void) | undefined;

  constructor(options: ApprovalCoordinatorOptions) {
    this.#adapterFor = options.adapterFor;
    this.#watchdogMs = options.watchdogMs ?? APPROVAL_WATCHDOG_MS;
    this.#clock = options.clock ?? systemClock;
    this.#onWatchdogError = options.onWatchdogError;
    if (!Number.isSafeInteger(this.#watchdogMs) || this.#watchdogMs <= 0) {
      throw new RangeError("watchdogMs must be a positive integer");
    }
  }

  get(requestId: string): ApprovalState | undefined {
    return this.#entries.get(requestId)?.state;
  }

  sessionFingerprints(agentId: string): ReadonlySet<string> {
    return new Set(this.#sessionAllows.get(agentId));
  }

  sessionRules(agentId: string): ReadonlySet<string> {
    return new Set(this.#sessionRules.get(agentId));
  }

  async route(request: ApprovalRequest, permission: PermissionConfig, enforceDefault = false): Promise<RoutedApproval> {
    const sessionFingerprints = this.#sessionAllows.get(request.agentId);
    const sessionRules = this.#sessionRules.get(request.agentId);
    const evaluation = evaluateApprovalPolicy(request, permission, {
      enforceDefault,
      ...(sessionFingerprints === undefined ? {} : { sessionFingerprints }),
      ...(sessionRules === undefined ? {} : { sessionRules }),
    });
    if (evaluation.decision === "escalate") {
      return { status: "pending", state: this.park(request), evaluation };
    }
    if (this.#entries.has(request.requestId)) {
      throw new ApprovalError(`Approval request ${request.requestId} is already known`, {
        requestId: request.requestId,
      });
    }
    const decision = evaluation.decision;
    // Reserve the entry before awaiting the backend reply so a concurrent duplicate route()
    // call for the same request ID cannot also reach the adapter and reply twice.
    const entry: PendingEntry = {
      state: { status: "resolving", request, decision },
      settled: false,
    };
    this.#entries.set(request.requestId, entry);
    await this.#adapterFor(request).approve(request.agentId, {
      requestId: request.requestId,
      decision,
      ...(decision === "deny" ? { message: evaluation.reason } : {}),
    });
    entry.settled = true;
    const state: ApprovalState = {
      status: "resolved",
      request,
      decision,
      resolvedAt: new Date(this.#clock.now()).toISOString(),
    };
    entry.state = state;
    return { status: "resolved", state, evaluation };
  }

  park(request: ApprovalRequest): ApprovalState {
    if (this.#entries.has(request.requestId)) {
      throw new ApprovalError(`Approval request ${request.requestId} is already known`, {
        requestId: request.requestId,
      });
    }
    const expiresAtMs = this.#clock.now() + this.#watchdogMs;
    const state: ApprovalState = {
      status: "pending",
      request,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const entry: PendingEntry = { state, settled: false, deadlineMs: expiresAtMs };
    // One absolute deadline, armed here and never reset by resolve(): the watchdog stays
    // live through the "resolving" status too, so a hung backend reply cannot park forever.
    entry.timer = this.#clock.setTimeout(() => void this.#expire(request.requestId), this.#watchdogMs);
    this.#entries.set(request.requestId, entry);
    return state;
  }

  async resolve(requestId: string, decision: ApprovalDecision, message?: string): Promise<ApprovalState> {
    const entry = this.#entries.get(requestId);
    if (!entry) throw new ApprovalError(`Unknown approval request ${requestId}`, { requestId });
    if (entry.settled) {
      if (entry.state.status === "resolved" && entry.state.decision === decision) return entry.state;
      throw new ApprovalError(`Approval request ${requestId} is already ${entry.state.status}`, {
        requestId,
        status: entry.state.status,
      });
    }
    if (entry.state.status !== "pending") {
      throw new ApprovalError(`Approval request ${requestId} is already resolving`, { requestId });
    }
    const request = entry.state.request;
    entry.state = { status: "resolving", request, decision };

    const resolution: ApprovalResolution = {
      requestId,
      decision,
      ...(message === undefined ? {} : { message }),
    };
    try {
      await this.#adapterFor(request).approve(request.agentId, resolution);
    } catch (error) {
      // The watchdog may have expired this entry while the reply was in flight; if so its
      // terminal state wins and this failure is stale and must not be reported or retried.
      if (entry.settled) return entry.state;
      entry.state = { status: "pending", request, expiresAt: new Date(entry.deadlineMs ?? this.#clock.now()).toISOString() };
      throw error;
    }

    if (entry.settled) return entry.state; // reconciled by a concurrent watchdog expiry

    if (decision === "allow_for_session") {
      const fingerprints = this.#sessionAllows.get(request.agentId) ?? new Set<string>();
      fingerprints.add(approvalFingerprint(request));
      this.#sessionAllows.set(request.agentId, fingerprints);
      const rule = sessionRuleForRequest(request);
      if (rule !== undefined) {
        const rules = this.#sessionRules.get(request.agentId) ?? new Set<string>();
        rules.add(rule);
        this.#sessionRules.set(request.agentId, rules);
      }
    }
    if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.settled = true;
    const resolved: ApprovalState = {
      status: "resolved",
      request,
      decision,
      resolvedAt: new Date(this.#clock.now()).toISOString(),
    };
    entry.state = resolved;
    return resolved;
  }

  cancel(requestId: string): ApprovalState {
    const pending = this.#requirePending(requestId);
    const entry: PendingEntry = pending;
    if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
    const cancelled: ApprovalState = {
      status: "cancelled",
      request: pending.state.request,
      cancelledAt: new Date(this.#clock.now()).toISOString(),
    };
    entry.state = cancelled;
    entry.timer = undefined;
    entry.settled = true;
    return cancelled;
  }

  clearSession(agentId: string): void {
    this.#sessionAllows.delete(agentId);
    this.#sessionRules.delete(agentId);
  }

  #requirePending(requestId: string): PendingEntry & { state: Extract<ApprovalState, { status: "pending" }> } {
    const entry = this.#entries.get(requestId);
    if (!entry) throw new ApprovalError(`Unknown approval request ${requestId}`, { requestId });
    if (entry.state.status !== "pending") {
      throw new ApprovalError(`Approval request ${requestId} is ${entry.state.status}, not pending`, {
        requestId,
        status: entry.state.status,
      });
    }
    return entry as PendingEntry & { state: Extract<ApprovalState, { status: "pending" }> };
  }

  async #expire(requestId: string): Promise<void> {
    const entry = this.#entries.get(requestId);
    if (!entry || entry.settled) return;
    const request = entry.state.request;
    entry.timer = undefined;
    // Claim the entry immediately so a concurrent resolve() sees settled=true and defers to
    // whatever terminal state this expiry produces, instead of racing a second wire reply.
    entry.settled = true;
    try {
      await this.#adapterFor(request).approve(request.agentId, {
        requestId,
        decision: "deny",
        message: `Approval watchdog expired after ${this.#watchdogMs}ms`,
      });
      entry.state = {
        status: "expired",
        request,
        expiredAt: new Date(this.#clock.now()).toISOString(),
      };
    } catch (error) {
      // The backend never acknowledged the deny (documented Codex/OpenCode failure mode).
      // Publish a distinct terminal state rather than an unacknowledged "expired" so callers
      // know the child may still be unresolved on the backend side.
      entry.state = {
        status: "cancelled",
        request,
        cancelledAt: new Date(this.#clock.now()).toISOString(),
      };
      this.#onWatchdogError?.(error, request);
    }
  }
}
