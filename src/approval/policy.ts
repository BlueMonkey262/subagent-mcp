import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { PermissionConfig } from "../config/schema.js";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";

export type PolicySource = "static_deny" | "session" | "static_allow" | "heuristic" | "default";

export interface PolicyEvaluation {
  readonly decision: Exclude<ApprovalDecision, "allow_for_session"> | "escalate";
  readonly source: PolicySource;
  readonly reason: string;
  readonly fingerprint: string;
}

export interface PolicyContext {
  readonly enforceDefault?: boolean;
  readonly sessionFingerprints?: ReadonlySet<string>;
  /** Glob-shaped rules synthesized from prior `allow_for_session` grants; see sessionRuleForRequest(). */
  readonly sessionRules?: ReadonlySet<string>;
}

/**
 * Denies always win. Explicit session/static grants are then honored. Dangerous requests
 * without an explicit grant park for the parent; child-provided `reason` is never inspected.
 *
 * Session grants are checked twice, deliberately on opposite sides of `dangerousReason()`: the
 * *exact* fingerprint match comes first (an operation identical byte-for-byte to one already
 * approved this session is trusted even if it looks dangerous, matching a static `permission.deny`
 * override). The *generalized* rule match — e.g. an `allow_for_session` on `git add file1.txt`
 * covering a later `git add file2.txt` — comes after, so a broadened session rule can never
 * bypass the sudo/recursive-delete/force-push/network/credential-path heuristics for a genuinely
 * different, dangerous-looking command that merely shares a prefix.
 */
export function evaluateApprovalPolicy(
  request: ApprovalRequest,
  permission: PermissionConfig,
  context: PolicyContext = {},
): PolicyEvaluation {
  const fingerprint = approvalFingerprint(request);
  const deniedBy = matchingRule(permission.deny, request);
  if (deniedBy !== undefined) {
    return { decision: "deny", source: "static_deny", reason: `Matched deny rule ${deniedBy}`, fingerprint };
  }
  if (context.sessionFingerprints?.has(fingerprint)) {
    return { decision: "allow", source: "session", reason: "Matched a parent-approved session rule", fingerprint };
  }
  const allowedBy = matchingRule(permission.allow, request);
  if (allowedBy !== undefined) {
    return { decision: "allow", source: "static_allow", reason: `Matched allow rule ${allowedBy}`, fingerprint };
  }
  const danger = dangerousReason(request);
  if (danger !== undefined) {
    return { decision: "escalate", source: "heuristic", reason: danger, fingerprint };
  }
  const sessionRule = context.sessionRules && matchingRule([...context.sessionRules], request);
  if (sessionRule !== undefined) {
    return { decision: "allow", source: "session", reason: `Matched a generalized session rule ${sessionRule}`, fingerprint };
  }
  if (!context.enforceDefault && isCheapWriteInsideCwd(request)) {
    return { decision: "allow", source: "heuristic", reason: "Write targets stay inside the agent cwd", fingerprint };
  }
  return {
    decision: permission.default,
    source: "default",
    reason: `Agent permission default is ${permission.default}`,
    fingerprint,
  };
}

/**
 * Generalizes a command-bearing approval into a reusable session rule, the same shape as a
 * static `permission.allow` entry (e.g. `Bash(git add:*)`), so `allow_for_session` covers the
 * next command sharing the same program + subcommand rather than only a byte-identical repeat.
 * Returns undefined for path-only requests (file changes with no command): there is no natural
 * verb prefix to generalize, so those stay on the exact-fingerprint path only.
 */
export function sessionRuleForRequest(request: ApprovalRequest): string | undefined {
  const command = normalizeCommand(request.command ?? stringField(request.input, "command"));
  if (command === undefined || command === "") return undefined;
  const tokens = command.split(" ").filter((token) => token !== "");
  const prefix = tokens.slice(0, Math.min(2, tokens.length)).join(" ");
  if (prefix === "") return undefined;
  return `${request.toolName}(${prefix}:*)`;
}

