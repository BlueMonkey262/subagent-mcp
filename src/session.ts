import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { isClaudeCodeClient } from "./channel.js";

/** The part of HostSession needed to register as a ping consumer. */
export interface SessionAttacher {
  attachSession(): Promise<unknown>;
}

export type InitializeAwareServer = Pick<Server, "getClientVersion"> & {
  oninitialized?: (() => void) | undefined;
};

/**
 * Register this proxy as a ping consumer only after the MCP initialize handshake completes, and
 * only when the client is Claude Code. Probes and other MCP clients must never drain the queue.
 * HostSession re-attaches on its own after a reconnect/restart.
 */
export function attachSessionAfterInitialize(server: InitializeAwareServer, host: SessionAttacher): void {
  server.oninitialized = () => {
    if (!isClaudeCodeClient(server.getClientVersion()?.name)) return;
    void host.attachSession().catch(() => undefined);
  };
}
