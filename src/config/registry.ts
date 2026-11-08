import { readdir, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parse } from "yaml";

import { withEndpointModels } from "./endpoints.js";
import { ConfigurationError } from "../core/errors.js";
import {
  AGENT_DEPTH_ENV,
  DEFAULT_CODEX_RESUME_IDLE_MS,
  MAX_CONCURRENT_AGENTS,
} from "../core/limits.js";
import { BACKENDS, isBackend, type Backend } from "../core/types.js";
import { OPEN_POLICY, parseBackendList, parsePatternList, type ModelPolicy } from "../core/model-policy.js";
import {
  CLAUDE_PERMISSION_MODES,
  type AgentConfig,
  type Allowance,
  type ClaudePermissionMode,
  type ModelEntry,
  type ModelRoster,
  type PermissionConfig,
  type PermissionDefault,
  type ResolvedAgentConfig,
  type ServerLimits,
} from "./schema.js";

type UnknownRecord = Record<string, unknown>;

export interface RegistryLoadOptions {
  readonly agentsDirectory: string;
  readonly modelsFile: string;
}

export interface ResolveAgentOptions {
  readonly agent: string;
  readonly model?: string;
  readonly backend?: Backend;
  readonly reasoningEffort?: string;
}

export interface AgentConfigSource {
  listAgents(): readonly AgentConfig[];
  resolveAgent(options: ResolveAgentOptions): ResolvedAgentConfig;
  listModels(backend?: Backend): Readonly<Record<Backend, readonly ModelEntry[]>> | readonly ModelEntry[];
  maxConcurrent(): number;
  codexResumeIdleMs(): number;
  allowances(): Readonly<Partial<Record<Backend, Allowance>>>;
  modelPolicy(): ModelPolicy;
  configWarning(): string | undefined;
}

/** Backends with no effort parameter. Cursor folds effort into the model id instead. */
const EFFORT_REJECTED_BACKENDS = new Set<Backend>(["opencode", "cursor"]);

export class ConfigRegistry implements AgentConfigSource {
  readonly #agents = new Map<string, AgentConfig>();

  constructor(
    agents: readonly AgentConfig[],
    readonly roster: ModelRoster,
    readonly limits: ServerLimits = defaultServerLimits(),
  ) {
    for (const agent of agents) {
      if (this.#agents.has(agent.name)) {
        throw new ConfigurationError(`Duplicate agent config name: ${agent.name}`);
      }
      this.#agents.set(agent.name, agent);
    }
  }

