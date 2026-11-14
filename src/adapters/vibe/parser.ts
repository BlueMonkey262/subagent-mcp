import type { Usage } from "../../core/types.js";
import type { NormalizedEventData } from "../../events/schema.js";

/**
 * Pure parsing of Vibe's headless output, verified against mistral-vibe 3.1.2
 * (docs/programmatic-mode.md, vibe/app_server/models.py, vibe/cli-rust/src/run_export/model.rs).
 *
 * `--output streaming` writes one JSON line per public history entry once that entry's
 * `generationStatus` is `completed`. An entry is frozen once completed, so a tool ("effect") line
 * already carries its final state: there is no separate "started" line, and assistant text arrives
 * as whole messages, not token deltas. Every entry carries the native `sessionId`.
 */

type JsonRecord = Readonly<Record<string, unknown>>;

export type VibeStreamItem =
  | { readonly kind: "message"; readonly sessionId: string; readonly role: string; readonly text: string; readonly discarded: boolean }
  | {
      readonly kind: "tool";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonRecord;
      readonly status: NormalizedEventData["tool.end"]["status"];
      readonly output?: unknown;
    }
  | { readonly kind: "notice"; readonly sessionId: string; readonly level: string; readonly message: string }
  | { readonly kind: "other"; readonly sessionId: string };

export function parseVibeStreamEntry(value: unknown): VibeStreamItem | { readonly kind: "invalid"; readonly reason: string } {
  if (!isRecord(value)) return { kind: "invalid", reason: "entry is not an object" };
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") return { kind: "invalid", reason: "entry lacks sessionId" };
  switch (value.type) {
    case "message": {
      const role = typeof value.role === "string" ? value.role : "unknown";
      const content = Array.isArray(value.content) ? value.content : [];
      const text = content
        .filter((block): block is JsonRecord => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n\n");
      const outcome = isRecord(value.outcome) ? value.outcome : undefined;
      return { kind: "message", sessionId, role, text, discarded: outcome?.type === "discarded" };
    }
    case "effect": {
      const detail = isRecord(value.detail) ? value.detail : {};
      const state = isRecord(value.state) ? value.state : {};
      const toolName = typeof detail.toolName === "string" && detail.toolName !== ""
        ? detail.toolName
        : typeof value.title === "string" && value.title !== "" ? value.title : "tool";
      const id = typeof value.id === "string" && value.id !== "" ? value.id : `${sessionId}-effect`;
      return {
        kind: "tool",
        sessionId,
        toolCallId: id,
        toolName,
        input: isRecord(detail.input) ? detail.input : {},
        status: effectStatus(state),
        ...(state.output === undefined || state.output === null ? {} : { output: state.output }),
      };
    }
    case "notice":
      return {
        kind: "notice",
        sessionId,
        level: typeof value.level === "string" ? value.level : "info",
        message: typeof value.message === "string" ? value.message : "",
      };
    default:
      return { kind: "other", sessionId };
  }
}

function effectStatus(state: JsonRecord): NormalizedEventData["tool.end"]["status"] {
  switch (state.status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "denied";
    case "failed": {
      const error = isRecord(state.error) ? state.error : {};
      return error.code === "tool_denied" ? "denied" : "failed";
    }
    default:
      // Completed entries are frozen in a terminal state; anything else is not a settled call.
      return "failed";
  }
}

/** Every `outcome` value Vibe 3.1.2 writes to export.json. */
export const VIBE_OUTCOMES = [
  "finished", "usage_error", "config_error", "infrastructure_failure", "turn_limit", "token_limit",
  "price_limit", "deadline", "terminated", "length", "refusal", "aborted",
] as const;
export type VibeOutcome = (typeof VIBE_OUTCOMES)[number];

/** One model alias from the export's effective config (`config.models`). */
export interface VibeCatalogModel {
  readonly id: string;
  readonly provider?: string;
  readonly upstream_model?: string;
  readonly name?: string;
  readonly context?: number;
  readonly max_output?: number;
  /** Vibe's configured price per million tokens; the basis of its cost estimate. */
  readonly cost_per_mtok?: { readonly input?: number; readonly output?: number; readonly cache_read?: number };
  readonly thinking?: string;
  readonly thinking_levels?: readonly string[];
  readonly images?: boolean;
  readonly [key: string]: unknown;
}

export interface VibeExport {
  readonly outcome: VibeOutcome | string;
  /** The alias this run used (`config.active_model`); empty on some resumed runs. */
  readonly activeModel?: string;
  /** Every alias Vibe's config offered for this run. */
  readonly catalog?: readonly VibeCatalogModel[];
  readonly sessionId?: string;
  readonly exitCode?: number;
  readonly errorMessage?: string;
  readonly errorCode?: string;
  readonly stopReason?: string;
  readonly usage?: Usage;
  readonly steps?: number;
  readonly vibeVersion?: string;
  readonly warnings: readonly string[];
}

export function parseVibeExport(value: unknown): VibeExport | undefined {
  if (!isRecord(value) || typeof value.outcome !== "string" || value.outcome === "") return undefined;
  const error = isRecord(value.error) ? value.error : undefined;
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.flatMap((warning) => isRecord(warning) && typeof warning.message === "string" ? [warning.message] : [])
    : [];
  const usage = exportUsage(value);
  return {
    outcome: value.outcome,
    ...(typeof value.session_id === "string" && value.session_id !== "" ? { sessionId: value.session_id } : {}),
    ...(typeof value.exit_code === "number" ? { exitCode: value.exit_code } : {}),
    ...(typeof error?.message === "string" ? { errorMessage: error.message } : {}),
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    ...(typeof value.stop_reason === "string" ? { stopReason: value.stop_reason } : {}),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof value.steps === "number" ? { steps: value.steps } : {}),
    ...(typeof value.vibe_version === "string" ? { vibeVersion: value.vibe_version } : {}),
    ...(isRecord(value.config) && typeof value.config.active_model === "string" && value.config.active_model !== ""
      ? { activeModel: value.config.active_model } : {}),
    ...(isRecord(value.config) && isRecord(value.config.models) ? { catalog: parseVibeCatalog(value.config.models) } : {}),
    warnings,
  };
}

