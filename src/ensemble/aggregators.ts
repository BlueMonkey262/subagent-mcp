import { isAbsolute, relative } from "node:path";

import { stableStringify } from "./config.js";
import type { Aggregate, AggregationSpec, AggregationStrategy, MemberResult } from "./types.js";

/**
 * Deterministic aggregation: no model calls. Each aggregator sees every member (valid or not)
 * and reports invalid ones as abstentions instead of silently dropping them.
 */
export interface AggregationContext {
  /** Repository root, so absolute finding paths can be reported relative to it. */
  readonly cwd?: string;
}

export type Aggregator = (results: readonly MemberResult[], options: AggregationSpec, context: AggregationContext) => Aggregate;

export const AGGREGATORS: Readonly<Record<AggregationStrategy, Aggregator>> = {
  collect,
  compare,
  vote,
  merge,
  review_findings: reviewFindings,
};

export function aggregate(results: readonly MemberResult[], options: AggregationSpec, context: AggregationContext = {}): Aggregate {
  return { strategy: options.strategy, ...AGGREGATORS[options.strategy](results, options, context) };
}

function invalidList(results: readonly MemberResult[]): readonly Readonly<Record<string, unknown>>[] {
  return results.filter((result) => !result.valid).map((result) => ({ role: result.role, state: result.state, ...(result.reason ? { reason: result.reason } : {}) }));
}

function withInvalid(body: Record<string, unknown>, results: readonly MemberResult[]): Aggregate {
  const invalid = invalidList(results);
  return invalid.length === 0 ? body : { ...body, not_counted: invalid };
}

/** Attributed results, structured where available. Long text is shortened later by the response budget. */
function collect(results: readonly MemberResult[], options: AggregationSpec): Aggregate {
  const valid = results.filter((result) => result.valid);
  const items = valid.slice(0, options.max_items).map((result) => ({
    role: result.role,
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.branch === undefined ? {} : { branch: result.branch }),
    result: result.value !== undefined ? result.value : result.text ?? "",
  }));
  return withInvalid({ valid: valid.length, items, ...(valid.length > items.length ? { omitted: valid.length - items.length } : {}) }, results);
}

// ---------------------------------------------------------------- compare

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Leaves keyed by dotted path. Arrays are leaves: element order and identity are the answer being compared. */
export function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, item] of Object.entries(value)) {
      for (const [path, leaf] of flatten(item, prefix === "" ? key : `${prefix}.${key}`)) out.set(path, leaf);
    }
  } else {
    out.set(prefix === "" ? "(value)" : prefix, value);
  }
  return out;
}

function comparable(result: MemberResult): unknown {
  return result.value !== undefined ? result.value : result.text?.trim();
}

function compare(results: readonly MemberResult[], options: AggregationSpec): Aggregate {
  const valid = results.filter((result) => result.valid);
  const flat = valid.map((result) => ({ role: result.role, leaves: flatten(comparable(result)) }));
  const paths = [...new Set(flat.flatMap((entry) => [...entry.leaves.keys()]))].sort();
  const agreed: Record<string, unknown> = {};
  const differing: Record<string, unknown>[] = [];
  for (const path of paths) {
    const present = flat.filter((entry) => entry.leaves.has(path));
    const missing = flat.filter((entry) => !entry.leaves.has(path)).map((entry) => entry.role);
    const groups = new Map<string, { value: unknown; roles: string[] }>();
    for (const entry of present) {
      const value = entry.leaves.get(path);
      const key = stableStringify(value);
      const group = groups.get(key) ?? { value, roles: [] };
      group.roles.push(entry.role);
      groups.set(key, group);
    }
    if (groups.size === 1 && missing.length === 0 && present.length > 1) {
      agreed[path] = [...groups.values()][0]!.value;
    } else if (present.length > 0 && (groups.size > 1 || missing.length > 0)) {
      differing.push({
        path,
        values: [...groups.values()].map((group) => ({ value: group.value, roles: group.roles })),
        ...(missing.length === 0 ? {} : { missing_in: missing }),
      });
    }
  }
  const comparedPaths = paths.length;
  // Agreement needs at least two results; with fewer there is nothing to agree or disagree with.
  return withInvalid({
    compared: valid.length,
    paths: comparedPaths,
    agreement: comparedPaths === 0 || valid.length < 2 ? null : Number((Object.keys(agreed).length / comparedPaths).toFixed(2)),
    agreed,
    differing: differing.slice(0, options.max_items),
    ...(differing.length > options.max_items ? { differing_omitted: differing.length - options.max_items } : {}),
  }, results);
}