  listAgents(): readonly AgentConfig[] {
    return [...this.#agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getAgent(name: string): AgentConfig {
    const agent = this.#agents.get(name);
    if (!agent) {
      const known = [...this.#agents.keys()].sort();
      throw new ConfigurationError(
        `Unknown agent config "${name}". Valid agents: ${formatList(known)}. Loaded from: ${formatList([...new Set(this.listAgents().map(agent => agent.sourcePath))])}`,
        { agent: name, validAgents: known },
      );
    }
    return agent;
  }

  listModels(backend?: Backend): Readonly<Record<Backend, readonly ModelEntry[]>> | readonly ModelEntry[] {
    return backend === undefined ? this.roster : this.roster[backend];
  }

  maxConcurrent(): number {
    return this.limits.maxConcurrent;
  }

  codexResumeIdleMs(): number {
    return this.limits.codexResumeIdleMs;
  }

  allowances(): Readonly<Partial<Record<Backend, Allowance>>> {
    return this.limits.allowances;
  }

  modelPolicy(): ModelPolicy {
    return this.limits.modelPolicy;
  }

  configWarning(): string | undefined {
    return undefined;
  }

  resolveAgent(options: ResolveAgentOptions): ResolvedAgentConfig {
    const agent = this.getAgent(options.agent);
    const backend = options.backend ?? agent.backend;
    if (agent.model !== undefined && options.model !== undefined && options.model !== agent.model) {
      throw new ConfigurationError(
        `Agent "${agent.name}" pins model "${agent.model}"; spawn cannot override it with "${options.model}"`,
        { agent: agent.name, pinnedModel: agent.model, requestedModel: options.model },
      );
    }
    const model = agent.model ?? options.model;
    if (model === undefined || model.trim() === "") {
      throw modelSelectionError(backend, undefined, this.roster[backend]);
    }
    const models = this.roster[backend];
    const modelEntry = models.find((candidate) => candidate.name === model);
    if (!modelEntry) {
      throw modelSelectionError(backend, model, models);
    }
    if (
      agent.reasoningEffort !== undefined &&
      options.reasoningEffort !== undefined &&
      options.reasoningEffort !== agent.reasoningEffort
    ) {
      throw new ConfigurationError(
        `Agent "${agent.name}" pins reasoningEffort "${agent.reasoningEffort}"; spawn cannot override it with "${options.reasoningEffort}"`,
        { agent: agent.name, pinnedReasoningEffort: agent.reasoningEffort, requestedReasoningEffort: options.reasoningEffort },
      );
    }
    const reasoningEffort = agent.reasoningEffort ?? options.reasoningEffort;
    if (reasoningEffort !== undefined && EFFORT_REJECTED_BACKENDS.has(backend)) {
      throw effortIgnoredError(backend, reasoningEffort);
    }
    if (backend === "antigravity" && agent.antigravityAgent === undefined) {
      throw new ConfigurationError(
        `Agent "${agent.name}" uses the Antigravity backend but does not set antigravityAgent`,
        { agent: agent.name, backend },
      );
    }
    return {
      ...agent,
      backend,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(modelEntry.provider === undefined ? {} : { modelProvider: modelEntry.provider }),
    };
  }
}

export function defaultServerLimits(): ServerLimits {
  return {
    maxConcurrent: MAX_CONCURRENT_AGENTS,
    codexResumeIdleMs: DEFAULT_CODEX_RESUME_IDLE_MS,
    allowances: {},
    modelPolicy: OPEN_POLICY,
  };
}

export async function loadConfigRegistry(options: RegistryLoadOptions): Promise<ConfigRegistry> {
  const [agents, models] = await Promise.all([
    loadAgentConfigs(options.agentsDirectory),
    loadModelsFile(options.modelsFile),
  ]);
  return new ConfigRegistry(agents, await withEndpointModels(models.roster), models.limits);
}

export async function loadAgentConfigs(directory: string): Promise<readonly AgentConfig[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new ConfigurationError(`Unable to read agent config directory ${directory}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const files = entries
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
    .map((entry) => resolve(directory, entry.name))
    .sort();
  return Promise.all(files.map(loadAgentConfig));
}

export async function loadAgentConfig(path: string): Promise<AgentConfig> {
  const text = await readFile(path, "utf8");
  const { frontmatter, body } = splitFrontmatter(text, path);
  const value = parseYamlObject(frontmatter, path);
  const name = requiredString(value, "name", path);
  const expectedName = basename(path, ".md");
  if (name !== expectedName) {
    throw new ConfigurationError(`Agent name "${name}" must match filename "${expectedName}.md"`, {
      path,
    });
  }
  const backendValue = value["backend"];
  if (!isBackend(backendValue)) {
    throw new ConfigurationError(`Invalid backend in ${path}; expected ${BACKENDS.join(", ")}`);
  }
  const model = optionalString(value, "model", path);
  const reasoningEffort = optionalString(value, "reasoningEffort", path);
  const antigravityAgent = optionalString(value, "antigravityAgent", path);
  const description = requiredString(value, "description", path);
  const maxTurns = optionalPositiveInteger(value, "maxTurns", path);
  const timeout = optionalPositiveInteger(value, "timeout", path);
  const permission = parsePermission(value["permission"], path);
  const worktreeSetup = value['worktreeSetup'];
  if (worktreeSetup !== undefined && (!Array.isArray(worktreeSetup) || worktreeSetup.some(command => typeof command !== 'string' || !command.trim()))) throw new ConfigurationError(`worktreeSetup must be an array of commands in ${path}`);
  const env = parseStringMap(value["env"], `${path}: env`);

  return {
    name,
    backend: backendValue,
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(antigravityAgent === undefined ? {} : { antigravityAgent }),
    description,
    systemPrompt: body.trim(),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(timeout === undefined ? {} : { timeout }),
    permission,
    env,
    ...(worktreeSetup === undefined ? {} : { worktreeSetup: worktreeSetup as string[] }),
    sourcePath: path,
  };
}

export interface ModelsFile {
  readonly roster: ModelRoster;
  readonly limits: ServerLimits;
}

export async function loadModelRoster(path: string): Promise<ModelRoster> {
  return (await loadModelsFile(path)).roster;
}

export async function loadModelsFile(path: string): Promise<ModelsFile> {
  const source = await readFile(path, "utf8");
  const root = parseYamlObject(source, path);
  const rawModels = isRecord(root["models"]) ? root["models"] : root;
  const roster = Object.fromEntries(
    BACKENDS.map((backend) => [
      backend,
      // Antigravity and Cursor were added after the original roster format. Let older projects
      // load until they deliberately add a model, while preserving strict array validation for
      // every key they do provide and for the pre-existing backends.
      (backend === "antigravity" || backend === "cursor") && rawModels[backend] === undefined
        ? []
        : parseModelEntries(rawModels[backend], path, backend),
    ]),
  ) as Record<Backend, readonly ModelEntry[]>;
  return { roster, limits: parseServerLimits(root, path) };
}

function parseModelEntries(value: unknown, path: string, backend: Backend): readonly ModelEntry[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${path}: models.${backend} must be an array (it may be empty)`);
  }
  const entries = value.map((item, index): ModelEntry => {
    if (typeof item === "string" && item.trim() !== "") return { name: item };
    if (!isRecord(item)) {
      throw new ConfigurationError(`${path}: models.${backend}[${index}] must be a string or object`);
    }
    const name = requiredString(item, "name", `${path}: models.${backend}[${index}]`);
    const version = optionalString(item, "version", path);
    const description = optionalString(item, "description", path);
    const provider = optionalString(item, "provider", path);
    return {
      name,
      ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }),
      ...(provider === undefined ? {} : { provider }),
    };
  });
  const duplicates = entries.filter((entry, index) => entries.findIndex((other) => other.name === entry.name) !== index);
  if (duplicates.length > 0) {
    throw new ConfigurationError(`${path}: duplicate ${backend} model names: ${formatList(duplicates.map((x) => x.name))}`);
  }
  return entries;
}

