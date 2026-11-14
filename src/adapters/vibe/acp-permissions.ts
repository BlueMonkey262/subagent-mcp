import type { ApprovalDecision } from "../../approval/types.js";

/**
 * Maps a subagent-mcp approval decision onto one of the options a `session/request_permission`
 * offered. Selection goes by option id, not only by `kind`: Vibe marks both "Allow for this
 * session" and "Always allow" (which it persists to the user's Vibe config) as `allow_always`.
 * Anything persistent is never chosen. When no offered option represents the decision safely,
 * selection fails closed: `undefined` for an allow, a cancelled outcome for a deny.
 */

export interface PermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: string;
}

export type PermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

const PERSISTENT = /permanent|always_allow|remember/i;

export function parsePermissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (typeof option !== "object" || option === null) return [];
    const record = option as Record<string, unknown>;
    if (typeof record.optionId !== "string" || record.optionId === "") return [];
    return [{
      optionId: record.optionId,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    }];
  });
}

/** The option for `decision`, or undefined when none is safe (the caller must not guess). */
export function selectPermissionOption(decision: ApprovalDecision, options: readonly PermissionOption[]): PermissionOutcome | undefined {
  const byId = (id: string) => options.find((option) => option.optionId === id);
  const pick = (option: PermissionOption | undefined): PermissionOutcome | undefined =>
    option === undefined ? undefined : { outcome: "selected", optionId: option.optionId };
  switch (decision) {
    case "allow":
      return pick(byId("allow_once") ?? options.find((option) => option.kind === "allow_once" && !PERSISTENT.test(option.optionId)));
    case "allow_for_session":
      // An exact or whole-session grant only. A directory-recursive grant would let Vibe auto-run
      // paths the parent never saw, so it fails closed; never a permanent one.
      return pick(byId("allow_session_exact") ?? byId("allow_always"));
    case "deny":
      // ACP treats a cancelled outcome as "not allowed", so a deny never depends on the offer.
      return pick(byId("reject_once") ?? options.find((option) => option.kind === "reject_once")) ?? { outcome: "cancelled" };
  }
}

/** Tools that change files, run commands, reach the network or start subagents: always asked about. */
const ALWAYS_ASK = ["bash", "git_bash", "powershell", "write_file", "edit", "search_replace", "web_fetch", "web_search", "task"] as const;

/** Vibe tools behind each policy name (the inverse of acp-events' POLICY_TOOL_NAMES). */
const VIBE_TOOLS_BY_POLICY_NAME: Readonly<Record<string, readonly string[]>> = {
  Bash: ["bash", "git_bash", "powershell"],
  Write: ["write_file"],
  Edit: ["edit", "search_replace"],
  Read: ["read_file"],
  Grep: ["grep"],
  WebFetch: ["web_fetch"],
  WebSearch: ["web_search"],
};

/**
 * Environment overrides (`VIBE_TOOLS__<TOOL>__...`, applied to this vibe-acp process only) that
 * make Vibe ask before every call the agent's rules must see. Vibe auto-runs shell commands on its
 * own prefix allowlist and never asks for reads; the allowlists are always emptied so each shell
 * command reaches subagent-mcp's policy, and a tool named by a deny rule is switched to `ask`
 * so the rule can be enforced. Verified live on Vibe 3.1.2.
 */
export function vibeAcpToolEnv(deny: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {
    VIBE_TOOLS__BASH__ALLOWLIST: "[]",
    VIBE_TOOLS__GIT_BASH__ALLOWLIST: "[]",
    VIBE_TOOLS__POWERSHELL__ALLOWLIST: "[]",
  };
  const ask = (tool: string) => { env[`VIBE_TOOLS__${tool.toUpperCase()}__PERMISSION`] = "ask"; };
  // Vibe asks for these by default, but a user's config can set them to run unasked; pin them.
  for (const tool of ALWAYS_ASK) ask(tool);
  for (const rule of deny) {
    const toolPattern = /^([^()]+?)(?:\(.*\))?$/.exec(rule.trim())?.[1]?.trim();
    if (toolPattern === undefined || toolPattern === "") continue;
    const matcher = new RegExp(`^${toolPattern.split("*").map(escapeRegExp).join(".*")}$`);
    const known = Object.entries(VIBE_TOOLS_BY_POLICY_NAME).filter(([name]) => matcher.test(name));
    if (known.length > 0) for (const [, tools] of known) tools.forEach(ask);
    else if (/^[A-Za-z0-9_]+$/.test(toolPattern)) ask(toolPattern);
  }
  return env;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Decisions this request can take, for the approval request shown to the orchestrator. */
export function supportedDecisions(options: readonly PermissionOption[]): ApprovalDecision[] {
  return (["allow", "allow_for_session", "deny"] as const).filter((decision) => {
    const outcome = selectPermissionOption(decision, options);
    return outcome !== undefined && (decision === "deny" || outcome.outcome === "selected");
  });
}