// ---------------------------------------------------------------- vote

export function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function normalizeVote(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().toLowerCase() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function vote(results: readonly MemberResult[], options: AggregationSpec): Aggregate {
  const field = options.field ?? "answer";
  const choices = options.choices?.map((choice) => normalizeVote(choice));
  const tally = new Map<string, { answer: unknown; roles: string[] }>();
  const abstentions: Record<string, unknown>[] = [];
  for (const result of results) {
    if (!result.valid) { abstentions.push({ role: result.role, reason: result.reason ?? result.state }); continue; }
    const raw = result.value !== undefined ? readPath(result.value, field) : field === "answer" ? result.text : undefined;
    const key = normalizeVote(raw);
    if (key === undefined) { abstentions.push({ role: result.role, reason: `no ${field}` }); continue; }
    if (choices !== undefined && !choices.includes(key)) { abstentions.push({ role: result.role, reason: `answer outside choices: ${String(raw).slice(0, 40)}` }); continue; }
    const entry = tally.get(key) ?? { answer: typeof raw === "string" ? raw.trim() : raw, roles: [] };
    entry.roles.push(result.role);
    tally.set(key, entry);
  }
  const votes = [...tally.values()].sort((a, b) => b.roles.length - a.roles.length)
    .map((entry) => ({ answer: entry.answer, count: entry.roles.length, roles: entry.roles }));
  const top = votes[0];
  const tie = top !== undefined && votes.length > 1 && votes[1]!.count === top.count;
  const cast = votes.reduce((sum, entry) => sum + entry.count, 0);
  return {
    field,
    cast,
    leader: top === undefined || tie ? null : top.answer,
    tie,
    unanimous: votes.length === 1 && abstentions.length === 0,
    ...(top === undefined || tie ? {} : { leader_share: Number((top.count / cast).toFixed(2)) }),
    votes,
    ...(abstentions.length === 0 ? {} : { abstentions }),
  };
}

// ---------------------------------------------------------------- merge

const OMIT = Symbol("omit");

function mergeEntries(
  entries: readonly { readonly role: string; readonly value: unknown }[],
  path: string,
  conflicts: Record<string, unknown>[],
  prefer: readonly string[],
): unknown {
  const defined = entries.filter((entry) => entry.value !== undefined);
  if (defined.length === 0) return OMIT;
  if (defined.every((entry) => isPlainObject(entry.value))) {
    const keys = [...new Set(defined.flatMap((entry) => Object.keys(entry.value as Record<string, unknown>)))];
    const merged: Record<string, unknown> = {};
    for (const key of keys) {
      const value = mergeEntries(defined.map((entry) => ({ role: entry.role, value: (entry.value as Record<string, unknown>)[key] })),
        path === "" ? key : `${path}.${key}`, conflicts, prefer);
      if (value !== OMIT) merged[key] = value;
    }
    return merged;
  }
  if (defined.every((entry) => Array.isArray(entry.value))) {
    // Union, keeping first-seen order; equal elements (by value) appear once.
    const seen = new Set<string>();
    const union: unknown[] = [];
    for (const entry of defined) {
      for (const item of entry.value as unknown[]) {
        const key = stableStringify(item);
        if (!seen.has(key)) { seen.add(key); union.push(item); }
      }
    }
    return union;
  }
  const distinct = new Set(defined.map((entry) => stableStringify(entry.value)));
  if (distinct.size === 1) return defined[0]!.value;
  const preferred = prefer.map((role) => defined.find((entry) => entry.role === role)).find((entry) => entry !== undefined);
  conflicts.push({
    path: path === "" ? "(value)" : path,
    values: Object.fromEntries(defined.map((entry) => [entry.role, entry.value])),
    resolution: preferred === undefined ? "omitted" : `prefer:${preferred.role}`,
  });
  return preferred === undefined ? OMIT : preferred.value;
}

function merge(results: readonly MemberResult[], options: AggregationSpec): Aggregate {
  const valid = results.filter((result) => result.valid);
  const objects = valid.filter((result) => isPlainObject(result.value));
  const unmergeable = valid.filter((result) => !isPlainObject(result.value)).map((result) => result.role);
  const conflicts: Record<string, unknown>[] = [];
  const merged = mergeEntries(objects.map((result) => ({ role: result.role, value: result.value })), "", conflicts, options.prefer ?? []);
  return withInvalid({
    sources: objects.map((result) => result.role),
    merged: merged === OMIT ? {} : merged,
    conflicts: conflicts.slice(0, options.max_items),
    ...(conflicts.length > options.max_items ? { conflicts_omitted: conflicts.length - options.max_items } : {}),
    ...(unmergeable.length === 0 ? {} : { not_objects: unmergeable }),
  }, results);
}

// ---------------------------------------------------------------- review_findings

const SEVERITY_WEIGHT: Readonly<Record<string, number>> = { critical: 4, high: 3, medium: 2, low: 1, info: 0, unrated: 1.5 };
const SEVERITY_ALIASES: Readonly<Record<string, string>> = {
  critical: "critical", blocker: "critical", severe: "critical",
  high: "high", major: "high", error: "high", important: "high",
  medium: "medium", moderate: "medium", warning: "medium", normal: "medium",
  low: "low", minor: "low",
  info: "info", nit: "info", style: "info", suggestion: "info", trivial: "info", informational: "info",
};

export function normalizeSeverity(value: unknown): string {
  return typeof value === "string" ? SEVERITY_ALIASES[value.trim().toLowerCase()] ?? "unrated" : "unrated";
}

export function normalizeLocation(file: unknown, line: unknown, cwd?: string): { file?: string; line?: number } {
  let path = typeof file === "string" ? file.trim() : "";
  let lineNumber = typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined;
  const suffix = /^(.*?):(\d+)(?::\d+)?$/.exec(path);
  if (suffix && suffix[1]) {
    path = suffix[1];
    lineNumber ??= Number(suffix[2]);
  }
  path = path.replace(/^`|`$/g, "");
  if (cwd !== undefined && isAbsolute(path)) {
    const inside = relative(cwd, path);
    if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) path = inside;
  }
  path = path.replace(/^\.\//, "").replace(/\\/g, "/");
  return { ...(path === "" ? {} : { file: path }), ...(lineNumber === undefined ? {} : { line: lineNumber }) };
}

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "not", "when", "can", "may", "into", "its", "but", "has", "have", "will", "missing", "possible", "potential"]);

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 3 && !STOPWORDS.has(word)));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface Finding {
  readonly role: string;
  readonly title: string;
  readonly severity: string;
  readonly file?: string;
  readonly line?: number;
  readonly category?: string;
  readonly detail?: string;
  readonly words: Set<string>;
}

