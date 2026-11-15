import type { PermissionConfig } from "../../config/schema.js";
import { SubagentError } from "../../core/errors.js";
import type { SpawnRequest } from "../adapter.js";

export class VibeAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "VIBE_ADAPTER_ERROR", details);
  }
}

/**
 * Tool filter for the restricted profile: Vibe's file reader and search tool. Observed live on
 * Vibe 3.1.2, this filter does NOT hide Vibe's core tools (`bash`, `write_file`, `edit`,
 * `run_typescript`, `skill`); neither does `--disabled-tools`. What keeps the profile read-only is
 * the `ask` agent below: headless Vibe denies every call that needs approval (`tool_denied`),
 * including tool calls made from inside `run_typescript`, whose sandbox has no filesystem access
 * of its own. The filter is kept as a second layer for Vibe versions that honor it.
 */
export const VIBE_READ_ONLY_TOOLS = ["read_file", "grep"] as const;

/**
 * Builtin Vibe agent that runs no tool without approval except reads; headless mode denies the rest.
 * This is the enforcement for the restricted profile (see VIBE_READ_ONLY_TOOLS).
 */
export const VIBE_RESTRICTED_AGENT = "ask";

export type VibeProfile = "restricted" | "trusted";

export interface VibeArgumentRequest extends Pick<SpawnRequest, "model" | "cwd" | "permission" | "maxTurns" | "timeoutMs" | "vibeMaxTokens" | "vibeMaxPriceUsd"> {
  readonly outputDir: string;
}

/** Only an explicit `allow` default opts into execution; `escalate` and `deny` run read-only. */
export function vibeProfile(permission: PermissionConfig): VibeProfile {
  return permission.default === "allow" ? "trusted" : "restricted";
}

/**
 * argv for one headless Vibe run (`vibe -p`, one process per turn).
 *
 * - The prompt goes on stdin (`-p` with no text), so it is never visible in the process list and
 *   has no argv size limit. `-p` is last so clap cannot read a following flag as its value.
 * - `--model` only applies to a new session (Vibe rejects it on `--resume`); a resumed session
 *   keeps the model it was created with.
 * - `--workdir` is explicit so an inherited `VIBE_CWD` cannot move the run out of the
 *   supervisor-selected directory. Vibe's own `--worktree` is never used.
 * - `--time-limit` lets Vibe stop the turn itself and still write its export; the adapter keeps a
 *   hard backstop of its own.
 */
export function buildVibeArguments(request: VibeArgumentRequest, resumeId?: string): string[] {
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new VibeAdapterError("Vibe requires an explicit model alias");
  }
  if (typeof request.cwd !== "string" || request.cwd.trim() === "") {
    throw new VibeAdapterError("Vibe requires a cwd");
  }
  if (typeof request.outputDir !== "string" || request.outputDir.trim() === "") {
    throw new VibeAdapterError("Vibe requires an output directory");
  }
  validateVibePermission(request.permission);
  const args = [
    "--output", "streaming",
    "--output-dir", request.outputDir,
    "--workdir", request.cwd,
  ];
  if (resumeId === undefined) args.push("--model", request.model);
  else args.push("--resume", resumeId);
  if (request.maxTurns !== undefined) args.push("--max-turns", String(request.maxTurns));
  if (request.timeoutMs !== undefined) args.push("--time-limit", String(Math.max(1, Math.ceil(request.timeoutMs / 1000))));
  // Both count this run's root session and Vibe's own subagents; hitting one ends the turn as
  // token_limit / price_limit. --max-price is approximate (Vibe's price table may be stale).
  if (request.vibeMaxTokens !== undefined) args.push("--max-tokens", String(request.vibeMaxTokens));
  if (request.vibeMaxPriceUsd !== undefined) args.push("--max-price", String(request.vibeMaxPriceUsd));
  if (vibeProfile(request.permission) === "trusted") {
    // `--trust` loads the project's .vibe/ config and AGENTS.md. That config can run hooks and MCP
    // servers, which is no wider than what an auto-approved agent can already do in this directory.
    args.push("--auto-approve", "--trust");
  } else {
    args.push("--agent", VIBE_RESTRICTED_AGENT);
    for (const tool of VIBE_READ_ONLY_TOOLS) args.push("--enabled-tools", tool);
  }
  args.push("-p");
  return args;
}

/**
 * Vibe's CLI enforces one of two whole profiles, not per-command rules. A config that lists
 * allow/deny rules expects enforcement this backend cannot give, so it is refused rather than
 * silently ignored.
 */
export function validateVibePermission(permission: PermissionConfig): void {
  if (!permission || !Array.isArray(permission.allow) || !Array.isArray(permission.deny)) {
    throw new VibeAdapterError("Vibe requires resolved permission rules");
  }
  if (permission.allow.length > 0 || permission.deny.length > 0) {
    throw new VibeAdapterError(
      "Vibe CLI cannot enforce per-command permission rules. Leave permission.allow and permission.deny empty and choose " +
        "permission.default: allow (auto-approve, use a worktree) or escalate/deny (read-only: the ask agent denies writes and shell).",
      { allow: permission.allow, deny: permission.deny },
    );
  }
}

/**
 * Fold the agent config's instructions into the first prompt. `--system-prompt-file` would replace
 * Vibe's own coding-agent instructions, so the subagent's role goes in the conversation instead,
 * where it stays for every resumed turn.
 */
export function composeVibePrompt(systemPrompt: string, prompt: string): string {
  const instructions = systemPrompt.trim();
  if (instructions === "") return prompt;
  return `<subagent_instructions>\n${instructions}\n</subagent_instructions>\n\n<task>\n${prompt}\n</task>`;
}
