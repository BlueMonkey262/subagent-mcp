import { createHash } from "node:crypto";

import type { EnsembleManager } from "./ensemble/manager.js";
import type { Supervisor } from "./supervisor.js";

export interface DashboardInput {
  /** The revision from a previous call; when nothing changed the answer is just `{ revision, unchanged: true }`. */
  readonly since?: string | undefined;
  /** Finished agents to include after the live ones (default 10), besides any that settled in the last 15 minutes. */
  readonly recent?: number | undefined;
  /** Ensembles to include: every open one, then the newest finished, up to this many (default 5). */
  readonly ensembles?: number | undefined;
}

// "blocked" is a queued task whose dependency failed: settled, like "interrupted".
const LIVE = new Set(["starting", "running", "needs_approval", "queued"]);
/** A just-settled agent stays listed this long whatever `recent` is, so a poller sees it settle. */
const RECENTLY_SETTLED_MS = 15 * 60_000;

/**
 * One read for a status UI: live agents and the most recent finished ones (list_agents records),
 * pending approvals, recent ensembles with their members, and the concurrency counters. The
 * revision is a hash of everything but the timestamp, so a poller passing `since` gets a few bytes
 * back while nothing moves.
 */
export function buildDashboard(supervisor: Supervisor, ensembles: EnsembleManager | undefined, input: DashboardInput = {}): Readonly<Record<string, unknown>> {
  const recent = Math.min(50, Math.max(0, input.recent ?? 10));
  const all = supervisor.listAgents();
  const live = all.filter((agent) => LIVE.has(String(agent.state)));
  const cutoff = Date.now() - RECENTLY_SETTLED_MS;
  const finished = all.filter((agent) => !LIVE.has(String(agent.state)))
    .filter((agent, index) => index < recent || Date.parse(String(agent.updated_at)) >= cutoff);
  const agents = [...live, ...finished];
  const approvals = live
    .filter((agent) => agent.state === "needs_approval" && agent.request_id !== undefined)
    .map((agent) => ({
      request_id: agent.request_id, agent_id: agent.agent_id, name: agent.name, tool_name: agent.tool_name,
      command: agent.command, reason: agent.reason, expires_at: agent.expires_at,
      ...(agent.ensemble_id === undefined ? {} : { ensemble_id: agent.ensemble_id }),
    }));
  const body = {
    agents,
    approvals,
    ensembles: ensembles?.overview(Math.min(20, Math.max(0, input.ensembles ?? 5))) ?? [],
    concurrency: supervisor.concurrency(),
  };
  const revision = createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 16);
  if (input.since !== undefined && input.since === revision) return { revision, unchanged: true };
  return { revision, at: new Date().toISOString(), ...body };
}
