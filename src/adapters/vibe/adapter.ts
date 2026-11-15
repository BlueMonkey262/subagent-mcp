import type { ApprovalResolution } from "../../approval/types.js";
import { EventBuffer } from "../../events/buffer.js";
import type { AgentEvent } from "../../events/schema.js";
import type { AdapterTurn, BackendAdapter, EventOptions, ProviderInfo, ResumeRequest, SpawnRequest } from "../adapter.js";
import { isAcpAgentId, VibeAcpAdapter, type VibeAcpAdapterOptions } from "./acp-adapter.js";
import { VibeCliAdapter, type VibeCliAdapterOptions } from "./cli-adapter.js";

export interface VibeAdapterOptions extends VibeCliAdapterOptions {
  /** Options for the ACP transport (`vibeTransport: acp`). */
  readonly acp?: Omit<VibeAcpAdapterOptions, "buffer" | "providerFor">;
}

/**
 * The `vibe` backend: one facade over two transports that share an event buffer and the model
 * catalog. A spawn picks its transport from the agent config (`vibeTransport`, default `cli`);
 * after that the agent id decides (`acp:` prefix), so a resumed agent keeps its transport even
 * if the config changed. The CLI transport is headless `vibe -p` (no approvals); ACP bridges
 * Vibe's permission requests into the approval flow.
 */
export class VibeAdapter implements BackendAdapter {
  readonly backend = "vibe" as const;
  /** Neither transport delivers a deny `message` to the model. */
  readonly relaysDenyMessage = false;
  readonly buffer: EventBuffer;
  readonly cli: VibeCliAdapter;
  readonly acp: VibeAcpAdapter;

  constructor(options: VibeAdapterOptions = {}) {
    this.buffer = options.buffer ?? new EventBuffer();
    const { acp, ...cli } = options;
    this.cli = new VibeCliAdapter({ ...cli, buffer: this.buffer });
    this.acp = new VibeAcpAdapter({ ...acp, buffer: this.buffer, providerFor: (model) => this.cli.providerFor(model) });
  }

  spawn(request: SpawnRequest): Promise<AdapterTurn> {
    return request.vibeTransport === "acp" ? this.acp.spawn(request) : this.cli.spawn(request);
  }

  resume(request: ResumeRequest): Promise<AdapterTurn> {
    return this.#for(request.agentId).resume(request);
  }

  interrupt(agentId: string): Promise<void> {
    return this.#for(agentId).interrupt(agentId);
  }

  events(agentId: string, options: EventOptions = {}): AsyncIterable<AgentEvent> {
    return this.buffer.subscribe(agentId, options.since ?? 0, options.signal);
  }

  approve(agentId: string, resolution: ApprovalResolution): Promise<void> {
    return this.#for(agentId).approve(agentId, resolution);
  }

  providerInfo(): Promise<ProviderInfo> {
    return this.cli.providerInfo();
  }

  async closeAll(): Promise<void> {
    await Promise.all([this.cli.closeAll(), this.acp.closeAll()]);
  }

  #for(agentId: string): VibeCliAdapter | VibeAcpAdapter {
    return isAcpAgentId(agentId) ? this.acp : this.cli;
  }
}
