import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { ConfigurationError } from "../core/errors.js";
import { BACKENDS } from "../core/types.js";
import { parseCapabilityProfiles, type CapabilityProfiles } from "../routing/capability-profile.js";
import { selectionCriteriaSchema } from "../routing/model-selector.js";
import {
  AGGREGATION_STRATEGIES,
  COMPLETION_STRATEGIES,
  DEFAULT_MAX_CHARS,
  ENSEMBLE_MODES,
  ISOLATION_MODES,
  MAX_ENSEMBLE_MEMBERS,
  type AggregationSpec,
  type EnsembleSpec,
  type IsolationMode,
  type MemberSpec,
} from "./types.js";

const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

const permissionShape = z.strictObject({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
  default: z.enum(["allow", "deny", "escalate"]),
  mode: z.literal("manual").optional(),
});

export const memberSchema = z.strictObject({
  role: z.string().regex(ROLE_PATTERN, "role: letters, digits, _ . - (max 40)"),
  config: z.string().min(1).optional().describe("Agent config name (.subagents/<config>.md); omit to use select"),
  backend: z.enum(BACKENDS).optional(),
  model: z.string().optional().describe("Required unless the config pins one"),
  effort: z.string().optional(),
  select: selectionCriteriaSchema.optional().describe("Pick config and model automatically (ignored when config is given)"),
  instructions: z.string().optional().describe("Appended to the shared task for this member only"),
  result_schema: z.record(z.string(), z.unknown()).optional(),
  isolation: z.enum(ISOLATION_MODES).optional().describe("snapshot: own worktree holding the working tree as of start, uncommitted changes included"),
  timeout: z.number().int().positive().optional(),
  max_turns: z.number().int().positive().optional(),
  permission: permissionShape.optional().describe("Narrow config permissions; Claude only"),
  depends_on: z.array(z.string()).min(1).optional().describe("Roles of earlier members whose results this member receives"),
  on_dependency_failure: z.enum(["block", "continue"]).optional().describe("block (default): only after they succeed; continue: once they settle, with their outcomes"),
  dependency_max_chars: z.number().int().min(200).max(50_000).optional(),
});

export const completionSchema = z.strictObject({
  strategy: z.enum(COMPLETION_STRATEGIES).optional(),
  quorum: z.number().int().positive().optional(),
  deadline_seconds: z.number().int().positive().max(86_400).optional(),
  cancel_remaining: z.boolean().optional(),
  allow_partial: z.boolean().optional(),
});

export const synthesisSchema = z.strictObject({
  config: z.string().min(1),
  model: z.string().optional(),
  backend: z.enum(BACKENDS).optional(),
  effort: z.string().optional(),
  max_input_chars: z.number().int().min(1_000).max(100_000).optional(),
  timeout_seconds: z.number().int().positive().max(7_200).optional(),
  instructions: z.string().optional(),
});

export const aggregationSchema = z.strictObject({
  strategy: z.enum(AGGREGATION_STRATEGIES).optional(),
  max_items: z.number().int().min(1).max(100).optional(),
  field: z.string().optional(),
  choices: z.array(z.union([z.string(), z.number(), z.boolean()])).min(2).optional(),
  prefer: z.array(z.string()).optional(),
  synthesize: synthesisSchema.optional().describe("Opt-in: one extra agent reconciles the results; the deterministic aggregate is kept"),
});

export const outputSchema = z.strictObject({
  max_chars: z.number().int().min(300).max(50_000).optional(),
  suppress_child_notifications: z.boolean().optional(),
});

export const budgetSchema = z.strictObject({
  max_cost_usd: z.number().positive().optional(),
  max_total_tokens: z.number().int().positive().optional(),
});

