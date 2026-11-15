import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { installRoot } from "../install-paths.js";

export const MODELS_FILE_ENV = "SUBAGENT_MCP_MODELS_FILE";
export const MODELS_FILE_CHECKED_ENV = "SUBAGENT_MCP_MODELS_FILE_CHECKED";
export const MODELS_FILE_NAME = "models.yaml";
export const MODELS_FILE_EXAMPLE_NAME = "models.yaml.example";

export type ModelsFileSource = "environment" | "project" | "install" | "missing";

export interface ModelsFileResolution {
  /** The file the server will load (or report as missing). */
  readonly path: string;
  readonly exists: boolean;
  readonly source: ModelsFileSource;
  /** Every path considered, in precedence order. */
  readonly checked: readonly string[];
}

export interface ResolveModelsFileOptions {
  /** Project directory the server was started in. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Environment to read `SUBAGENT_MCP_MODELS_FILE` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Install checkout to fall back to. Defaults to this package's root. */
  readonly installDirectory?: string;
}

/**
 * Resolve the model roster in one place: an explicit `SUBAGENT_MCP_MODELS_FILE` wins, then the
 * project's `.subagents/models.yaml`, then the install's own `.subagents/models.yaml`. The example
 * file is never a fallback; a missing roster is reported to the caller so it can run empty.
 */
export function resolveModelsFile(options: ResolveModelsFileOptions = {}): ModelsFileResolution {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const install = options.installDirectory ?? installRoot();
  const configured = env[MODELS_FILE_ENV];

  if (typeof configured === "string" && configured.trim() !== "") {
    const path = resolve(cwd, configured);
    return { path, exists: existsSync(path), source: "environment", checked: [path] };
  }

  const checked: string[] = [];
  const project = join(cwd, ".subagents", MODELS_FILE_NAME);
  checked.push(project);
  if (existsSync(project)) return { path: project, exists: true, source: "project", checked };

  const installed = join(install, ".subagents", MODELS_FILE_NAME);
  checked.push(installed);
  if (existsSync(installed)) return { path: installed, exists: true, source: "install", checked };

  return { path: project, exists: false, source: "missing", checked };
}

/** Paths the proxy checked, so the host can report them even though it only inherits the chosen path. */
export function parseModelsFileChecked(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The message list_models and spawn_agent show when no live roster exists. */
export function missingModelsFileMessage(checked: readonly string[]): string {
  return [
    "No models.yaml was found. Checked:",
    ...checked.map((path) => `- ${path}`),
    "",
    `Copy .subagents/${MODELS_FILE_EXAMPLE_NAME} to .subagents/${MODELS_FILE_NAME} and keep the model entries you actually use.`,
    "The example only shows the format for each backend; it is not a live roster.",
    "The server runs with an empty roster until a models.yaml exists: list_models shows no models and spawn_agent cannot select one.",
  ].join("\n");
}
