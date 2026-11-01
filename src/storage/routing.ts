import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Backend } from "../core/types.js";
import { AppendOnlyJsonlStore } from "./jsonl.js";

export type MemoryScope = "project" | "user";

export interface ObservedSignals {
  readonly turnsUsed: number;
  readonly maxTurns?: number;
  readonly wallTimeMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly escalationCount: number;
  readonly timeoutCount: number;
  readonly errors: readonly string[];
}

export interface DelegationRecord {
  readonly kind: "delegation";
  readonly id: string;
  readonly recordedAt: string;
  readonly scope: MemoryScope;
  readonly backend: Backend;
  readonly model: string;
  /** Kept distinct from the friendly model name for recency/non-stationarity analysis. */
  readonly modelVersion: string;
  readonly agentConfig: string;
  readonly taskCategory?: string;
  readonly promptLength: number;
  readonly redelegated: boolean;
  readonly exploratory: boolean;
  readonly observed: ObservedSignals;
}

/** Subjective judgment is a separate record, never folded into observed execution signals. */
export interface OutcomeRecord {
  readonly kind: "outcome";
  readonly delegationId: string;
  readonly recordedAt: string;
  readonly scope: MemoryScope;
  readonly verdict: "success" | "partial" | "failure";
  readonly score?: number;
  readonly notes?: string;
}

export interface NoteRecord {
  readonly kind: "note";
  readonly recordedAt: string;
  readonly scope: MemoryScope;
  readonly text: string;
  readonly backend?: Backend;
  readonly modelVersion?: string;
}

export interface DirectWorkRecord {
  readonly kind: "direct_work";
  readonly recordedAt: string;
  readonly scope: "project";
  readonly tool: "Edit" | "Write";
  readonly path?: string;
}

export type RoutingRecord = DelegationRecord | OutcomeRecord | NoteRecord | DirectWorkRecord;

export interface RoutingPaths {
  readonly records: string;
  readonly digest: string;
}

export function projectRoutingPaths(projectRoot: string): RoutingPaths {
  const directory = join(projectRoot, ".subagents", "memory");
  return { records: join(directory, "records.jsonl"), digest: join(directory, "ROUTING.md") };
}

export function userRoutingPaths(userDataDirectory: string): RoutingPaths {
  const directory = join(userDataDirectory, "subagents", "memory");
  return { records: join(directory, "records.jsonl"), digest: join(directory, "ROUTING.md") };
}

export class RoutingStore {
  readonly #store: AppendOnlyJsonlStore<RoutingRecord>;

  constructor(readonly paths: RoutingPaths) {
    this.#store = new AppendOnlyJsonlStore(paths.records);
  }

  append(record: RoutingRecord): Promise<void> {
    validateRoutingRecord(record);
    return this.#store.append(record);
  }

  async records(): Promise<readonly RoutingRecord[]> {
    return (await this.#store.readAll()).map((entry) => entry.value);
  }

  async pendingOutcomeIds(): Promise<readonly string[]> {
    const records = await this.records();
    const completed = new Set(
      records.filter((record): record is OutcomeRecord => record.kind === "outcome").map((record) => record.delegationId),
    );
    return records
      .filter((record): record is DelegationRecord => record.kind === "delegation" && !completed.has(record.id))
      .map((record) => record.id);
  }
}

/** Project records contain prompts/paths and are ignored unless a project opts in to tracking them. */
export async function ensureProjectMemoryIgnored(projectRoot: string): Promise<void> {
  const gitignore = join(projectRoot, ".gitignore");
  const rule = ".subagents/memory/";
  let existing = "";
  try {
    existing = await readFile(gitignore, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await writeFile(gitignore, `${prefix}${rule}\n`, { encoding: "utf8", flag: "a" });
}

function validateRoutingRecord(record: RoutingRecord): void {
  if (record.kind === "delegation") {
    if (record.model.trim() === "" || record.modelVersion.trim() === "") {
      throw new TypeError("Delegation records require explicit model and modelVersion values");
    }
    if (!Number.isSafeInteger(record.promptLength) || record.promptLength < 0) {
      throw new TypeError("Delegation promptLength must be a non-negative integer");
    }
  }
  if (record.kind === "outcome" && record.score !== undefined && (!Number.isFinite(record.score) || record.score < 0 || record.score > 1)) {
    throw new TypeError("Outcome score must be between 0 and 1");
  }
}
