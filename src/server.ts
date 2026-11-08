#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fileURLToPath } from "node:url";

import { CHANNEL_CAPABILITY, CHANNEL_INSTRUCTIONS, createChannelNotifier } from "./channel.js";
import { BACKENDS, isBackend } from "./core/types.js";
import { connectHost, runHost, type HostClient } from "./host.js";
import { ORCHESTRATOR_AUTHORITY_NOTICE } from "./prompt-policy.js";

async function main(): Promise<void> {
  if (process.env.SUBAGENT_MCP_HOST === "1") {
    await runHost();
    return;
  }
  const cwd = process.cwd();
  const agentsDirectory = process.env.SUBAGENT_MCP_AGENTS_DIR ?? `${cwd}/.subagents`;
  const modelsFile = process.env.SUBAGENT_MCP_MODELS_FILE ?? `${cwd}/.subagents/models.yaml`;

  const server = new McpServer(
    { name: "subagent-mcp", version: "0.1.0" },
    { capabilities: { experimental: { [CHANNEL_CAPABILITY]: {} } }, instructions: CHANNEL_INSTRUCTIONS },
  );
  let client: HostClient | undefined;
  let connectError: Error | undefined;
  try {
    client = await connectHost({
      cwd,
      agentsDirectory,
      modelsFile,
      scriptPath: fileURLToPath(import.meta.url),
    });
    client.onDetached(createChannelNotifier(server.server));
  } catch (error) {
    connectError = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(`subagent-mcp: ${connectError.message}\n`);
  }
  const call = async (method: string, params?: unknown): Promise<unknown> => {
    if (client === undefined) {
      throw connectError ?? new Error(
        "subagent-mcp host is not connected. Ask the user to run `/mcp` and then reconnect subagent-mcp.",
      );
    }
    return client.call(method, params);
  };

  server.registerTool(
    "spawn_agent",
    {
      title: "Spawn subagent",
      description:
        "Delegate implementation, research, or exploration work to a fresh subagent (Claude Code, Codex, " +
        "OpenCode, Antigravity, or Cursor). Mirrors the native Agent tool: the child starts with no parent context, blocks by default " +
        "until it finishes or needs your approval, and returns a resumable agent_id. The result always includes " +
        "a human-memorable `name` (auto-assigned unless supplied) and `timeout_seconds`: the turn cap in seconds, " +
        "or null when neither this call nor the agent config sets one. Refer to agents by name in later tool calls. " +
        "A configured cap (often 1200, twenty minutes) is what stops the turn; pass `timeout` to change it for this " +
        "spawn. When the concurrency cap is full the call waits for a free slot instead of failing. `model` is " +
        "required unless the named agent config pins one; there is no default model at any layer. Implementation " +
        "work that requires search, iteration, or verification should go to a subagent rather than being done inline. " +
        "Results are capped at 4000 characters by default; set `max_result_chars` to override the cap. " +
        ORCHESTRATOR_AUTHORITY_NOTICE,
      inputSchema: {
        agent: z.string().describe("Name of a configured agent in .subagents/<name>.md"),
        prompt: z.string().describe("The delegation prompt; the child sees only this, not the parent's history"),
        description: z.string().describe("Short human-readable label for this delegation"),
        model: z.string().optional().describe("Required unless the agent config pins a model"),
        effort: z.string().optional().describe(
          "Reasoning effort for this agent: \"low\"/\"medium\"/\"high\"/\"xhigh\"/\"max\". Applied to Claude " +
          "(--effort), Codex, and Antigravity (low/medium/high). OpenCode and Cursor reject this argument: " +
          "OpenCode has no effort parameter, and Cursor folds effort into the model id (for example grok-4.7-high). " +
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
    },
    async (input) => toContent(await call("spawn_agent", input)),
  );

  server.registerTool(
    "send_message",
    {
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
          "Reasoning effort for this turn (Codex and Antigravity per-turn; Claude only when the session must cold-start). " +
          "OpenCode and Cursor reject it. Defaults to the value used at spawn.",
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
    },
    async (input) => toContent(await call("send_message", input)),
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "List agents tracked by this host, including ones restored after a reconnect, with their lifecycle state " +
        "and human-memorable name. Refer to agents by name in later tool calls. Also reports timeout_seconds, the " +
        "concurrency cap, how many agents are active, and how many spawns are waiting.",
      inputSchema: {
        states: z.array(z.enum(['starting','running','needs_approval','completed','interrupted','failed','queued','blocked'])).optional(),
        backend: z.enum(BACKENDS).optional(), updated_since: z.iso.datetime().optional(),
        limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
      },
    },
    async input => toContent(await call("list_agents", input)),
  );

  server.registerTool('list_agent_configs', { description: 'Discover callable configs, source files, pinned options and backend capabilities', inputSchema: {} },
    async () => toContent(await call('list_agent_configs')));
  server.registerTool('wait_for_agents', { description: 'Event-driven join; returns on any/all completion, approval, or timeout without stopping agents. Results are capped at 4000 characters by default; set max_result_chars to override. Maximum 60 seconds.',
    inputSchema: { agents: z.array(z.string()).min(1), mode: z.enum(['any','all']).optional(), timeout_seconds: z.number().min(0).max(60).optional(), max_result_chars: z.number().int().positive().optional() } },
    async input => toContent(await call('wait_for_agents', input)));
  server.registerTool('get_agent_result', { description: 'Retrieve persisted results and paginated turn history after reconnect or resume',
    inputSchema: { agent: z.string(), turn: z.number().int().positive().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() } },
    async input => toContent(await call('get_agent_result', input)));
  server.registerTool('cleanup_worktree', { description: 'Remove an inactive, clean managed worktree, retaining its branch for review', inputSchema: { agent: z.string() } },
    async input => toContent(await call('cleanup_worktree', input)));
  server.registerTool('stop_agents', { description: 'Cancel queued tasks and interrupt agents by IDs or group. Supply agents or group_id.',
    inputSchema: { agents: z.array(z.string()).min(1).optional(), group_id: z.string().optional() } },
    async input => toContent(await call('stop_agents', input)));

  server.registerTool(
    "stop_agent",
    {
      title: "Stop agent",
      description:
        "Interrupt a running or approval-parked agent and signal its whole process group, so shells and builds it " +
        "spawned (cargo, check_task) die with it. Idempotent.",
      inputSchema: { agent: z.string().describe("Agent ID or name") },
    },
    async ({ agent }) => toContent(await call("stop_agent", { agent })),
  );

  server.registerTool(
    "resolve_approval",
    {
      title: "Resolve approval",
      description:
        "Decide a parked approval request from spawn_agent/send_message's needs_approval result. Blocks and " +
        "returns the agent's next state (completed, another needs_approval, or running).",
      inputSchema: {
        request_id: z.string(),
        decision: z.enum(["allow", "allow_for_session", "deny"]),
        message: z.string().optional().describe("Shown to the child when denying"),
      },
    },
    async ({ request_id, decision, message }) => toContent(await call("resolve_approval", {
      request_id,
      decision,
      ...(message === undefined ? {} : { message }),
    })),
  );

  server.registerTool(
    "get_agent_events",
    {
      title: "Get agent events",
      description:
        "Buffered normalized event log for an agent, for background polling. Reliable floor for progress. " +
        "The response identifies the agent by both `name` and `agent_id`; prefer the name in conversation. " +
        "The response always includes `currentSequence` (the true latest sequence for this agent, even when " +
        "`events` is empty) so you can seek straight to \"now\" instead of bisecting `since`. Pass `limit` to " +
        "cap how many events come back in one call; `hasMore` says whether more remain past `nextSequence`.",
      inputSchema: {
        agent: z.string(),
        since: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional().describe("Caps events returned in this call"),
        summary: z.boolean().optional().describe(
          "Return a compact digest (state, tool counts, last few tool calls, tail of the latest message) instead of the raw log. Prefer this for progress checks.",
        ),
      },
    },
    async ({ agent, since, limit, summary }) => toContent(await call("get_agent_events", {
      agent,
      ...(summary === undefined ? {} : { summary }),
      ...(since === undefined ? {} : { since }),
      ...(limit === undefined ? {} : { limit }),
    })),
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "Config-sourced model roster plus per-backend usage counters (spawns, resumes, turns, failures, timeouts, " +
        "tokens, and cost) and, when models.yaml sets allowances, how much of each allowance is left. Also reports " +
        "the concurrency cap, the number of active agents, and how many spawns are waiting for a slot.",
      inputSchema: { backend: z.enum(BACKENDS).optional() },
    },
    async ({ backend }) => {
      if (backend !== undefined && !isBackend(backend)) throw new Error(`Invalid backend: ${String(backend)}`);
      return toContent(await call("list_models", backend === undefined ? {} : { backend }));
    },
  );

  server.registerTool(
    "record_outcome",
    {
      title: "Record outcome",
      description: "Record your subjective verdict on a completed delegation, for future routing decisions.",
      inputSchema: {
        agent: z.string(),
        verdict: z.enum(["success", "partial", "failure"]),
        score: z.number().min(0).max(1).optional(),
        notes: z.string().optional(),
      },
    },
    async ({ agent, verdict, score, notes }) => {
      await call("record_outcome", {
        agent,
        verdict,
        ...(score === undefined ? {} : { score }),
        ...(notes === undefined ? {} : { notes }),
      });
      return toContent({ recorded: true });
    },
  );

  server.registerTool(
    "add_note",
    {
      title: "Add routing note",
      description: "Append a free-form delegation note to project or user routing memory.",
      inputSchema: { text: z.string(), scope: z.enum(["project", "user"]).optional() },
    },
    async ({ text, scope }) => {
      await call("add_note", { text, ...(scope === undefined ? {} : { scope }) });
      return toContent({ recorded: true });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The host process owns the agents. Exiting this proxy must not kill them.
  const shutdown = (): void => {
    client?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function toContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

main().catch((error) => {
  process.stderr.write(`subagent-mcp: fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