function parsePermission(value: unknown, path: string): PermissionConfig {
  if (value === undefined) return { allow: [], deny: [], default: "escalate" };
  if (!isRecord(value)) throw new ConfigurationError(`${path}: permission must be an object`);
  const allow = stringArray(value["allow"], `${path}: permission.allow`);
  const deny = stringArray(value["deny"], `${path}: permission.deny`);
  const defaultValue = value["default"] ?? "escalate";
  if (!isPermissionDefault(defaultValue)) {
    throw new ConfigurationError(`${path}: permission.default must be allow, deny, or escalate`);
  }
  const mode = value["mode"];
  if (mode === undefined) return { allow, deny, default: defaultValue };
  if (!isClaudePermissionMode(mode)) {
    throw new ConfigurationError(`${path}: permission.mode must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
  return { allow, deny, default: defaultValue, mode };
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === "string" && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

function splitFrontmatter(text: string, path: string): { frontmatter: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) throw new ConfigurationError(`${path}: expected YAML frontmatter delimited by ---`);
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

function parseYamlObject(source: string, path: string): UnknownRecord {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new ConfigurationError(`${path}: invalid YAML`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) throw new ConfigurationError(`${path}: YAML root must be an object`);
  return parsed;
}

function requiredString(record: UnknownRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${context}: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: UnknownRecord, key: string, context: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${context}: ${key} must be a non-empty string when present`);
  }
  return value;
}

