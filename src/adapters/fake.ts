import type { ApprovalResolution } from "../approval/types.js";
import type { Backend } from "../core/types.js";
import { EventBuffer } from "../events/buffer.js";
import type { AgentEvent, NewAgentEvent, NormalizedEventData, NormalizedEventType } from "../events/schema.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ResumeRequest, SpawnRequest } from "./adapter.js";

export interface FakeContext {
  readonly agentId: string;
  readonly turnId: string;
  readonly backend: Backend;
}

export interface FakeStep {
  readonly delayMs?: number;
  readonly create: (context: FakeContext) => NewAgentEvent;
}

interface FakeSession {
  turnNumber: number;
  interrupted: boolean;
}

/** Deterministic persistent adapter for coordinator/server tests; it never launches a process. */
export class FakeAdapter implements BackendAdapter {
  readonly #sessions = new Map<string, FakeSession>();
  readonly #scripts: (readonly FakeStep[])[] = [];
  readonly #pendingApprovals = new Map<string, string>();
  readonly approvals: { readonly agentId: string; readonly resolution: ApprovalResolution }[] = [];
  readonly spawnRequests: SpawnRequest[] = [];
  readonly resumeRequests: ResumeRequest[] = [];
  #agentNumber = 0;

  constructor(
    readonly backend: Backend,
    readonly buffer: EventBuffer = new EventBuffer(),
    readonly relaysDenyMessage: boolean = false,
  ) {}

  queueScript(steps: readonly FakeStep[]): void {
    this.#scripts.push(steps);
  }

  /** Pretend a backend session already exists so a restored agent can be resumed. */
  seed(agentId: string): void {
    this.#sessions.set(agentId, { turnNumber: 1, interrupted: false });
  }

  async spawn(request: SpawnRequest): Promise<AdapterTurn> {
    this.spawnRequests.push(request);
    const agentId = `fake-${this.backend}-agent-${++this.#agentNumber}`;
    this.#sessions.set(agentId, { turnNumber: 1, interrupted: false });
    return this.#startTurn(agentId, 1);
  }

  async resume(request: ResumeRequest): Promise<AdapterTurn> {
    this.resumeRequests.push(request);
    const session = this.#sessions.get(request.agentId);
    if (!session) throw new Error(`Unknown fake session ${request.agentId}`);
    session.turnNumber += 1;
    session.interrupted = false;
    return this.#startTurn(request.agentId, session.turnNumber);
  }

  async interrupt(agentId: string): Promise<void> {
    const session = this.#sessions.get(agentId);
    if (!session) throw new Error(`Unknown fake session ${agentId}`);
    session.interrupted = true;
    this.emit(agentId, "turn.completed", {
      turnId: this.#turnId(agentId, session.turnNumber),
      status: "interrupted",
    });
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  async approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    const owner = this.#pendingApprovals.get(resolution.requestId);
    if (owner !== agentId) throw new Error(`No pending fake approval ${resolution.requestId} for ${agentId}`);
    this.#pendingApprovals.delete(resolution.requestId);
    this.approvals.push({ agentId, resolution });
    this.emit(agentId, "tool.end", {
      toolCallId: resolution.requestId,
      status: resolution.decision === "deny" ? "denied" : "completed",
    });
  }

  emit<T extends NormalizedEventType>(agentId: string, type: T, data: NormalizedEventData[T]): AgentEvent<T> {
    if (!this.#sessions.has(agentId)) throw new Error(`Unknown fake session ${agentId}`);
    if (type === "approval.requested") {
      const request = data as NormalizedEventData["approval.requested"];
      this.#pendingApprovals.set(request.requestId, agentId);
    }
    return this.buffer.append({
      type,
      agentId,
      backend: this.backend,
      data,
    } as NewAgentEvent<T>);
  }

  #startTurn(agentId: string, turnNumber: number): AdapterTurn {
    const turnId = this.#turnId(agentId, turnNumber);
    const context: FakeContext = { agentId, turnId, backend: this.backend };
    this.emit(agentId, "thread.started", { threadId: agentId, turnId });
    const script = this.#scripts.shift() ?? [];
    void this.#runScript(context, script);
    return { agentId, turnId, backend: this.backend };
  }

  async #runScript(context: FakeContext, script: readonly FakeStep[]): Promise<void> {
    for (const step of script) {
      if (step.delayMs !== undefined && step.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, step.delayMs));
      } else {
        await Promise.resolve();
      }
      if (this.#sessions.get(context.agentId)?.interrupted) return;
      const event = step.create(context);
      if (event.agentId !== context.agentId || event.backend !== context.backend) {
        throw new Error("Fake script produced an event for a different agent or backend");
      }
      if (event.type === "approval.requested") {
        this.#pendingApprovals.set(event.data.requestId, context.agentId);
      }
      this.buffer.append(event);
    }
  }

  #turnId(agentId: string, turnNumber: number): string {
    return `${agentId}-turn-${turnNumber}`;
  }
}
