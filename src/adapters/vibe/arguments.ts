import type { PermissionConfig } from "../../config/schema.js";
import { SubagentError } from "../../core/errors.js";
import type { SpawnRequest } from "../adapter.js";

export class VibeAdapterError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "VIBE_ADAPTER_ERROR", details);
  }
}

/**
 * Read-only tool set for the restricted profile. These are Vibe's built-in file reader and search
 * tool (the same set Vibe's own read-only `explore` subagent uses, minus `skill`). Everything else,
 * shell and file writes included, is disabled by `--enabled-tools`, which in programmatic mode
 * turns every unlisted tool off.
 */
export const VIBE_READ_ONLY_TOOLS = ["read_file", "grep"] as const;

/** Builtin Vibe agent profile that runs no tool without approval; headless mode denies those. */
export const VIBE_RESTRICTED_AGENT = "ask";

export type VibeProfile = "restricted" | "trusted";

export interface VibeArgumentRequest extends Pick<SpawnRequest, "model" | "cwd" | "permission" | "maxTurns" | "timeoutMs"> {
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
        "permission.default: allow (auto-approve, use a worktree) or escalate/deny (read-only: read_file and grep).",
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
