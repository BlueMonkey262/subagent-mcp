import { constants } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { installRoot } from "../../install-paths.js";

export const ANTIGRAVITY_AGENTS_DIRECTORY = join(".agents", "agents");

export interface EnsureAntigravityAgentOptions {
  /** Directory `agy` will run in; project agent definitions live under it. */
  readonly cwd: string;
  /** Value of the config's `antigravityAgent` (the custom-agent name). */
  readonly name: string;
  /** Install checkout that ships the bundled `.example` templates. Defaults to this package's root. */
  readonly installDirectory?: string;
}

export interface EnsuredAntigravityAgent {
  /** `<cwd>/.agents/agents/<name>.md`, the path `agy --agent <name>` reads. */
  readonly path: string;
  /** The template that was copied, when a copy happened. */
  readonly copiedFrom?: string;
  readonly copied: boolean;
}

/**
 * `agy --agent <name>` reads `<cwd>/.agents/agents/<name>.md` and cannot read the tracked
 * `.example` template. When the real file is missing, copy the project's template (or the
 * install's bundled one) into place. Never overwrite an existing file.
 */
export async function ensureAntigravityAgent(
  options: EnsureAntigravityAgentOptions,
): Promise<EnsuredAntigravityAgent> {
  const directory = join(options.cwd, ANTIGRAVITY_AGENTS_DIRECTORY);
  const path = join(directory, `${options.name}.md`);
  if (await exists(path)) return { path, copied: false };

  const examples = [
    join(directory, `${options.name}.md.example`),
    join(options.installDirectory ?? installRoot(), ANTIGRAVITY_AGENTS_DIRECTORY, `${options.name}.md.example`),
  ];
  for (const example of examples) {
    if (!await exists(example)) continue;
    await mkdir(directory, { recursive: true });
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
