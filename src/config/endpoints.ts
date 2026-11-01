import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Backend } from "../core/types.js";
import type { ModelEntry, ModelRoster } from "./schema.js";

/** Codex provider that `subagent-mcp endpoint add` registers in ~/.codex/config.toml. */
export const ENDPOINT_CODEX_PROVIDER = "subagent_proxy";

export function endpointsFilePath(): string {
  return (
    process.env["SUBAGENT_MCP_ENDPOINTS_FILE"] ??
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "subagent-mcp", "endpoints.json")
  );
}

/**
 * Adds `<endpoint>/<alias>` models for every configured NIM / OpenAI-compatible endpoint to the
 * claude, codex and opencode rosters. A missing or unreadable endpoints file adds nothing.
 */
export async function withEndpointModels(roster: ModelRoster, path = endpointsFilePath()): Promise<ModelRoster> {
  let endpoints: Record<string, { baseUrl?: string; models?: { alias?: string; id?: string }[] }>;
  try {
    endpoints = (JSON.parse(await readFile(path, "utf8")) as { endpoints?: typeof endpoints }).endpoints ?? {};
  } catch {
    return roster;
  }
  const extra: Record<"claude" | "codex" | "opencode", ModelEntry[]> = { claude: [], codex: [], opencode: [] };
  for (const [name, endpoint] of Object.entries(endpoints)) {
    for (const model of endpoint.models ?? []) {
      if (typeof model.alias !== "string") continue;
      const entry = { name: `${name}/${model.alias}`, description: `${model.id ?? model.alias} via endpoint "${name}"` };
      extra.claude.push(entry);
      extra.codex.push({ ...entry, provider: ENDPOINT_CODEX_PROVIDER });
      extra.opencode.push(entry);
    }
  }
  const merged = { ...roster } as Record<Backend, readonly ModelEntry[]>;
  for (const backend of ["claude", "codex", "opencode"] as const) {
    const have = new Set(roster[backend].map((m) => m.name));
    merged[backend] = [...roster[backend], ...extra[backend].filter((m) => !have.has(m.name))];
  }
  return merged;
}