/** Fields shared by a start_ensemble call and a named profile; the call's fields win. */
const partialSpecShape = {
  name: z.string().min(1).max(80).optional(),
  task: z.string().min(1).optional(),
  category: z.string().min(1).max(60).optional().describe("Task category for model selection and outcome history"),
  mode: z.enum(ENSEMBLE_MODES).optional(),
  agents: z.array(memberSchema).max(MAX_ENSEMBLE_MEMBERS).optional(),
  selection: selectionCriteriaSchema.extend({
    count: z.number().int().min(1).max(MAX_ENSEMBLE_MEMBERS),
    roles: z.array(z.string()).optional(),
  }).optional().describe("Add `count` automatically selected members"),
  isolation: z.enum(ISOLATION_MODES).optional().describe("Default isolation for members that set none"),
  result_schema: z.record(z.string(), z.unknown()).optional(),
  completion: completionSchema.optional(),
  aggregation: aggregationSchema.optional(),
  output: outputSchema.optional(),
  budget: budgetSchema.optional(),
  run_in_background: z.boolean().optional(),
};

export const profileSchema = z.strictObject({ ...partialSpecShape, description: z.string().optional() });
export type EnsembleProfile = z.infer<typeof profileSchema>;

/** MCP input shape for start_ensemble. */
export const startEnsembleShape = {
  ...partialSpecShape,
  profile: z.string().optional().describe("Named profile from .subagents/ensembles.yaml (or the user-global file); call fields override it"),
  allow_duplicate: z.boolean().optional().describe("Start even if an identical ensemble is still running (default: return that one)"),
  dry_run: z.boolean().optional().describe("Resolve profile and model selection and validate members, without launching"),
};
const startEnsembleSchema = z.strictObject(startEnsembleShape);
export type StartEnsembleInput = z.infer<typeof startEnsembleSchema>;

export interface ProfileSource {
  readonly path: string;
  readonly scope: "project" | "user";
}

/** Project profiles first: a project profile shadows a user-global one with the same name. */
export function defaultProfileSources(cwd: string, env: NodeJS.ProcessEnv = process.env): readonly ProfileSource[] {
  const project = env.SUBAGENT_MCP_ENSEMBLES_FILE ?? join(cwd, ".subagents", "ensembles.yaml");
  const userBase = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const user = env.SUBAGENT_MCP_USER_ENSEMBLES_FILE ?? join(userBase, "subagent-mcp", "ensembles.yaml");
  return [{ path: project, scope: "project" }, { path: user, scope: "user" }];
}

export interface LoadedProfile extends EnsembleProfile {
  readonly name_in_file: string;
  readonly source: string;
}

export interface EnsembleConfigFiles {
  readonly profiles: ReadonlyMap<string, LoadedProfile>;
  readonly routing: CapabilityProfiles;
}

/** Profiles are read on each use, so editing the file needs no reload or reconnect. */
export async function loadProfiles(sources: readonly ProfileSource[]): Promise<ReadonlyMap<string, LoadedProfile>> {
  return (await loadEnsembleConfig(sources)).profiles;
}

/** Profiles (`ensembles:`) and model capability profiles (`routing.models`) from the same files. */
export async function loadEnsembleConfig(sources: readonly ProfileSource[]): Promise<EnsembleConfigFiles> {
  const profiles = new Map<string, LoadedProfile>();
  const routing: { path: string; models: unknown }[] = [];
  for (const source of sources) {
    let text: string;
    try { text = await readFile(source.path, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new ConfigurationError(`Unable to read ensemble profiles at ${source.path}: ${String(error)}`);
    }
    let root: unknown;
    try { root = parse(text); }
    catch (error) { throw new ConfigurationError(`${source.path}: invalid YAML: ${String(error)}`); }
    if (root === null || root === undefined) continue;
    if (typeof root !== "object" || Array.isArray(root)) throw new ConfigurationError(`${source.path}: YAML root must be a map`);
    const routingSection = (root as Record<string, unknown>)["routing"];
    if (routingSection !== undefined) {
      if (typeof routingSection !== "object" || routingSection === null || Array.isArray(routingSection)) {
        throw new ConfigurationError(`${source.path}: routing must be a map`);
      }
      routing.push({ path: source.path, models: (routingSection as Record<string, unknown>)["models"] });
    }
    const ensembles = (root as Record<string, unknown>)["ensembles"];
    if (ensembles === undefined) continue;
    if (typeof ensembles !== "object" || ensembles === null || Array.isArray(ensembles)) {
      throw new ConfigurationError(`${source.path}: ensembles must be a map of profile name to profile`);
    }
    for (const [name, raw] of Object.entries(ensembles)) {
      if (profiles.has(name)) continue;
      const parsed = profileSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ConfigurationError(`${source.path}: ensembles.${name}: ${z.prettifyError(parsed.error)}`);
      }
      profiles.set(name, { ...parsed.data, name_in_file: name, source: source.path });
    }
  }
  return { profiles, routing: parseCapabilityProfiles(routing) };
}