interface Cluster { readonly findings: Finding[] }

/** Same issue? Conservative: same file, and either nearby lines with overlapping wording or near-identical wording. */
function sameIssue(cluster: Cluster, finding: Finding): boolean {
  if (cluster.findings.some((existing) => existing.role === finding.role)) return false;
  const lead = cluster.findings[0]!;
  if (lead.file !== finding.file) return false;
  const similarity = Math.max(...cluster.findings.map((existing) => jaccard(existing.words, finding.words)));
  const lines = cluster.findings.map((existing) => existing.line).filter((line): line is number => line !== undefined);
  const near = finding.line !== undefined && lines.some((line) => Math.abs(line - finding.line!) <= 5);
  const sameCategory = finding.category !== undefined && cluster.findings.some((existing) => existing.category === finding.category);
  if (near && (similarity >= 0.2 || sameCategory)) return true;
  return similarity >= 0.6;
}

function extractFindings(result: MemberResult, cwd?: string): Finding[] | undefined {
  const raw = isPlainObject(result.value) ? result.value["findings"] : Array.isArray(result.value) ? result.value : undefined;
  if (!Array.isArray(raw)) return undefined;
  const findings: Finding[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const title = [item["title"], item["summary"], item["message"], item["description"]].find((value) => typeof value === "string" && value.trim() !== "") as string | undefined;
    if (title === undefined) continue;
    const location = normalizeLocation(item["file"] ?? item["path"], item["line"], cwd);
    const detail = [item["detail"], item["details"], item["evidence"], item["description"]].find((value) => typeof value === "string" && value.trim() !== "" && value !== title) as string | undefined;
    const category = typeof item["category"] === "string" ? item["category"].trim().toLowerCase() : undefined;
    findings.push({
      role: result.role,
      title: title.trim(),
      severity: normalizeSeverity(item["severity"]),
      ...location,
      ...(category === undefined || category === "" ? {} : { category }),
      ...(detail === undefined ? {} : { detail: detail.trim() }),
      words: tokens(`${title} ${category ?? ""}`),
    });
  }
  return findings;
}

