// Every MCP tool this server offers, in one place: the front end (src/server.ts) lists them and the host
// (src/host.ts) serves them as JSON Schema and validates calls against them. A front end connected to a
// newer host lists the host's catalog, so new tools appear without reconnecting (tools/list_changed).
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";

import { BACKENDS } from "./core/types.js";
import { startEnsembleShape } from "./ensemble/config.js";
import { getEnsembleSchema } from "./ensemble/manager.js";
import { NORMALIZED_EVENT_TYPES } from "./events/schema.js";
import { ORCHESTRATOR_AUTHORITY_NOTICE } from "./prompt-policy.js";

export interface ToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  /** `compact`: the answer is sized to a character budget, so it is sent without indentation. */
  readonly format: "pretty" | "compact";
  /** Answered by the front end itself, not forwarded to the host (restart_host). */
  readonly local?: true;
}

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  {
    name: "spawn_agent",
    title: "Spawn subagent",
    description:
      "Delegate implementation, research, or exploration work to a fresh subagent (Claude Code, Codex, " +
      "OpenCode, Antigravity, Cursor, GitHub Copilot, or Mistral Vibe). Mirrors the native Agent tool: the child starts with no parent context, blocks by default " +
      "until it finishes or needs your approval, and returns a resumable agent_id. The result always includes " +
      "a human-memorable `name` (auto-assigned unless supplied) and `timeout_seconds`: the turn cap in seconds, " +
      "or null when neither this call nor the agent config sets one. Refer to agents by name in later tool calls. " +
      "A configured cap (often 1200, twenty minutes) is what stops the turn; pass `timeout` to change it for this " +
      "spawn. When the concurrency cap is full the call waits for a free slot instead of failing. `model` is " +
      "required unless the named agent config pins one; there is no default model at any layer. Implementation " +
      "work that requires search, iteration, or verification should go to a subagent rather than being done inline. " +
      "Roster entries `list_models` marks `blocked` (see its `model_policy`: disabled backends, blocked model " +
      "patterns, or Claude models) are refused: pick another. If a Claude subagent is really needed while Claude " +
      "models are blocked, ask the user for explicit approval and use your built-in Agent tool instead. " +
      "Results are capped at 4000 characters by default; set `max_result_chars` to override the cap. " +
      ORCHESTRATOR_AUTHORITY_NOTICE,
    inputSchema: {
      agent: z.string().describe("Name of a configured agent in .subagents/<name>.md"),
      prompt: z.string().describe("The delegation prompt; the child sees only this, not the parent's history"),
      description: z.string().describe("Short human-readable label for this delegation"),
      model: z.string().optional().describe("Required unless the agent config pins a model"),
      effort: z.string().optional().describe(
        "Reasoning effort for this agent: \"low\"/\"medium\"/\"high\"/\"xhigh\"/\"max\". Applied to Claude " +
          "(--effort), Codex, Antigravity (low/medium/high), and Copilot (--reasoning-effort). OpenCode, Cursor and Vibe reject this argument: " +
          "OpenCode has no effort parameter, Cursor folds effort into the model id (for example grok-4.7-high), " +
          "and Vibe sets thinking per model alias in its own config. " +
          "Overridable unless the agent config pins it.",
      ),
      backend: z.enum(BACKENDS).optional().describe("Overrides the agent config's backend"),
      name: z.string().optional().describe("Optional explicit name; otherwise a memorable name (mathematician, philosopher, or Greek myth figure) is assigned"),
      run_in_background: z.boolean().optional().describe("Return immediately instead of blocking to completion"),
      isolation: z.enum(['none','worktree']).optional().describe('Managed Git worktree; does not enforce filesystem confinement. Starts from committed HEAD.'),
      group_id: z.string().optional(),
      depends_on: z.array(z.string()).min(1).optional().describe('Existing agent IDs/names; pins their current turns and queues until successful'),
      result_schema: z.record(z.string(), z.unknown()).optional().describe('JSON Schema for locally validated JSON output'),
      permission: z.object({ allow: z.array(z.string()), deny: z.array(z.string()), default: z.enum(['allow','deny','escalate']), mode: z.literal('manual').optional() }).optional().describe('Narrow config permissions; Claude only'),
      max_turns: z.number().int().positive().optional(),
      timeout: z.number().int().positive().optional().describe(
        "Turn cap in seconds. Overrides the agent config for this spawn. Echoed back as timeout_seconds.",
      ),
      max_result_chars: z.number().int().positive().optional().describe("Maximum result characters returned by this call"),
    },
    format: "pretty",
  },
  {
    name: "send_message",
    title: "Resume subagent",
    description:
      "Resume a completed agent by ID or name, preserving its full history. Blocks like spawn_agent. " +
      "Codex resumes replay the whole thread with no prompt cache: the result includes a warning, and a resume " +
      "after a long idle (default 30 minutes, codexResumeIdleSeconds in models.yaml) is refused unless " +
      "allow_expensive_resume is true. `timeout` is the turn cap in seconds and is echoed as timeout_seconds. " +
      "If the agent is still mid-turn, this queues the message (one slot) for delivery the moment the current turn " +
      "ends, rather than failing — call list_agents/get_agent_events if you need to know when it lands. Results " +
      "are capped at 4000 characters by default; set `max_result_chars` to override the cap.",
    inputSchema: {
      agent: z.string().describe("Agent ID or name"),
      prompt: z.string(),
      effort: z.string().optional().describe(
        "Reasoning effort for this turn (Codex, Antigravity and Copilot per-turn; Claude only when the session must cold-start). " +
          "OpenCode, Cursor and Vibe reject it. Defaults to the value used at spawn.",
      ),
      timeout: z.number().int().positive().optional().describe(
        "Turn cap in seconds for this resume. Overrides the agent config. Echoed back as timeout_seconds.",
      ),
      allow_expensive_resume: z.boolean().optional().describe(
        "Resume a Codex agent even though it has been idle past the uncached-replay limit.",
      ),
      run_in_background: z.boolean().optional(),
      max_result_chars: z.number().int().positive().optional().describe("Maximum result characters returned by this call"),
    },
    format: "pretty",
  },
  {
    name: "list_agents",
    title: "List agents",
    description:
      "List agents tracked by this host, including ones restored after a reconnect, with their lifecycle state " +
      "and human-memorable name. Refer to agents by name in later tool calls. Also reports timeout_seconds, the " +
      "concurrency cap, how many agents are active, and how many spawns are waiting. Newest first by creation " +
      "time; order and cursors are stable while agents run, so pages never skip or repeat an agent.",
    inputSchema: {
      states: z.array(z.enum(['starting','running','needs_approval','completed','interrupted','failed','queued','blocked'])).optional(),
      backend: z.enum(BACKENDS).optional(), updated_since: z.iso.datetime().optional(),
      limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
    },
    format: "pretty",
  },
  {
    name: "list_agent_configs",
    description: 'Discover callable configs, source files, pinned options and backend capabilities', inputSchema: {},
    format: "pretty",
  },
  {
    name: "wait_for_agents",
    description: 'Event-driven join; returns on any/all completion, approval, or timeout without stopping agents. Pass since to wait only for agents that settle after that timestamp; newly_settled identifies them. Results are capped at 4000 characters by default; set max_result_chars to override. Maximum 60 seconds.',
    inputSchema: { agents: z.array(z.string()).min(1), mode: z.enum(['any','all']).optional(), timeout_seconds: z.number().min(0).max(60).optional(),
      since: z.iso.datetime().optional().describe('Only agents settled after this timestamp count toward readiness.'),
      max_result_chars: z.number().int().positive().optional() },
    format: "pretty",
  },
  {
    name: "get_agent_result",
    description: 'Retrieve persisted results and paginated turn history after reconnect or resume',
    inputSchema: { agent: z.string(), turn: z.number().int().positive().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
    format: "pretty",
  },
  {
    name: "get_dashboard",
    title: 'Dashboard snapshot',
    description: 'For status UIs such as the /subagent-mcp panel; prefer list_agents and get_ensemble in conversation. ' +
      'One read of live agents and recent finished ones (list_agents records, with phase and last_tool), pending approvals, ' +
      'recent ensembles with member states, and concurrency. Pass the previous `revision` as `since` to get only ' +
      '{ revision, unchanged: true } while nothing has changed.',
    inputSchema: {
      since: z.string().optional().describe('revision from the previous call'),
      recent: z.number().int().min(0).max(50).optional().describe('finished agents to include (default 10); agents that settled in the last 15 minutes are always included'),
      ensembles: z.number().int().min(0).max(20).optional().describe('ensembles to include (default 5; open ones first)'),
    },
    format: "pretty",
  },
  {
    name: "get_agent_diff",
    title: 'Agent worktree diff',
    description: "An isolated agent's changes: everything in its managed worktree, committed or not and untracked files " +
      "included, against the commit it started from (the snapshot for snapshot isolation). Returns per-file line counts " +
      'and a unified diff capped at max_chars (default 20000, cut at a line end; `truncated` says so).',
    inputSchema: { agent: z.string(), max_chars: z.number().int().min(500).max(200000).optional() },
    format: "pretty",
  },
  {
    name: "cleanup_worktree",
    description: 'Remove an inactive, clean managed worktree, retaining its branch for review', inputSchema: { agent: z.string() },
    format: "pretty",
  },
  {
    name: "stop_agents",
    description: 'Cancel queued tasks and interrupt agents by IDs or group. Supply agents or group_id.',
    inputSchema: { agents: z.array(z.string()).min(1).optional(), group_id: z.string().optional() },
    format: "pretty",
  },
  {
    name: "stop_agent",
    title: "Stop agent",
    description:
      "Interrupt a running or approval-parked agent and signal its whole process group, so shells and builds it " +
      "spawned (cargo, check_task) die with it. Idempotent.",
    inputSchema: { agent: z.string().describe("Agent ID or name") },
    format: "pretty",
  },
  {
    name: "resolve_approval",
    title: "Resolve approval",
    description:
      "Decide a parked approval request from spawn_agent/send_message's needs_approval result. Blocks and " +
      "returns the agent's next state (completed, another needs_approval, or running).",
    inputSchema: {
      request_id: z.string(),
      decision: z.enum(["allow", "allow_for_session", "deny"]),
      message: z.string().optional().describe("Shown to the child when denying"),
    },
    format: "pretty",
  },
  {
    name: "get_agent_events",
    title: "Get agent events",
    description:
      "Buffered normalized event log for an agent, for background polling. Reliable floor for progress. " +
      "The response identifies the agent by both `name` and `agent_id`; prefer the name in conversation. " +
      "The response always includes `currentSequence` (the true latest sequence for this agent, even when " +
      "`events` is empty) so you can seek straight to \"now\" instead of bisecting `since`. Pass `limit` to " +
      "cap how many events come back in one call (applied after `types` filtering); `hasMore` says whether " +
      "more remain past `nextSequence`. `types` keeps only the listed event types — raw logs are mostly tiny " +
      "`message.delta` text chunks, so filtering to e.g. `tool.start`/`tool.end` cuts the noise. `coalesce` " +
      "(default false) merges consecutive `message.delta` events into one on read, without changing storage. " +
      "`summary: true` returns a compact digest (state, tool counts, last few tool calls, tail of the latest " +
      "message) instead of the raw log — prefer it for progress checks; pass `since` with it to scope the " +
      "digest to events after a previous `currentSequence`, so repeat calls only report what's new.",
    inputSchema: {
      agent: z.string(),
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional().describe("Caps events returned in this call"),
      types: z.array(z.enum(NORMALIZED_EVENT_TYPES)).optional().describe("Keep only events of these types"),
      coalesce: z.boolean().optional().describe(
        "Merge consecutive message.delta events into one on read (default false; does not change what's stored)",
      ),
      summary: z.boolean().optional().describe(
        "Return a compact digest (state, tool counts, last few tool calls, tail of the latest message) instead of the raw log. Prefer this for progress checks.",
      ),
    },
    format: "pretty",
  },
  {
    name: "list_models",
    title: "List models",
    description:
      "Config-sourced model roster plus per-backend usage counters (spawns, resumes, turns, failures, timeouts, " +
      "tokens, and cost) and, when models.yaml sets allowances, how much of each allowance is left. Also reports " +
      "the concurrency cap, the number of active agents, and how many spawns are waiting for a slot. " +
      "With `live` (on by default when one `backend` is named), adds a `live` section from the backend's own API. " +
      "OpenCode >= 2: every model the server can run (context, max output, USD cost per million tokens), its default " +
      "model, OpenCode Go rolling/weekly/monthly usage and workspace budgets. Codex: the model catalog (reasoning " +
      "efforts, default), the ChatGPT plan's rate-limit windows and credits, and recent account token totals. Usage " +
      "windows report `percent_used`, `remaining_percent` and `resets_at`. `roster_not_offered` lists roster entries " +
      "the backend does not offer; `errors` names any section that failed. Live usage is what the vendor's own " +
      "account tracks, not quotas of external API keys. It may start `opencode serve` or a short-lived `codex app-server`.",
    inputSchema: {
      backend: z.enum(BACKENDS).optional(),
      live: z.boolean().optional().describe("Query live model lists and plan usage (default: true when backend is set)"),
    },
    format: "pretty",
  },
  {
    name: "start_ensemble",
    title: "Start ensemble",
    description:
      "Run several agents (any mix of configs, backends and models) on one task with a single call, and get one " +
      "aggregated result instead of per-agent reports. Each member is an ordinary spawn under the same config, " +
      "model-policy and permission checks; all members are validated before any launches. `task` is shared; a " +
      "member's `instructions` add to it. Modes: parallel; specialist (instructions required); competitive (each " +
      "member in its own worktree); pipeline (each member gets the previous one's successful result; a member's `depends_on` " +
      "replaces that link, and on_dependency_failure: continue passes failures on too). isolation: none | worktree " +
      "(at HEAD) | snapshot (own worktree holding the current working tree, uncommitted changes included; best for " +
      "reviews). A member may give `select` instead of config/model, or `selection.count` adds members: models are " +
      "picked from the roster by category, objective, routing profiles, measured history and quota, never past " +
      "model policy; `dry_run` shows the picks without launching. completion: all | first_valid | quorum | " +
      "deadline. aggregation (deterministic, no model calls): collect | compare | vote (field/choices) | merge " +
      "(conflicts reported, never overwritten) | review_findings (built-in findings schema, de-duplicated and " +
      "ranked with corroboration); aggregation.synthesize opts in to one extra agent's advisory reading. Valid " +
      "means completed and, when a result schema applies, matching it; a vote or consensus is not proof. " +
      "`profile` loads a named roster from .subagents/ensembles.yaml. Background by default: returns at once, " +
      "child notifications are suppressed, and one ensemble event arrives when it finishes (plus one update if " +
      "members still running then add results); member approval requests still arrive individually " +
      "(resolve_approval returns immediately for members). Responses are compact JSON within output.max_chars " +
      "(default 1600).",
    inputSchema: startEnsembleShape,
    format: "compact",
  },
  {
    name: "get_ensemble",
    title: "Get ensemble",
    description:
      "Status or aggregated result of an ensemble by id or name. `wait_seconds` (<= 600) blocks until it finishes " +
      "or a member needs approval. `role` returns one member's full result; `detail: \"members\"` lists member " +
      "states, errors and usage; `aggregation` re-aggregates current results with another strategy (no model " +
      "calls). Without `ensemble`, lists recent ensembles and the configured profiles.",
    inputSchema: getEnsembleSchema.shape,
    format: "compact",
  },
  {
    name: "cancel_ensemble",
    title: "Cancel ensemble",
    description: "Stop an ensemble's running and queued members and finalize it as cancelled with whatever results exist.",
    inputSchema: { ensemble: z.string().describe("Ensemble id or name") },
    format: "compact",
  },
  {
    name: "restart_host",
    title: "Restart host",
    description:
      "Restart this project's subagent-mcp host so it runs the subagent-mcp code currently on disk (after a " +
      "rebuild). Agent records, results and usage are kept. Always refused while any agent is running, waiting " +
      "for a slot, or waiting for approval. Also refused when the host already runs the code on disk, or when " +
      "other Claude Code sessions are connected to it (restarting would disconnect them); ask the user before " +
      "passing `force: true` to override those two. Reconnecting with `/mcp` already reloads an idle host that no " +
      "other session uses; use this when a `host_warning` says the host is on an older build. After a restart this " +
      "connection lists the new host's tools and tells Claude Code the tool list changed.",
    inputSchema: {
      force: z.boolean().optional().describe("Restart even if the code is unchanged or other sessions are connected"),
    },
    format: "pretty", local: true,
  },
];

