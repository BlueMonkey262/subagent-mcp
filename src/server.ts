#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { fileURLToPath } from "node:url";

import { CHANNEL_CAPABILITY, CHANNEL_INSTRUCTIONS, createChannelNotifier, createEnsembleChannelNotifier } from "./channel.js";
import { HostSession, runHost } from "./host.js";
import { attachSessionAfterInitialize } from "./session.js";
import { ServedCatalog, TOOL_CATALOG, validateToolInput } from "./tool-catalog.js";

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
  const host = new HostSession({ cwd, agentsDirectory, modelsFile, scriptPath: fileURLToPath(import.meta.url) });
  host.onDetached(createChannelNotifier(server.server));
  host.onEnsemble(createEnsembleChannelNotifier(server.server));
  await host.connect();
  const call = async (method: string, params?: unknown, timeoutMs = 0): Promise<unknown> => {
    const result = await host.call(method, params, timeoutMs);
    // A newer host's tools are already listed here, so its "reconnect for updated tools" warning is moot.
    const warning = catalog.servesHost(host.hostBuild()) && host.hostIsNewer() ? undefined : host.warning();
    return warning !== undefined && typeof result === "object" && result !== null && !Array.isArray(result)
      ? { ...result, host_warning: warning }
      : result;
  };

  // Tools come from the catalog the connected host serves, so a newer host's tools are listed without
  // reconnecting; until one answers (or with a host that predates tool_catalog), this build's own.
  const catalog = new ServedCatalog(
    { hostBuild: () => host.hostBuild(), fetch: () => host.call("tool_catalog") },
    () => server.server.sendToolListChanged(),
  );
  host.onAttach(() => void catalog.refresh());
  // After a restart the new host's tools are listed before answering, so its "/mcp" warning is moot.
  const restart = async (force: boolean): Promise<unknown> => {
    const result = await host.restart(force);
    await catalog.refresh();
    if (!(catalog.servesHost(host.hostBuild()) && host.hostIsNewer())) return result;
    const { host_warning: _moot, ...rest } = result;
    return rest;
  };
  void catalog.refresh();

  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    await catalog.refresh();
    return {
      tools: catalog.tools.map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description,
        inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown },
      })),
    };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await catalog.refresh();
    const name = request.params.name;
    const tool = catalog.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) return failure(`Tool ${name} not found`);
    let input: unknown = request.params.arguments ?? {};
    // A host that serves the catalog checks arguments itself; this build checks its own tools, and the
    // tools it answers itself (restart_host), which never reach the host.
    const local = LOCAL_TOOLS.has(name);
    if (!catalog.servesHost(host.hostBuild()) || local) {
      const checked = validateToolInput(name, input);
      if (!checked.ok) return failure(checked.error);
      input = checked.value;
    }
    try {
      const value = local ? await restart(isRecord(input) && input["force"] === true) : await call(name, input, tool.timeoutMs);
      return tool.format === "compact" ? toCompactContent(value) : toContent(value);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  });

  const transport = new StdioServerTransport();
  // Probes and non-Claude clients never attach; the queue is drained after initialize for Claude Code.
  attachSessionAfterInitialize(server.server, host);
  await server.connect(transport);

  // The host process owns the agents. Exiting this proxy must not kill them.
  const shutdown = (): void => {
    host.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Tools this front end answers itself. Decided by this build's catalog, never by a host's: a newer
 * host's `local` flag on a tool this build doesn't implement must not reach the restart path.
 */
const LOCAL_TOOLS = new Set(TOOL_CATALOG.filter((tool) => tool.local === true).map((tool) => tool.name));

/** A tool error as MCP reports it: the call succeeded, the tool did not. */
function failure(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ensemble responses are sized to a character budget, so they are sent without indentation. */
function toCompactContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

main().catch((error) => {
  process.stderr.write(`subagent-mcp: fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
