import type { Usage } from "../../core/types.js";

/**
 * Pure mapping from Vibe's ACP `session/update` payloads to subagent-mcp's normalized shapes.
 * Shapes verified live against vibe-acp 3.1.2 (docs/protocol/vibe-acp.md).
 */

type JsonRecord = Readonly<Record<string, unknown>>;

/**
 * Vibe tool names mapped to the names permission rules use (`Bash(git:*)`, `Write(src/**)`), so
 * an agent config's allow/deny lists and the approval heuristics apply to Vibe as to Claude.
 * Unknown tools keep Vibe's own name, which a rule can still match exactly.
 */
const POLICY_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  write_file: "Write",
  edit: "Edit",
  search_replace: "Edit",
  read_file: "Read",
  grep: "Grep",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};

export function policyToolName(vibeToolName: string): string {
  return POLICY_TOOL_NAMES[vibeToolName] ?? vibeToolName;
}

export interface AcpToolCall {
  readonly toolCallId: string;
  /** The policy-facing name (see POLICY_TOOL_NAMES). */
  readonly toolName: string;
  /** Vibe's own tool name (`_meta.tool_name`), or the update's `kind` when absent. */
  readonly vibeTool: string;
  readonly title?: string;
  readonly input: JsonRecord;
  readonly command?: string;
  readonly paths: readonly string[];
}

/** The tool call a `tool_call` update starts, or undefined when the payload has no id. */
export function toolCallFromUpdate(update: JsonRecord): AcpToolCall | undefined {
  if (typeof update.toolCallId !== "string" || update.toolCallId === "") return undefined;
  const meta = isRecord(update._meta) ? update._meta : {};
  const vibeTool = typeof meta.tool_name === "string" && meta.tool_name !== ""
    ? meta.tool_name
    : typeof update.kind === "string" ? update.kind : "unknown";
  const input = isRecord(update.rawInput) ? update.rawInput : {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const paths = new Set<string>();
  if (Array.isArray(update.locations)) {
    for (const location of update.locations) {
      if (isRecord(location) && typeof location.path === "string" && location.path !== "") paths.add(location.path);
    }
  }
  for (const key of ["filePath", "file_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "" && paths.size === 0) paths.add(value);
  }
  return {
    toolCallId: update.toolCallId,
    toolName: policyToolName(vibeTool),
    vibeTool,
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    input,
    ...(command === undefined ? {} : { command }),
    paths: [...paths],
  };
}

export type ToolEndStatus = "completed" | "failed" | "denied" | "cancelled";

/** Terminal status of a `tool_call_update`, or undefined while the call is still running. */
export function toolEndStatus(update: JsonRecord): ToolEndStatus | undefined {
  const status = update.status;
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status !== "failed") return undefined;
  const raw = isRecord(update.rawOutput) ? update.rawOutput : {};
  const error = isRecord(raw.error) ? raw.error : {};
  return error.code === "tool_denied" ? "denied" : "failed";
}

/** Text of a `tool_call_update`'s `content` blocks, for the tool.end output. */
export function toolOutputText(update: JsonRecord): string | undefined {
  if (!Array.isArray(update.content)) return undefined;
  const texts: string[] = [];
  for (const block of update.content) {
    if (!isRecord(block)) continue;
    const inner = isRecord(block.content) ? block.content : undefined;
    if (inner && typeof inner.text === "string") texts.push(inner.text);
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}

/** Cumulative session counters as Vibe reports them (they include every earlier turn, also after a resume). */
export interface AcpCumulativeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd?: number;
}

/** From a `usage_update` (`_meta.promptTokens` etc., `cost.amount`). */
export function cumulativeFromUsageUpdate(update: JsonRecord): AcpCumulativeUsage | undefined {
  const meta = isRecord(update._meta) ? update._meta : undefined;
  if (meta === undefined || typeof meta.promptTokens !== "number") return undefined;
  const cost = isRecord(update.cost) && update.cost.currency === "USD" && typeof update.cost.amount === "number" ? update.cost.amount : undefined;
  return {
    inputTokens: meta.promptTokens,
    outputTokens: typeof meta.completionTokens === "number" ? meta.completionTokens : 0,
    cachedInputTokens: typeof meta.cachedTokens === "number" ? meta.cachedTokens : 0,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

/** From a `session/prompt` response's `usage` (also cumulative). Cost is only on usage updates. */
export function cumulativeFromPromptUsage(usage: unknown, latestCost?: number): AcpCumulativeUsage | undefined {
  if (!isRecord(usage) || typeof usage.inputTokens !== "number") return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
    cachedInputTokens: typeof usage.cachedReadTokens === "number" ? usage.cachedReadTokens : 0,
    ...(latestCost === undefined ? {} : { costUsd: latestCost }),
  };
}

/**
 * This turn's usage: the cumulative counters minus the baseline taken before the turn began.
 * Without a baseline the turn's share cannot be known, so nothing is reported rather than the
 * whole session's history.
 */
export function turnUsage(current: AcpCumulativeUsage, baseline: AcpCumulativeUsage | undefined, provider?: string): Usage | undefined {
  if (baseline === undefined) return undefined;
  const input = Math.max(0, current.inputTokens - baseline.inputTokens);
  const cached = Math.min(input, Math.max(0, current.cachedInputTokens - baseline.cachedInputTokens));
  // Rounded to a nanodollar: the difference of two float totals is not exact.
  const cost = current.costUsd === undefined ? undefined : Math.max(0, Math.round((current.costUsd - (baseline.costUsd ?? 0)) * 1e9) / 1e9);
  return {
    inputTokens: input,
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    cachedInputTokens: cached,
    // Mistral reports prompt tokens whole, cache reads included (as in the CLI export).
    uncachedInputTokens: input - cached,
    ...(cost === undefined ? {} : { costUsd: cost, costBasis: "estimated" as const }),
    ...(provider === undefined ? {} : { provider }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
