import type { Backend } from "./types.js";

/** Stable, backend-neutral failure categories for automated retry and quarantine decisions. */
export const FAILURE_CATEGORIES = [
  "quota",
  "auth",
  "rate_limit",
  "timeout",
  "process",
  "protocol",
  "transport",
  "task",
  "config",
  "capacity",
  "host",
  "internal",
  "cancelled",
  "unknown",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_ACTIONS = ["retry", "resume", "quarantine", "ask_user", "none"] as const;
export type FailureAction = (typeof FAILURE_ACTIONS)[number];

/**
 * A failure as exposed by `spawn_agent`, `send_message`, `list_agents`, and the event log.
 * `code` remains backend-prefixed for diagnostics; `category` is the stable automation key.
 */
export interface FailureInfo {
  readonly code: string;
  readonly message: string;
  readonly category: FailureCategory;
  readonly retryable: boolean;
  readonly recommended_action: FailureAction;
  readonly retry_after_seconds?: number;
  readonly source: "adapter" | "supervisor" | "legacy";
  readonly backend?: Backend;
  readonly turn_id?: string;
  readonly subtype?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ClassifyFailureInput {
  readonly code?: string;
  readonly message?: string;
  readonly backend?: Backend;
  readonly subtype?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly source?: "adapter" | "supervisor" | "legacy";
}

interface Classification {
  readonly category: FailureCategory;
  readonly retryable: boolean;
  readonly recommended_action: FailureAction;
}

const QUOTA = { category: "quota", retryable: false, recommended_action: "quarantine" } as const;
const AUTH = { category: "auth", retryable: false, recommended_action: "quarantine" } as const;
const RATE_LIMIT = { category: "rate_limit", retryable: true, recommended_action: "retry" } as const;
const TIMEOUT = { category: "timeout", retryable: false, recommended_action: "ask_user" } as const;
const PROCESS = { category: "process", retryable: true, recommended_action: "resume" } as const;
const PROTOCOL = { category: "protocol", retryable: true, recommended_action: "resume" } as const;
const TRANSPORT = { category: "transport", retryable: true, recommended_action: "retry" } as const;
const TASK = { category: "task", retryable: false, recommended_action: "none" } as const;
const CONFIG = { category: "config", retryable: false, recommended_action: "ask_user" } as const;
const CAPACITY = { category: "capacity", retryable: true, recommended_action: "retry" } as const;
const HOST = { category: "host", retryable: true, recommended_action: "resume" } as const;
const INTERNAL = { category: "internal", retryable: false, recommended_action: "ask_user" } as const;
const CANCELLED = { category: "cancelled", retryable: false, recommended_action: "none" } as const;
const UNKNOWN = { category: "unknown", retryable: false, recommended_action: "ask_user" } as const;

/** Subtypes the Claude CLI uses for failed results. */
const SUBTYPE_CLASSIFICATIONS: Readonly<Record<string, Classification>> = {
  error_max_budget_usd: QUOTA,
  error_max_turns: TASK,
  error_max_structured_output_retries: TASK,
  error_during_execution: TASK,
  interrupted: CANCELLED,
  cancelled: CANCELLED,
  canceled: CANCELLED,
};

/** Codes produced outside a backend adapter, including supervisor and host state. */
const CODE_CLASSIFICATIONS: ReadonlyArray<readonly [RegExp, Classification]> = [
  [/^AGENT_UNRESPONSIVE$/, PROCESS],
  [/^MISSED_START$/, TIMEOUT],
  [/^HOST_RESTARTED$/, HOST],
  [/^HOST_UNREACHABLE$|^HOST_UPGRADE_|^HOST_.*TIMEOUT$/, HOST],
  [/^TURN_TIMEOUT$|TIMEOUT$/, TIMEOUT],
  [/^TURN_FAILED$/, TASK],
  [/^SUPERVISOR_STREAM_ERROR$/, TRANSPORT],
  [/^STORAGE_ERROR$/, INTERNAL],
  [/^CONFIG_INVALID$|^CONFIGURATION_ERROR$/, CONFIG],
  [/^(?:CLAUDE_MODEL_BLOCKED|MODEL_BLOCKED|BACKEND_DISABLED)$/, CONFIG],
  [/^APPROVAL_ERROR$/, CONFIG],
  [/^CAPACITY_EXCEEDED$/, CAPACITY],
  [/PROCESS_EXIT$|PROCESS_ERROR$/, PROCESS],
  [/PROTOCOL_ERROR$|MALFORMED/, PROTOCOL],
  [/POLL_ERROR$|CONNECTION_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/, TRANSPORT],
];

const MESSAGE_CLASSIFICATIONS: ReadonlyArray<readonly [RegExp, Classification]> = [
  [/rate[\s_-]?limit|too many requests|(?:^|\D)429(?:\D|$)/i, RATE_LIMIT],
  [
    /quota|usage limit|credit balance|insufficient[_ -]?quota|out of credits|billing|budget (?:exceeded|limit)|exceeded your .{0,40}quota/i,
    QUOTA,
  ],
  [
    /authenticat|unauthori[sz]ed|invalid api key|api key|(?:^|\D)40[13](?:\D|$)|not logged in|login required|permission denied.{0,30}(?:key|credential)/i,
    AUTH,
  ],
  [/timed? out|timeout|deadline exceeded/i, TIMEOUT],
  [/process (?:exited|closed|terminated)|exited before|killed by signal/i, PROCESS],
  [/malformed|protocol error|unexpected (?:end|response)|incomplete ndjson|invalid json/i, PROTOCOL],
  [/fetch failed|connection (?:reset|refused|closed)|socket hang up|econnreset|econnrefused|network error/i, TRANSPORT],
];

function classify(input: ClassifyFailureInput): Classification {
  const status = input.httpStatus ?? statusFromDetails(input.details);
  if (status === 429) return RATE_LIMIT;
  if (status === 401 || status === 403) return AUTH;
  if (status !== undefined && status >= 500) return TRANSPORT;

  const subtype = input.subtype?.trim().toLowerCase();
  if (subtype !== undefined) {
    const known = SUBTYPE_CLASSIFICATIONS[subtype];
    if (known !== undefined) return known;
  }

  const code = input.code?.trim() ?? "";
  for (const [pattern, classification] of CODE_CLASSIFICATIONS) {
    if (pattern.test(code)) return classification;
  }

  const message = input.message ?? "";
  for (const [pattern, classification] of MESSAGE_CLASSIFICATIONS) {
    if (pattern.test(message)) return classification;
  }

  return input.code === undefined && input.message === undefined ? UNKNOWN : TASK;
}

function statusFromDetails(details: Readonly<Record<string, unknown>> | undefined): number | undefined {
  if (details === undefined) return undefined;
  for (const key of ["httpStatus", "http_status", "status", "statusCode", "status_code", "api_error_status"] as const) {
    const value = details[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

function retryAfterSeconds(input: ClassifyFailureInput): number | undefined {
  if (input.retryAfterSeconds !== undefined && Number.isFinite(input.retryAfterSeconds) && input.retryAfterSeconds >= 0) {
    return Math.ceil(input.retryAfterSeconds);
  }
  const text = [input.message, typeof input.details?.["retry_after"] === "string" ? input.details["retry_after"] : undefined]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  const match = /retry(?:ing)?\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(text)
    ?? /resets?\s+in\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(text);
  if (match?.[1] === undefined) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds) : undefined;
}

export function classifyFailure(input: ClassifyFailureInput = {}): FailureInfo {
  const classification = classify(input);
  const retryAfter = retryAfterSeconds(input);
  const subtype = input.subtype?.trim();
  return {
    code: input.code?.trim() || fallbackCode(classification),
    message: input.message?.trim() || "The turn failed without a backend error message",
    ...classification,
    ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
    source: input.source ?? "adapter",
    ...(input.backend === undefined ? {} : { backend: input.backend }),
    ...(subtype === undefined || subtype === "" ? {} : { subtype }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

function fallbackCode(classification: Classification): string {
  switch (classification.category) {
    case "quota": return "QUOTA_EXCEEDED";
    case "auth": return "AUTH_FAILED";
    case "rate_limit": return "RATE_LIMITED";
    case "timeout": return "TURN_TIMEOUT";
    case "process": return "PROCESS_EXITED";
    case "protocol": return "PROTOCOL_ERROR";
    case "transport": return "TRANSPORT_ERROR";
    case "task": return "TURN_FAILED";
    case "config": return "CONFIGURATION_ERROR";
    case "capacity": return "CAPACITY_EXCEEDED";
    case "host": return "HOST_ERROR";
    case "internal": return "INTERNAL_ERROR";
    case "cancelled": return "CANCELLED";
    case "unknown": return "UNKNOWN_ERROR";
  }
}

/**
 * Restore a persisted `{code, message}` error, or classify an arbitrary error object.
 * `failed` lets legacy data rewrite a failed turn that was wrongly labelled `*_SUCCESS`.
 */
export function normalizeFailure(value: unknown, options: { readonly failed?: boolean } = {}): FailureInfo | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return classifyFailure({ code: "UNKNOWN_ERROR", message: String(value), source: "legacy" });
  }
  const record = value as Readonly<Record<string, unknown>>;
  const rawCode = typeof record["code"] === "string" ? record["code"] : undefined;
  const message = typeof record["message"] === "string" ? record["message"] : undefined;
  const code = options.failed === true && rawCode !== undefined && /_SUCCESS$/i.test(rawCode)
    ? rawCode.startsWith("CLAUDE_") ? "CLAUDE_RESULT_ERROR" : "TURN_FAILED"
    : rawCode;
  const info = classifyFailure({
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    source: "legacy",
    ...(typeof record["subtype"] === "string" ? { subtype: record["subtype"] } : {}),
    ...(typeof record["backend"] === "string" ? { backend: record["backend"] as Backend } : {}),
    ...(isRecord(record["details"]) ? { details: record["details"] } : {}),
    ...(typeof record["retry_after_seconds"] === "number" ? { retryAfterSeconds: record["retry_after_seconds"] } : {}),
  });
  return {
    ...info,
    ...(typeof record["turn_id"] === "string" ? { turn_id: record["turn_id"] } : {}),
    ...(typeof record["category"] === "string" && isFailureCategory(record["category"]) ? { category: record["category"] } : {}),
    ...(typeof record["retryable"] === "boolean" ? { retryable: record["retryable"] } : {}),
    ...(typeof record["recommended_action"] === "string" && isFailureAction(record["recommended_action"])
      ? { recommended_action: record["recommended_action"] }
      : {}),
  };
}

export function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === "string" && (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

export function isFailureAction(value: unknown): value is FailureAction {
  return typeof value === "string" && (FAILURE_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