export function parseVibeCatalog(models: JsonRecord): VibeCatalogModel[] {
  return Object.entries(models).flatMap(([key, raw]) => {
    if (!isRecord(raw)) return [];
    const alias = typeof raw.alias === "string" && raw.alias !== "" ? raw.alias : key;
    const input = nonNegative(raw.input_price);
    const output = nonNegative(raw.output_price);
    const cacheRead = nonNegative(raw.cached_input_price);
    const levels = Array.isArray(raw.thinking_levels) ? raw.thinking_levels.filter((level): level is string => typeof level === "string") : [];
    return [{
      id: alias,
      ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
      ...(typeof raw.name === "string" ? { upstream_model: raw.name } : {}),
      ...(typeof raw.display_name === "string" ? { name: raw.display_name } : {}),
      ...(typeof raw.max_context_length === "number" ? { context: raw.max_context_length } : {}),
      ...(typeof raw.max_output_tokens === "number" ? { max_output: raw.max_output_tokens } : {}),
      ...(input === undefined && output === undefined ? {} : {
        cost_per_mtok: {
          ...(input === undefined ? {} : { input }),
          ...(output === undefined ? {} : { output }),
          ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
        },
      }),
      ...(typeof raw.thinking === "string" ? { thinking: raw.thinking } : {}),
      ...(levels.length === 0 ? {} : { thinking_levels: levels }),
      ...(typeof raw.supports_images === "boolean" ? { images: raw.supports_images } : {}),
    }];
  });
}

/**
 * export.json usage counts this run only, also on a resumed session, so it never double-counts.
 * `input_tokens` includes cache reads (Mistral reports prompt tokens whole), so the fresh share is
 * the difference. `cost_usd` is computed by Vibe from configured prices: an estimate, not a bill.
 */
function exportUsage(value: JsonRecord): Usage | undefined {
  const raw = isRecord(value.usage) ? value.usage : undefined;
  const input = nonNegative(raw?.input_tokens);
  const output = nonNegative(raw?.output_tokens);
  const cached = nonNegative(raw?.cached_input_tokens);
  const cost = nonNegative(value.cost_usd);
  const usage: Usage = {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(input !== undefined && cached !== undefined && cached <= input ? { uncachedInputTokens: input - cached } : {}),
    ...(cost === undefined ? {} : { costUsd: cost, costBasis: "estimated" as const }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export interface VibeTerminal {
  readonly status: NormalizedEventData["turn.completed"]["status"];
  /** Error event to publish before the terminal event; absent for a clean finish or a requested stop. */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The supervisor outcome for a Vibe export. The export's `outcome`, not the exit code, decides:
 * exit 3 covers both a requested stop and a budget stop.
 */
export function vibeTerminal(exported: VibeExport, flags: { readonly interruptRequested: boolean; readonly timedOut: boolean }): VibeTerminal {
  const detail = exported.errorMessage ? `: ${exported.errorMessage}` : "";
  switch (exported.outcome) {
    case "finished":
      return { status: "completed" };
    case "terminated":
      if (flags.timedOut) return { status: "failed", error: { code: "VIBE_TURN_TIMEOUT", message: "Vibe turn exceeded its time limit" } };
      return { status: "interrupted" };
    case "deadline":
      return { status: "failed", error: { code: "VIBE_TURN_TIMEOUT", message: "Vibe stopped the turn at its --time-limit" } };
    case "turn_limit":
    case "token_limit":
    case "price_limit":
      return { status: "failed", error: { code: "VIBE_LIMIT_REACHED", message: `Vibe stopped at a budget limit (${exported.outcome})` } };
    case "length":
      return { status: "failed", error: { code: "VIBE_LENGTH", message: "Vibe hit a model token limit (context window or output cap)" } };
    case "refusal":
      return { status: "failed", error: { code: "VIBE_REFUSAL", message: "The model declined to answer" } };
    case "usage_error":
    case "config_error":
      return { status: "failed", error: { code: "VIBE_CONFIG_ERROR", message: `Vibe could not start the run (${exported.outcome})${detail}` } };
    case "infrastructure_failure":
      return { status: "failed", error: { code: "VIBE_INFRASTRUCTURE_FAILURE", message: `Vibe infrastructure failure${detail}` } };
    case "aborted":
      // Only an --agent-socket server aborts a run; this adapter never uses one.
      return { status: "failed", error: { code: "VIBE_ABORTED", message: `Vibe run aborted${detail}` } };
    default:
      return { status: "failed", error: { code: "VIBE_UNKNOWN_OUTCOME", message: `Vibe export has unknown outcome "${exported.outcome}"` } };
  }
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