export function describeProfiles(profiles: ReadonlyMap<string, LoadedProfile>): readonly Readonly<Record<string, unknown>>[] {
  return [...profiles.values()].map((profile) => ({
    name: profile.name_in_file,
    ...(profile.description === undefined ? {} : { description: profile.description }),
    mode: profile.mode ?? "parallel",
    roles: (profile.agents ?? []).map((agent) => agent.role),
    aggregation: profile.aggregation?.strategy ?? "collect",
    source: profile.source,
  }));
}

/** Merge a call over its profile, apply defaults, and check everything that does not need the registry. */
export function resolveSpec(rawInput: unknown, profiles: ReadonlyMap<string, LoadedProfile>): EnsembleSpec {
  const parsed = startEnsembleSchema.safeParse(rawInput);
  if (!parsed.success) throw new ConfigurationError(`Invalid start_ensemble input: ${z.prettifyError(parsed.error)}`);
  const input = parsed.data;
  let profile: LoadedProfile | undefined;
  if (input.profile !== undefined) {
    profile = profiles.get(input.profile);
    if (profile === undefined) {
      const known = [...profiles.keys()];
      throw new ConfigurationError(`Unknown ensemble profile "${input.profile}". Known profiles: ${known.length ? known.join(", ") : "(none)"}`);
    }
  }
  const task = input.task ?? profile?.task;
  if (task === undefined) throw new ConfigurationError("start_ensemble needs a task (in the call or its profile)");
  const selection = input.selection ?? profile?.selection;
  const explicit = (input.agents ?? profile?.agents ?? []) as readonly MemberSpec[];
  const selectedRoles = selection === undefined ? [] : Array.from({ length: selection.count }, (_, index) => selection.roles?.[index] ?? `auto-${index + 1}`);
  if (selection?.roles !== undefined && selection.roles.length !== selection.count) {
    throw new ConfigurationError(`selection.roles has ${selection.roles.length} roles for count ${selection.count}`);
  }
  // Selected members are placeholders here; the manager fills config and model from the selector.
  const { count: _count, roles: _roles, ...criteria } = selection ?? { count: 0 };
  const agents: MemberSpec[] = [...explicit, ...selectedRoles.map((role) => ({ role, select: criteria }))];
  if (agents.length === 0) throw new ConfigurationError("start_ensemble needs agents or selection (in the call or its profile)");
  if (agents.length > MAX_ENSEMBLE_MEMBERS) throw new ConfigurationError(`An ensemble has at most ${MAX_ENSEMBLE_MEMBERS} members (got ${agents.length})`);
  for (const agent of agents) {
    if (!ROLE_PATTERN.test(agent.role)) throw new ConfigurationError(`Invalid role "${agent.role}": letters, digits, _ . - (max 40), starting with a letter or digit`);
    if (agent.config === undefined && agent.select === undefined) throw new ConfigurationError(`member ${agent.role} needs config or select`);
  }
  const category = input.category ?? profile?.category;
  const mode = input.mode ?? profile?.mode ?? "parallel";
  const isolation = input.isolation ?? profile?.isolation;
  const completionIn = { ...profile?.completion, ...input.completion };
  const aggregationIn = { ...profile?.aggregation, ...input.aggregation };
  const outputIn = { ...profile?.output, ...input.output };
  const budgetIn = { ...profile?.budget, ...input.budget };

  const members = normalizeMembers(agents.map((agent) => ({
    ...agent,
    ...(agent.isolation === undefined && isolation !== undefined ? { isolation } : {}),
    ...(agent.select !== undefined && agent.select.category === undefined && category !== undefined ? { select: { ...agent.select, category } } : {}),
  })), mode);
  const strategy = completionIn.strategy ?? "all";
  if (strategy === "quorum") {
    if (completionIn.quorum === undefined) throw new ConfigurationError("completion.quorum is required for the quorum strategy");
    if (completionIn.quorum > members.length) throw new ConfigurationError(`completion.quorum (${completionIn.quorum}) exceeds the ${members.length} members`);
  } else if (completionIn.quorum !== undefined) {
    throw new ConfigurationError("completion.quorum applies only to the quorum strategy");
  }
  if (strategy === "deadline" && completionIn.deadline_seconds === undefined) {
    throw new ConfigurationError("completion.deadline_seconds is required for the deadline strategy");
  }
  const aggregation: AggregationSpec = {
    strategy: aggregationIn.strategy ?? "collect",
    max_items: aggregationIn.max_items ?? (aggregationIn.strategy === "review_findings" ? 5 : 8),
    ...(aggregationIn.field === undefined ? {} : { field: aggregationIn.field }),
    ...(aggregationIn.choices === undefined ? {} : { choices: aggregationIn.choices }),
    ...(aggregationIn.prefer === undefined ? {} : { prefer: aggregationIn.prefer }),
    ...(aggregationIn.synthesize === undefined ? {} : { synthesize: {
      ...aggregationIn.synthesize,
      max_input_chars: aggregationIn.synthesize.max_input_chars ?? 12_000,
      timeout_seconds: aggregationIn.synthesize.timeout_seconds ?? 600,
    } }),
  };
  const roles = new Set(members.map((member) => member.role));
  for (const role of aggregation.prefer ?? []) {
    if (!roles.has(role)) throw new ConfigurationError(`aggregation.prefer names unknown role "${role}"`);
  }
  const budget = {
    ...(budgetIn.max_cost_usd === undefined ? {} : { max_cost_usd: budgetIn.max_cost_usd }),
    ...(budgetIn.max_total_tokens === undefined ? {} : { max_total_tokens: budgetIn.max_total_tokens }),
  };
  const resultSchema = input.result_schema ?? profile?.result_schema;
  return {
    name: input.name ?? profile?.name ?? input.profile ?? "ensemble",
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    task,
    ...(category === undefined ? {} : { category }),
    mode,
    agents: members,
    ...(selection === undefined ? {} : { selection }),
    ...(resultSchema === undefined ? {} : { result_schema: resultSchema }),
    completion: {
      strategy,
      ...(completionIn.quorum === undefined ? {} : { quorum: completionIn.quorum }),
      ...(completionIn.deadline_seconds === undefined ? {} : { deadline_seconds: completionIn.deadline_seconds }),
      cancel_remaining: completionIn.cancel_remaining ?? false,
      allow_partial: completionIn.allow_partial ?? true,
    },
    aggregation,
    output: {
      max_chars: outputIn.max_chars ?? DEFAULT_MAX_CHARS,
      suppress_child_notifications: outputIn.suppress_child_notifications ?? true,
    },
    ...(Object.keys(budget).length === 0 ? {} : { budget }),
    run_in_background: input.run_in_background ?? profile?.run_in_background ?? true,
  };
}