export function approvalFingerprint(request: ApprovalRequest): string {
  const operation = {
    backend: request.backend,
    toolName: request.toolName,
    cwd: resolve(request.cwd),
    command: normalizeCommand(request.command ?? stringField(request.input, "command")),
    paths: requestPaths(request).map((path) => resolve(request.cwd, path)).sort(),
    networkTargets: collectNetworkTargets(request.input).sort(),
  };
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

export function dangerousReason(request: ApprovalRequest): string | undefined {
  const command = request.command ?? stringField(request.input, "command") ?? "";
  if (/(^|[;&|]\s*|\s)sudo(?:\s|$)/i.test(command)) return "Command invokes sudo";
  if (isRecursiveForceRm(command)) return "Command performs recursive forced deletion";
  if (/\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease|-if-includes)?|(?:^|\s)-f(?:\s|$))/i.test(command)) {
    return "Command force-pushes Git history";
  }

  const inspected = [request.toolName, command, JSON.stringify(request.input), ...requestPaths(request)].join(" ");
  if (/(?:^|[\\/\s"'=])\.git(?:[\\/\s"'=]|$)/i.test(inspected)) return "Operation touches .git internals";
  if (/(?:^|[\\/\s"'=])\.claude(?:[\\/\s"'=]|$)/i.test(inspected)) return "Operation touches .claude configuration";
  if (containsCredentialPath(inspected)) return "Operation touches a credential-sensitive path";
  if (hasNetworkEgress(request, command)) return "Operation can perform network egress";

  if (isWriteLike(request.toolName)) {
    const paths = requestPaths(request);
    if (paths.length === 0) return "Write-like operation has no inspectable target path";
    const outside = paths.find((path) => !isWithin(request.cwd, path));
    if (outside !== undefined) return `Write target is outside cwd: ${outside}`;
  }
  if (shellMayWrite(command)) {
    const targets = extractShellWriteTargets(command);
    const outside = targets.find((path) => !isWithin(request.cwd, path));
    if (outside !== undefined) return `Command may write outside cwd: ${outside}`;
    if (targets.length === 0) return "Command may write but its target path could not be determined";
  }
  return undefined;
}

function matchingRule(rules: readonly string[], request: ApprovalRequest): string | undefined {
  return rules.find((rule) => ruleMatches(rule, request));
}

export function ruleMatches(rule: string, request: ApprovalRequest): boolean {
  const match = /^([^()]+?)(?:\((.*)\))?$/.exec(rule.trim());
  if (!match) return false;
  const toolPattern = match[1]?.trim() ?? "";
  if (!globMatches(toolPattern, request.toolName, false)) return false;
  const operationPattern = match[2];
  if (operationPattern === undefined) return true;
  const normalizedPattern = operationPattern.endsWith(":*")
    ? `${operationPattern.slice(0, -2)}*`
    : operationPattern;
  const candidates = operationCandidates(request);
  return candidates.some((candidate) => globMatches(normalizedPattern, candidate.value, candidate.pathLike));
}

interface OperationCandidate {
  readonly value: string;
  /** Path candidates use path-aware glob semantics; commands use flat wildcard matching. */
  readonly pathLike: boolean;
}

function operationCandidates(request: ApprovalRequest): readonly OperationCandidate[] {
  const candidates: OperationCandidate[] = requestPaths(request).map((value) => ({ value, pathLike: true }));
  const command = request.command ?? stringField(request.input, "command");
  if (command !== undefined) candidates.push({ value: command, pathLike: false });
  if (candidates.length === 0) candidates.push({ value: JSON.stringify(request.input), pathLike: false });
  return candidates;
}

/**
 * `*` never crosses a path separator; `**` does. Commands are matched as flat strings, since
 * Bash-style rules like `Bash(npm test*)` are not path components.
 */
function globMatches(pattern: string, value: string, pathLike: boolean): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        source += ".*";
      } else {
        source += pathLike ? "[^/]*" : ".*";
      }
    } else if (character === "?") {
      source += pathLike ? "[^/]" : ".";
    } else {
      source += escapeRegExp(character ?? "");
    }
  }
  return new RegExp(`^${source}$`).test(value);
}

function isCheapWriteInsideCwd(request: ApprovalRequest): boolean {
  if (!isWriteLike(request.toolName)) return false;
  const paths = requestPaths(request);
  return paths.length > 0 && paths.every((path) => isWithin(request.cwd, path));
}

function isWriteLike(toolName: string): boolean {
  return /^(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch|file_change)$/i.test(toolName);
}

function requestPaths(request: ApprovalRequest): string[] {
  const paths = [...(request.paths ?? [])];
  for (const key of ["path", "file_path", "filePath", "destination", "target", "notebook_path"]) {
    const value = request.input[key];
    if (typeof value === "string" && value !== "") paths.push(value);
  }
  return [...new Set(paths)];
}

function isWithin(cwd: string, candidate: string): boolean {
  const root = resolve(cwd);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function containsCredentialPath(text: string): boolean {
  return /(?:^|[\\/\s"'])(?:\.ssh|\.aws|\.gnupg|\.config[\\/](?:gcloud|gh)|credentials?|secrets?|\.env(?:\.[\w.-]+)?|id_(?:rsa|ed25519))(?:[\\/\s"']|$)/i.test(text);
}

function hasNetworkEgress(request: ApprovalRequest, command: string): boolean {
  if (/^(?:WebFetch|WebSearch|Http|Network)$/i.test(request.toolName)) return true;
  if (collectNetworkTargets(request.input).length > 0) return true;
  return /(?:^|[;&|]\s*|\s)(?:curl|wget|httpie|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp)(?:\s|$)/i.test(command)
    || /\b(?:npm|pnpm|yarn)\s+(?:install|add|publish|login)\b/i.test(command)
    || /\b(?:pip|pip3|cargo)\s+(?:install|publish|login)\b/i.test(command)
    || /\bgit\s+(?:clone|fetch|pull|push)\b/i.test(command)
    || /\bgh\s+(?:api|repo|pr|issue|release|workflow|run|auth)\b/i.test(command)
    || /\b(?:docker|podman)\s+(?:pull|push)\b/i.test(command);
}

/** GNU/BSD `rm` treats flags as order-independent and allows them before or after paths. */
function isRecursiveForceRm(command: string): boolean {
  const match = /\brm\b(.*)$/is.exec(command);
  if (!match) return false;
  const rest = match[1] ?? "";
  let hasRecursive = false;
  let hasForce = false;
  for (const token of rest.split(/\s+/)) {
    if (token === "--recursive") hasRecursive = true;
    else if (token === "--force") hasForce = true;
    else if (/^-[A-Za-z]+$/.test(token)) {
      if (/[rR]/.test(token)) hasRecursive = true;
      if (token.includes("f")) hasForce = true;
    }
  }
  return hasRecursive && hasForce;
}

/**
 * Collects redirection and write-command target arguments (relative or absolute) so outside-cwd
 * writes are caught even when expressed with a relative path like `../outside`.
 */
function extractShellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  for (const match of command.matchAll(/>>?\s*([^\s;&|<>]+)/g)) {
    if (match[1]) targets.push(stripQuotes(match[1]));
  }
  for (const match of command.matchAll(/\b(?:rm|mv|cp|touch|mkdir|install|tee|chmod|chown|truncate|dd)\b([^;&|]*)/gi)) {
    const rest = match[1] ?? "";
    for (const token of rest.split(/\s+/)) {
      if (token === "" || token.startsWith("-")) continue;
      const [, value] = /^(?:if|of)=(.*)$/.exec(token) ?? [undefined, token];
      targets.push(stripQuotes(value ?? token));
    }
  }
  return [...new Set(targets)].filter((value) => value !== "");
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function collectNetworkTargets(input: Readonly<Record<string, unknown>>): string[] {
  const targets: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && /^(?:url|uri|host|hostname|endpoint)$/i.test(key)) targets.push(value);
  }
  return targets;
}

function shellMayWrite(command: string): boolean {
  return /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|touch|mkdir|install|tee|chmod|chown|truncate|dd)(?:\s|$)/i.test(command)
    || /(?:^|[^>])>>?\s*\/?[^\s]+/.test(command);
}

function normalizeCommand(command: string | undefined): string | undefined {
  return command?.trim().replace(/\s+/g, " ");
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
