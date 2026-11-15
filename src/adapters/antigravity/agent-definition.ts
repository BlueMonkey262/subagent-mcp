import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";

import { SubagentError } from "../../core/errors.js";
import { installRoot } from "../../install-paths.js";

export const ANTIGRAVITY_AGENTS_DIRECTORY = join(".agents", "agents");

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
  /** Install checkout that ships the bundled `.example` templates. Defaults to this package's root. */
  readonly installDirectory?: string;
  /**
   * Copy a missing definition from its tracked `.example` template before reading it (default true).
   * Set false for a pure read-only resolution, such as an audit that must not create files.
   */
  readonly prepare?: boolean;
}

export interface AntigravityAgentResolver {
  resolve(input: ResolveAntigravityAgentInput): Promise<AntigravityAgentDefinition>;
}

export interface EnsureAntigravityAgentOptions {
  /** Directory `agy` will run in; project agent definitions live under it. */
  readonly cwd: string;
  /** Value of the config's `antigravityAgent` (the custom-agent name). */
  readonly name: string;
  /** Explicit `antigravityAgentFile`; the definition path `agy` will actually read. */
  readonly file?: string;
  /** Install checkout that ships the bundled `.example` templates. Defaults to this package's root. */
  readonly installDirectory?: string;
}

export interface EnsuredAntigravityAgent {
  /** The definition path `agy` reads: `<cwd>/.agents/agents/<name>.md` or the explicit `file`. */
  readonly path: string;
  /** The template that was copied, when a copy happened. */
  readonly copiedFrom?: string;
  readonly copied: boolean;
}

export class AntigravityAgentDefinitionError extends SubagentError {
  constructor(message: string, code: string, details?: Readonly<Record<string, unknown>>) {
    super(message, code, details);
  }
}

/**
 * `agy --agent <name>` reads `<cwd>/.agents/agents/<name>.md` (or the config's explicit
 * `antigravityAgentFile`) and cannot read the tracked `.example` template. When the real file is
 * missing, copy the project's template (or the install's bundled one) into place. Never overwrite
 * an existing file: the person's edits always win.
 */
export async function ensureAntigravityAgent(
  options: EnsureAntigravityAgentOptions,
): Promise<EnsuredAntigravityAgent> {
  const directory = join(options.cwd, ANTIGRAVITY_AGENTS_DIRECTORY);
  const path = options.file === undefined || options.file.trim() === ""
    ? join(directory, `${options.name}.md`)
    : expandHome(options.file, options.cwd);
  if (await exists(path)) return { path, copied: false };

  const install = options.installDirectory ?? installRoot();
  // The explicit target's own template comes first, then the project's by-name template, then the
  // install's bundled one. Deduplicate, because the default target repeats the project template.
  const examples = [...new Set([
    `${path}.example`,
    join(directory, `${options.name}.md.example`),
    join(install, ANTIGRAVITY_AGENTS_DIRECTORY, `${options.name}.md.example`),
  ])];
  for (const example of examples) {
    if (!await exists(example)) continue;
    await mkdir(dirname(path), { recursive: true });
    try {
      await copyFile(example, path, constants.COPYFILE_EXCL);
      return { path, copiedFrom: example, copied: true };
    } catch (error) {
      // Another process may have created it between the check and the copy; that file wins.
      if (isErrno(error, "EEXIST")) return { path, copied: false };
      throw error;
    }
  }
  return { path, copied: false };
}

/**
 * Resolve the real `agy --agent <name>` definition: explicit file, then project
 * `.agents/agents/<name>.md`, then the global `~/.gemini/agents/<name>.md`. The body is the
 * system prompt; frontmatter tools/permissions are native Antigravity policy, not bridge policy.
 *
 * A missing project definition is first seeded from its `.example` template (see
 * `ensureAntigravityAgent`), so a fresh checkout plus a copied agent config can spawn without a
 * manual copy step.
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

    if (input.prepare !== false) {
      const primary = candidates[0]!;
      // Only seed from a template when the first candidate is absent; an existing (possibly
      // mismatched) definition must be read and reported, never replaced.
      if (!await exists(primary.path)) {
        try {
          await ensureAntigravityAgent({
            cwd: input.cwd,
            name: input.name,
            ...(input.file === undefined ? {} : { file: input.file }),
            ...(input.installDirectory === undefined ? {} : { installDirectory: input.installDirectory }),
          });
        } catch (error) {
          throw new AntigravityAgentDefinitionError(
            `Unable to prepare Antigravity agent definition ${primary.path}: ${error instanceof Error ? error.message : String(error)}`,
            "ANTIGRAVITY_AGENT_INVALID",
            { path: primary.path },
          );
        }
      }
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
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