function normalizeMembers(agents: readonly MemberSpec[], mode: EnsembleSpec["mode"]): readonly MemberSpec[] {
  const seen = new Set<string>();
  for (const [index, agent] of agents.entries()) {
    if (seen.has(agent.role)) throw new ConfigurationError(`Duplicate ensemble role "${agent.role}"`);
    for (const dependency of agent.depends_on ?? []) {
      // Earlier members only: the order is the schedule and rules out cycles.
      if (!seen.has(dependency)) {
        throw new ConfigurationError(`agents[${index}] (${agent.role}) depends on "${dependency}", which is not an earlier member`);
      }
    }
    seen.add(agent.role);
  }
  if (mode === "specialist") {
    const missing = agents.filter((agent) => agent.instructions === undefined || agent.instructions.trim() === "");
    if (missing.length > 0) {
      throw new ConfigurationError(`specialist mode needs instructions for every member; missing for ${missing.map((agent) => agent.role).join(", ")}`);
    }
  }
  // Pipeline: a member without depends_on follows the one before it; an explicit depends_on replaces that.
  if (mode === "pipeline") {
    agents = agents.map((agent, index, list) => index === 0 || agent.depends_on !== undefined ? agent : { ...agent, depends_on: [list[index - 1]!.role] });
  }
  for (const agent of agents) {
    if (agent.on_dependency_failure !== undefined && agent.depends_on === undefined) {
      throw new ConfigurationError(`${agent.role}: on_dependency_failure needs depends_on${mode === "pipeline" ? " (the first pipeline member has no dependency)" : ""}`);
    }
  }
  if (mode === "competitive") {
    const shared = agents.filter((agent) => agent.isolation === "none");
    if (shared.length > 0) {
      throw new ConfigurationError(`competitive members must not share the working tree; remove isolation: none from ${shared.map((agent) => agent.role).join(", ")}`);
    }
    return agents.map((agent) => ({ ...agent, isolation: agent.isolation ?? ("worktree" satisfies IsolationMode) }));
  }
  return agents;
}