function reviewFindings(results: readonly MemberResult[], options: AggregationSpec, context: AggregationContext): Aggregate {
  const reviewers: string[] = [];
  const unreadable: string[] = [];
  const all: Finding[] = [];
  for (const result of results.filter((entry) => entry.valid)) {
    const findings = extractFindings(result, context.cwd);
    if (findings === undefined) { unreadable.push(result.role); continue; }
    reviewers.push(result.role);
    all.push(...findings);
  }
  // Highest severity first, so each cluster's lead (and its wording) is its most serious report.
  const ordered = [...all].sort((a, b) => (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0));
  const clusters: Cluster[] = [];
  for (const finding of ordered) {
    const home = clusters.find((cluster) => sameIssue(cluster, finding));
    if (home) home.findings.push(finding);
    else clusters.push({ findings: [finding] });
  }
  const ranked = clusters.map((cluster) => {
    const lead = cluster.findings[0]!;
    const severities = new Set(cluster.findings.map((finding) => finding.severity));
    const lines = cluster.findings.map((finding) => finding.line).filter((line): line is number => line !== undefined);
    const detail = cluster.findings.map((finding) => finding.detail).find((text) => text !== undefined);
    const score = (SEVERITY_WEIGHT[lead.severity] ?? 0) * 10 + cluster.findings.length;
    return {
      score,
      item: {
        severity: lead.severity,
        title: lead.title,
        ...(lead.file === undefined ? {} : { file: lead.file }),
        ...(lines.length === 0 ? {} : { line: Math.min(...lines) }),
        reported_by: cluster.findings.map((finding) => finding.role),
        ...(severities.size > 1 ? { severity_disagreement: Object.fromEntries(cluster.findings.map((finding) => [finding.role, finding.severity])) } : {}),
        ...(detail === undefined ? {} : { detail }),
      },
    };
  }).sort((a, b) => b.score - a.score);
  const counts: Record<string, number> = {};
  for (const entry of ranked) counts[entry.item.severity] = (counts[entry.item.severity] ?? 0) + 1;
  const corroborated = ranked.filter((entry) => entry.item.reported_by.length > 1).length;
  const silent = reviewers.filter((role) => !all.some((finding) => finding.role === role));
  return withInvalid({
    reviewers: reviewers.length,
    reported: all.length,
    distinct: ranked.length,
    corroborated,
    by_severity: counts,
    findings: ranked.slice(0, options.max_items).map((entry) => entry.item),
    ...(ranked.length > options.max_items ? { findings_omitted: ranked.length - options.max_items } : {}),
    ...(silent.length === 0 ? {} : { no_findings_from: silent }),
    ...(unreadable.length === 0 ? {} : { unreadable: unreadable }),
  }, results);
}
