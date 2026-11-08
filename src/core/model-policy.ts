import { BACKENDS, isBackend, type Backend } from "./types.js";
import { ConfigurationError, SubagentError } from "./errors.js";

/** Environment overrides. The Claude switch replaces the file's value; the two lists add to the file's lists. */
export const BLOCK_CLAUDE_MODELS_ENV = "SUBAGENT_MCP_BLOCK_CLAUDE_MODELS";
export const DISABLED_BACKENDS_ENV = "SUBAGENT_MCP_DISABLED_BACKENDS";
export const BLOCK_MODELS_ENV = "SUBAGENT_MCP_BLOCK_MODELS";

/** Which agents subagent-mcp refuses to start or resume. */
export interface ModelPolicy {
  /** Refuse Anthropic Claude models on every backend (see `isClaudeModel`). */
  readonly blockClaudeModels: boolean;
  /** Backends that refuse every model. */
  readonly disabledBackends: readonly Backend[];
  /** Case-insensitive globs over model ids (`*`, `?`); a `backend:` prefix limits one to that backend. */
  readonly blockModels: readonly string[];
}

export const OPEN_POLICY: ModelPolicy = { blockClaudeModels: false, disabledBackends: [], blockModels: [] };

export type BlockReason =
  | { readonly kind: "backend" }
  | { readonly kind: "claude" }
  | { readonly kind: "pattern"; readonly pattern: string };

/**
 * Whether `model` on `backend` runs an Anthropic Claude model, on every backend:
 * - an `anthropic` provider segment (`anthropic/...`, `openrouter/anthropic/...`, `bedrock/anthropic.x`);
 * - "claude" in the model name, i.e. after the first `/` when there is one (Cursor `claude-opus-5-5-high`,
 *   OpenCode `opencode/claude-sonnet-5-5`). The part before the first `/` is a provider or endpoint
 *   name, so an endpoint called `claude-proxy` serving another vendor's model is not caught;
 * - any bare id on the Claude CLI (`sonnet`, `opus`), which sends it to Anthropic. Its
 *   `<endpoint>/<alias>` models go elsewhere through the local proxy, so those stay allowed.
 */
export function isClaudeModel(backend: Backend, model: string): boolean {
  const id = model.trim().toLowerCase();
  if (id.split(/[/:.]/).includes("anthropic")) return true;
  const slash = id.indexOf("/");
  if ((slash < 0 ? id : id.slice(slash + 1)).includes("claude")) return true;
  return backend === "claude" && slash < 0;
}

interface CompiledPattern {
  readonly backend?: Backend;
  readonly regex: RegExp;
}

/**
 * `codex:gpt-5*` applies only to Codex; anything else applies to every backend. The prefix must
 * name a backend, so model ids that contain a colon (`ollama-cloud/gpt-oss:20b`) stay plain patterns.
 */
function compilePattern(raw: string): CompiledPattern {
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon).trim().toLowerCase() : "";
  const scoped = isBackend(prefix);
  const glob = (scoped ? raw.slice(colon + 1) : raw).trim();
  const source = glob.split("").map((char) =>
    char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\/]/g, "\\$&")).join("");
  return { ...(scoped ? { backend: prefix } : {}), regex: new RegExp(`^${source}$`, "i") };
}

/** Why `policy` refuses `model` on `backend`, or undefined when it may run. */
export function blockReason(policy: ModelPolicy, backend: Backend, model: string): BlockReason | undefined {
  if (policy.disabledBackends.includes(backend)) return { kind: "backend" };
  if (policy.blockClaudeModels && isClaudeModel(backend, model)) return { kind: "claude" };
  const id = model.trim();
  for (const pattern of policy.blockModels) {
    const compiled = compilePattern(pattern);
    if ((compiled.backend === undefined || compiled.backend === backend) && compiled.regex.test(id)) {
      return { kind: "pattern", pattern };
    }
  }
  return undefined;
}

/** Short label for `list_models` / `list_agent_configs`. */
export function describeBlock(reason: BlockReason): string {
  return reason.kind === "backend" ? "disabledBackends" : reason.kind === "claude" ? "blockClaudeModels" : `blockModels: ${reason.pattern}`;
}

export class ModelBlockedError extends SubagentError {
  constructor(reason: BlockReason, backend: Backend, model: string) {
    const [code, message] = reason.kind === "backend"
      ? ["BACKEND_DISABLED",
        `The ${backend} backend is disabled in subagent-mcp (disabledBackends), so "${model}" will not run. ` +
          `Pick a model on an enabled backend (list_models marks blocked entries); do not retry on ${backend}.`]
      : reason.kind === "claude"
        ? ["CLAUDE_MODEL_BLOCKED",
          `Claude models are blocked in subagent-mcp (blockClaudeModels), so "${model}" on the ${backend} backend ` +
            "will not run. Running Claude through an external CLI costs more than Claude Code's own subagents. " +
            "Do not retry this through subagent-mcp, and do not substitute another Claude model. If a Claude " +
            "subagent is really needed, ask the user in this conversation for explicit approval first (not through " +
            "resolve_approval, which is for subagent tool requests), then launch it with Claude Code's built-in " +
            "Agent tool."]
        : ["MODEL_BLOCKED",
          `"${model}" on the ${backend} backend matches the blocked model pattern "${reason.pattern}" (blockModels), ` +
            "so it will not run. Pick a model list_models does not mark blocked; do not retry this one."];
    super(message, code, { backend, model, ...(reason.kind === "pattern" ? { pattern: reason.pattern } : {}) });
  }
}

/** Validate a `disabledBackends` list from a file or the environment. */
export function parseBackendList(values: readonly string[], context: string): Backend[] {
  return values.map((value) => {
    const name = value.trim().toLowerCase();
    if (!isBackend(name)) throw new ConfigurationError(`${context}: "${value}" is not a backend (${BACKENDS.join(", ")})`);
    return name;
  });
}

/** Validate a `blockModels` list: non-empty strings. */
export function parsePatternList(values: readonly string[], context: string): string[] {
  return values.map((value) => {
    const pattern = value.trim();
    if (pattern === "" || pattern.endsWith(":")) throw new ConfigurationError(`${context}: empty model pattern`);
    return pattern;
  });
}

function readSwitch(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[BLOCK_CLAUDE_MODELS_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  throw new ConfigurationError(`${BLOCK_CLAUDE_MODELS_ENV} must be 1/true or 0/false`, { value: raw });
}

function readList(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
}

/**
 * The file's policy with the environment applied. `SUBAGENT_MCP_BLOCK_CLAUDE_MODELS` replaces the
 * file's switch (so `0` can force it off); the two list variables add to the file's lists, so a
 * block set for every project cannot be lifted by one project's file.
 */
export function applyPolicyEnv(file: ModelPolicy, env: NodeJS.ProcessEnv = process.env): ModelPolicy {
  const disabled = parseBackendList(readList(env, DISABLED_BACKENDS_ENV), DISABLED_BACKENDS_ENV);
  const patterns = parsePatternList(readList(env, BLOCK_MODELS_ENV), BLOCK_MODELS_ENV);
  return {
    blockClaudeModels: readSwitch(env) ?? file.blockClaudeModels,
    disabledBackends: [...new Set([...file.disabledBackends, ...disabled])],
    blockModels: [...new Set([...file.blockModels, ...patterns])],
  };
}

/** True when any rule is active. */
export function isRestrictive(policy: ModelPolicy): boolean {
  return policy.blockClaudeModels || policy.disabledBackends.length > 0 || policy.blockModels.length > 0;
}
