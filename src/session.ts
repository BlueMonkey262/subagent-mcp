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
 * HostSession retries the attach with bounded backoff, re-attaches on its own after a reconnect/
 * restart, and retries again after the next successful call if the host reports no attached session.
 */
export function attachSessionAfterInitialize(server: InitializeAwareServer, host: SessionAttacher): void {
  server.oninitialized = () => {
    if (!isClaudeCodeClient(server.getClientVersion()?.name)) return;
    // HostSession owns the retry/backoff, so a failure here is already logged at most once.
    void host.attachSession().catch(() => undefined);
  };
}
