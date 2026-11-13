import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";

import { SubagentError } from "../../core/errors.js";

export type AntigravityDefinitionSource = "explicit" | "project" | "global";

/** The resolved Antigravity custom-agent definition whose body becomes the child's system prompt. */
export interface AntigravityAgentDefinition {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: AntigravityDefinitionSource;
  /** False when the definition lives outside the project and a resume would depend on that file. */
  readonly portable: boolean;
  readonly sha256: string;
  readonly body: string;
  /** Full file content, so the project can keep an exact audit copy. */
  readonly content: string;
  readonly description?: string;
  readonly tools?: readonly string[];
  readonly permission?: unknown;
  readonly mtimeMs?: number;
}

export interface ResolveAntigravityAgentInput {
  readonly name: string;
  /** From the agent config's `antigravityAgentFile`, relative to the project cwd or absolute. */
  readonly file?: string;
  readonly cwd: string;
  /** Test/installation override for the global `agy` agent directory. */
  readonly globalDirectory?: string;
}

export interface AntigravityAgentResolver {
  resolve(input: ResolveAntigravityAgentInput): Promise<AntigravityAgentDefinition>;
}

export class AntigravityAgentDefinitionError extends SubagentError {
  constructor(message: string, code: string, details?: Readonly<Record<string, unknown>>) {
    super(message, code, details);
  }
}

/**
 * Resolve the real `agy --agent <name>` definition: explicit file, then project
 * `.agents/agents/<name>.md`, then the global `~/.gemini/agents/<name>.md`. The body is the
 * system prompt; frontmatter tools/permissions are native Antigravity policy, not bridge policy.
 */
export class FileAntigravityAgentResolver implements AntigravityAgentResolver {
  async resolve(input: ResolveAntigravityAgentInput): Promise<AntigravityAgentDefinition> {
    const searched: string[] = [];
    const candidates: { path: string; source: AntigravityDefinitionSource }[] = [];
    if (input.file !== undefined && input.file.trim() !== "") {
      candidates.push({ path: expandHome(input.file, input.cwd), source: "explicit" });
    } else {
      candidates.push({ path: join(input.cwd, ".agents", "agents", `${input.name}.md`), source: "project" });
      candidates.push({
        path: join(input.globalDirectory ?? join(homedir(), ".gemini", "agents"), `${input.name}.md`),
        source: "global",
      });
    }

    for (const candidate of candidates) {
      searched.push(candidate.path);
      let text: string;
      let info;
      try {
        [text, info] = await Promise.all([readFile(candidate.path, "utf8"), stat(candidate.path)]);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw new AntigravityAgentDefinitionError(
          `Unable to read Antigravity agent definition ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
          "ANTIGRAVITY_AGENT_INVALID",
          { path: candidate.path, searched },
        );
      }
      const definition = parseDefinition(text, candidate.path, input.name);
      const portable = candidate.source === "project"
        || (candidate.source === "explicit" && !relative(input.cwd, candidate.path).startsWith(".."));
      return {
        ...definition,
        sourcePath: candidate.path,
        source: candidate.source,
        portable,
        sha256: createHash("sha256").update(text).digest("hex"),
        content: text,
        mtimeMs: info.mtimeMs,
      };
    }

    throw new AntigravityAgentDefinitionError(
      `Antigravity agent "${input.name}" was not found. Create ${join(input.cwd, ".agents", "agents", `${input.name}.md`)}, ` +
        `set antigravityAgentFile in the .subagents config, or install it in the global agy agent directory. ` +
        `Searched: ${searched.join(", ")}`,
      "ANTIGRAVITY_AGENT_NOT_FOUND",
      { name: input.name, searched },
    );
  }
}

function parseDefinition(text: string, path: string, expectedName: string): Omit<AntigravityAgentDefinition, "sourcePath" | "source" | "portable" | "sha256" | "content" | "mtimeMs"> {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new AntigravityAgentDefinitionError(
      `${path}: expected YAML frontmatter delimited by ---`,
      "ANTIGRAVITY_AGENT_INVALID",
      { path },
    );
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1] ?? "");
  } catch (error) {
    throw new AntigravityAgentDefinitionError(
      `${path}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      "ANTIGRAVITY_AGENT_INVALID",
      { path },
    );
  }
  if (!isRecord(frontmatter)) {
    throw new AntigravityAgentDefinitionError(`${path}: frontmatter must be an object`, "ANTIGRAVITY_AGENT_INVALID", { path });
  }
  const name = frontmatter["name"];
  const fileBase = basename(path, ".md");
  if (typeof name !== "string" || name.trim() === "") {
    throw new AntigravityAgentDefinitionError(`${path}: frontmatter must set a non-empty name`, "ANTIGRAVITY_AGENT_INVALID", { path });
  }
  if (name !== expectedName || fileBase !== expectedName) {
    throw new AntigravityAgentDefinitionError(
      `${path}: Antigravity agent name "${name}" (file "${fileBase}") does not match configured antigravityAgent "${expectedName}"`,
      "ANTIGRAVITY_AGENT_INVALID",
      { path, expectedName, actualName: name, fileBase },
    );
  }
  const tools = Array.isArray(frontmatter["tools"])
    ? frontmatter["tools"].filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    name,
    body: (match[2] ?? "").replace(/^\r?\n/, ""),
    ...(typeof frontmatter["description"] === "string" ? { description: frontmatter["description"] } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(frontmatter["permission"] === undefined ? {} : { permission: frontmatter["permission"] }),
  };
}

function expandHome(value: string, cwd: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