function optionalBoolean(record: UnknownRecord, key: string, context: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ConfigurationError(`${context}: ${key} must be true or false`);
  return value;
}

function optionalPositiveInteger(record: UnknownRecord, key: string, context: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${context}: ${key} must be a positive integer`);
  }
  return value;
}

function parseStringMap(value: unknown, context: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigurationError(`${context} must be an object`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new ConfigurationError(`${context} values must all be strings`);
  }
  if (entries.some(([key]) => key === AGENT_DEPTH_ENV)) {
    throw new ConfigurationError(`${context} must not set reserved variable ${AGENT_DEPTH_ENV}; depth is bridge-owned`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function stringArray(value: unknown, context: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ConfigurationError(`${context} must be an array of non-empty strings`);
  }
  return value as string[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionDefault(value: unknown): value is PermissionDefault {
  return value === "allow" || value === "deny" || value === "escalate";
}

function parseServerLimits(root: UnknownRecord, path: string): ServerLimits {
  const maxConcurrent = optionalPositiveInteger(root, "maxConcurrent", path) ?? MAX_CONCURRENT_AGENTS;
  const idleSeconds = optionalPositiveInteger(root, "codexResumeIdleSeconds", path);
  return {
    maxConcurrent,
    codexResumeIdleMs: idleSeconds === undefined ? DEFAULT_CODEX_RESUME_IDLE_MS : idleSeconds * 1000,
    allowances: parseAllowances(root["allowances"], path),
    modelPolicy: {
      blockClaudeModels: optionalBoolean(root, "blockClaudeModels", path) ?? false,
      disabledBackends: parseBackendList(stringArray(root["disabledBackends"], `${path}: disabledBackends`), `${path}: disabledBackends`),
      blockModels: parsePatternList(stringArray(root["blockModels"], `${path}: blockModels`), `${path}: blockModels`),
    },
  };
}

function parseAllowances(value: unknown, path: string): Readonly<Partial<Record<Backend, Allowance>>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigurationError(`${path}: allowances must be an object`);
  const allowances: Partial<Record<Backend, Allowance>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isBackend(key)) {
      throw new ConfigurationError(`${path}: allowances.${key} is not a backend (${BACKENDS.join(", ")})`);
    }
    if (!isRecord(raw)) throw new ConfigurationError(`${path}: allowances.${key} must be an object`);
    const context = `${path}: allowances.${key}`;
    const maxSpawns = optionalPositiveInteger(raw, "maxSpawns", context);
    const maxInputTokens = optionalPositiveInteger(raw, "maxInputTokens", context);
    const maxOutputTokens = optionalPositiveInteger(raw, "maxOutputTokens", context);
    const maxCostUsd = optionalPositiveNumber(raw, "maxCostUsd", context);
    allowances[key] = {
      ...(maxSpawns === undefined ? {} : { maxSpawns }),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    };
  }
  return allowances;
}

function optionalPositiveNumber(record: UnknownRecord, key: string, context: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${context}: ${key} must be a positive number`);
  }
  return value;
}

function effortIgnoredError(backend: Backend, effort: string): ConfigurationError {
  const detail = backend === "cursor"
    ? `Cursor folds effort into the model id (for example grok-4.7-high). Pass that model and omit effort.`
    : `OpenCode has no reasoning-effort parameter, so the run would silently use the model's default.`;
  return new ConfigurationError(
    `Backend "${backend}" does not honor effort "${effort}". ${detail} Remove effort, or use Claude, Codex, or Antigravity.`,
    { backend, effort },
  );
}

function modelSelectionError(backend: Backend, requested: string | undefined, models: readonly ModelEntry[]): ConfigurationError {
  const valid = models.map((model) => model.name);
  const prefix = requested === undefined
    ? `No model selected for backend ${backend}`
    : `Unknown model "${requested}" for backend ${backend}`;
  return new ConfigurationError(`${prefix}. Valid models: ${formatList(valid)}`, {
    backend,
    ...(requested === undefined ? {} : { requested }),
    validModels: valid,
  });
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "(none configured)" : values.join(", ");
}