/** A tool as the host serves it: the input schema as JSON Schema, as MCP lists it. */
export interface JsonToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly format: "pretty" | "compact";
  readonly local?: true;
}

export function catalogJson(catalog: readonly ToolDefinition[] = TOOL_CATALOG): JsonToolDefinition[] {
  return catalog.map((tool) => ({
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    // The conversion McpServer uses, so a listed schema is the same whichever side serves it.
    inputSchema: toJsonSchemaCompat(z.object(tool.inputSchema), { strictUnions: true, pipeStrategy: "input" }) as Record<string, unknown>,
    format: tool.format,
    ...(tool.local === true ? { local: true as const } : {}),
  }));
}

const SCHEMAS = new Map(TOOL_CATALOG.map((tool) => [tool.name, z.object(tool.inputSchema)]));

/**
 * Checks a call's arguments against the catalog: the parsed arguments (unknown keys dropped), or a
 * readable error. Methods the catalog does not name (hello, shutdown) pass through unchanged.
 */
export function validateToolInput(name: string, input: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = SCHEMAS.get(name);
  if (schema === undefined) return { ok: true, value: input };
  const parsed = schema.safeParse(input ?? {});
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` };
}

/**
 * The tool list a front end serves: this build's catalog until the connected host answers
 * tool_catalog, then the host's. Fetched again whenever the host's build changes (a restart, or a
 * reconnect to a newer host); `notify` runs when the list actually changed, so the client re-reads it.
 */
export class ServedCatalog {
  #tools: readonly JsonToolDefinition[] = catalogJson();
  #build: string | undefined;
  #fromHost = false;
  #checked: string | undefined;
  #refreshing: Promise<void> | undefined;

  constructor(
    private readonly source: { hostBuild(): string | undefined; fetch(): Promise<unknown> },
    private readonly notify: () => Promise<void>,
  ) {}

  get tools(): readonly JsonToolDefinition[] { return this.#tools; }

  async #serve(tools: readonly JsonToolDefinition[], build: string, fromHost: boolean): Promise<void> {
    const changed = JSON.stringify(tools) !== JSON.stringify(this.#tools);
    this.#tools = tools;
    this.#build = build;
    this.#fromHost = fromHost;
    if (changed) await this.notify().catch(() => undefined);
  }
  /** The tools came from the host whose build this is (not this front end's own catalog). */
  servesHost(build: string | undefined): boolean { return this.#fromHost && build !== undefined && this.#build === build; }

  refresh(): Promise<void> {
    const build = this.source.hostBuild();
    if (build === undefined || build === this.#checked) return this.#refreshing ?? Promise.resolve();
    this.#checked = build;
    let run: Promise<void> | undefined = undefined;
    run = (async () => {
      try {
        const answer = await this.source.fetch();
        // The host moved on to another build while this fetch ran: that build's refresh decides.
        if (this.#checked !== build) return;
        // A malformed answer is treated like a host without tool_catalog.
        await this.#serve(isToolList(answer) ? answer.tools : catalogJson(), build, isToolList(answer));
      } catch (error) {
        if (this.#checked !== build) return;
        if (/Unknown host method/.test(error instanceof Error ? error.message : String(error))) {
          // A host that predates tool_catalog lists what this front end knows, not a previous host's tools.
          await this.#serve(catalogJson(), build, false);
        } else {
          // A transient failure (a dropped socket): try again on the next call.
          this.#checked = undefined;
        }
      } finally {
        if (this.#refreshing === run) this.#refreshing = undefined;
      }
    })();
    this.#refreshing = run;
    return run;
  }
}

function isToolList(value: unknown): value is { tools: JsonToolDefinition[] } {
  if (typeof value !== "object" || value === null) return false;
  const tools = (value as { tools?: unknown }).tools;
  return Array.isArray(tools) && tools.every((tool) => typeof tool === "object" && tool !== null
    && typeof (tool as { name?: unknown }).name === "string" && typeof (tool as { inputSchema?: unknown }).inputSchema === "object");
}