/** Stable identity of an ensemble's work: the same task, roster and policies hash the same. */
export function fingerprint(spec: EnsembleSpec): string {
  // Everything that changes what runs or what is reported; only the label and blocking mode are left out.
  const { name: _name, profile: _profile, run_in_background: _background, ...material } = spec;
  return createHash("sha256").update(stableStringify(material)).digest("hex").slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

/** Built-in result schema for review_findings members, used when neither the member nor the ensemble sets one. */
export const REVIEW_FINDINGS_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: [...SEVERITIES] },
          file: { type: "string" },
          line: { type: "integer" },
          category: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
};

/** The schema a member's result must match, or undefined for free text. */
export function memberSchemaFor(spec: EnsembleSpec, member: MemberSpec): Record<string, unknown> | undefined {
  if (member.result_schema !== undefined) return member.result_schema;
  if (spec.result_schema !== undefined) return spec.result_schema;
  if (spec.aggregation.strategy === "review_findings") return { ...REVIEW_FINDINGS_SCHEMA };
  if (spec.aggregation.strategy === "vote") {
    const field = spec.aggregation.field ?? "answer";
    if (field.includes(".")) return undefined;
    const answer = spec.aggregation.choices === undefined
      ? { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] }
      : { enum: [...spec.aggregation.choices] };
    return { type: "object", required: [field], properties: { [field]: answer, rationale: { type: "string" } } };
  }
  return undefined;
}

/** The child's prompt: shared task, its role and instructions. It never includes the parent's conversation. */
export function memberPrompt(spec: EnsembleSpec, member: MemberSpec): string {
  const parts = [spec.task.trim()];
  const roleLine = `You are the "${member.role}" member of a ${spec.agents.length}-agent ensemble working independently on this task.`;
  parts.push(roleLine);
  if (member.instructions !== undefined && member.instructions.trim() !== "") parts.push(`Your assignment:\n${member.instructions.trim()}`);
  if (spec.aggregation.strategy === "review_findings" && member.result_schema === undefined && spec.result_schema === undefined) {
    parts.push("Report each distinct defect as one finding with a short title, severity (critical/high/medium/low/info), " +
      "the repository-relative file and line when known, and a brief detail with the evidence. Report no findings rather than speculative ones.");
  }
  return parts.join("\n\n");
}
