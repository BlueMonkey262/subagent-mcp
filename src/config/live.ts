import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";

import { ConfigurationError } from "../core/errors.js";
import {
  CODEX_RESUME_IDLE_ENV,
  MAX_CONCURRENT_ENV,
  readPositiveIntEnv,
} from "../core/limits.js";
import type { Backend } from "../core/types.js";
import {
  ConfigRegistry,
  loadConfigRegistry,
  type AgentConfigSource,
  type RegistryLoadOptions,
  type ResolveAgentOptions,
} from "./registry.js";
import type { Allowance, ModelEntry, ResolvedAgentConfig } from "./schema.js";
import { applyPolicyEnv, OPEN_POLICY, type ModelPolicy } from "../core/model-policy.js";

export function missingConfigMessage(input: {
  readonly agentsDirectory: string;
  readonly modelsFile: string;
  readonly cause?: string;
}): string {
  const lead = input.cause === undefined
    ? "subagent-mcp has no config loaded."
    : `subagent-mcp could not load its config: ${input.cause}`;
  return [
    lead,
    "",
    "Create both of these in the project directory this server was started in:",
    `1. ${input.modelsFile}`,
    "   A YAML roster of models spawn_agent is allowed to use. Example:",
    "   models:",
    "     claude:",
    "       - name: claude-sonnet-5",
    "     codex:",
    "       - name: gpt-5.6-sol",
    "     opencode: []",
    "     antigravity: []",
    "     cursor: []",
    "     copilot: []",
    `2. ${input.agentsDirectory}/<name>.md`,
    "   One file per agent. The frontmatter name must match the filename. Example general.md:",
    "   ---",
    "   name: general",
    "   backend: claude",
    "   description: General-purpose subagent",
    "   permission:",
    "     default: escalate",
    "   ---",
    "   Do the delegated work and report what you verified.",
    "",
    "After those files are saved, ask the user to run `/mcp` and then reconnect subagent-mcp.",
  ].join("\n");
}

/**
 * Config viewed by the supervisor. Reloads when the roster or agent files change so a roster
 * edit does not require an MCP reconnect. A failed reload keeps the last good registry for
 * listing, while the supervisor refuses execution until a valid reload clears the warning.
 */
export class LiveConfig implements AgentConfigSource {
  #registry: ConfigRegistry | undefined;
  #error: string | undefined;
  #warning: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #watchers: FSWatcher[] = [];
  #onChange: (() => void) | undefined;

  constructor(private readonly options: RegistryLoadOptions) {}

  async reload(): Promise<void> {
    try {
      const registry = await loadConfigRegistry(this.options);
      if (registry.listAgents().length === 0) {
        throw new ConfigurationError(`No agent configs were found in ${this.options.agentsDirectory}`);
      }
      this.#registry = registry;
      this.#error = undefined;
      this.#warning = undefined;
    } catch (error) {
      const message = missingConfigMessage({
        agentsDirectory: this.options.agentsDirectory,
        modelsFile: this.options.modelsFile,
        cause: error instanceof Error ? error.message : String(error),
      });
      if (this.#registry === undefined) this.#error = message;
      else this.#warning = message;
    }
    this.#onChange?.();
  }

  /** Watch the agent directory and model roster. Creating either path is picked up too. */
  watch(onChange?: () => void): void {
    if (onChange !== undefined) this.#onChange = onChange;
    this.#arm();
  }

  close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#closeWatchers();
  }

  hasConfig(): boolean {
    return this.#registry !== undefined;
  }

  listAgents() { return this.#require().listAgents(); }

  resolveAgent(options: ResolveAgentOptions): ResolvedAgentConfig {
    return this.#require().resolveAgent(options);
  }

  listModels(backend?: Backend): Readonly<Record<Backend, readonly ModelEntry[]>> | readonly ModelEntry[] {
    return this.#require().listModels(backend);
  }

  maxConcurrent(): number {
    return readPositiveIntEnv(process.env, MAX_CONCURRENT_ENV)
      ?? this.#registry?.maxConcurrent()
      ?? new ConfigRegistry([], emptyRoster()).maxConcurrent();
  }

  codexResumeIdleMs(): number {
    const seconds = readPositiveIntEnv(process.env, CODEX_RESUME_IDLE_ENV);
    if (seconds !== undefined) return seconds * 1000;
    return this.#registry?.codexResumeIdleMs() ?? new ConfigRegistry([], emptyRoster()).codexResumeIdleMs();
  }

  allowances(): Readonly<Partial<Record<Backend, Allowance>>> {
    return this.#registry?.allowances() ?? {};
  }

  /** The project's policy with the MCP server's environment applied, so one setting can cover every project. */
  modelPolicy(): ModelPolicy {
    return applyPolicyEnv(this.#registry?.modelPolicy() ?? OPEN_POLICY);
  }

  configWarning(): string | undefined {
    return this.#warning;
  }

  #require(): ConfigRegistry {
    if (this.#registry === undefined) {
      throw new ConfigurationError(this.#error ?? missingConfigMessage(this.options));
    }
    return this.#registry;
  }

  #arm(): void {
    this.#closeWatchers();
    const onEvent = (): void => this.#schedule();
    this.#watch(this.options.agentsDirectory, dirname(this.options.agentsDirectory), onEvent);
    this.#watch(this.options.modelsFile, dirname(this.options.modelsFile), onEvent);
  }

  #watch(target: string, fallback: string, onEvent: () => void): void {
    try {
      this.#watchers.push(watch(target, { persistent: false }, onEvent));
    } catch {
      try {
        this.#watchers.push(watch(fallback, { persistent: false }, onEvent));
      } catch {
        // The directory may not exist yet. The next successful arm retries.
      }
    }
  }

  #schedule(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.reload().finally(() => this.#arm());
    }, 100);
    this.#timer.unref();
  }

  #closeWatchers(): void {
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
  }
}

function emptyRoster(): ConfigRegistry["roster"] {
  return { claude: [], codex: [], opencode: [], antigravity: [], cursor: [], copilot: [] };
}
