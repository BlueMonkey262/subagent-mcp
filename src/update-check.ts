import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UPDATE_URL = "https://api.github.com/repos/BlueMonkey262/subagent-mcp/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface UpdateCache {
  readonly checked_at: string;
  readonly current: string;
  readonly latest: string | null;
  readonly url: string | null;
  readonly available: boolean;
}

export interface UpdateCheckOptions {
  readonly memoryDirectory?: string;
  /** Alias for memoryDirectory. */
  readonly memoryDir?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxAgeMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the package version for callers that need a deterministic comparison. */
  readonly current?: string;
}

interface ParsedVersion {
  readonly numbers: readonly [number, number, number];
  readonly prerelease?: readonly string[];
}

/** Read this installation's package version from the package containing the compiled module. */
export function currentVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
    if (isRecord(parsed) && typeof parsed["version"] === "string") return parsed["version"];
  } catch {
    // An incomplete or unusual installation should not interfere with server startup.
  }
  return "0.0.0";
}

/** Compare major.minor.patch versions, including standard prerelease identifier ordering. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) throw new Error("Invalid semantic version");
  for (let index = 0; index < left.numbers.length; index += 1) {
    const difference = left.numbers[index]! - right.numbers[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (left.prerelease === undefined) return right.prerelease === undefined ? 0 : 1;
  if (right.prerelease === undefined) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Check GitHub for a newer stable release. All I/O and network failures are deliberately silent. */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCache | undefined> {
  const memoryDirectory = options.memoryDirectory ?? options.memoryDir;
  if (updateCheckDisabled(options.env)) {
    // Opting out also withdraws an old notice, so nothing keeps announcing it from a stale cache.
    if (memoryDirectory !== undefined) await rm(join(memoryDirectory, "update.json"), { force: true }).catch(() => undefined);
    return undefined;
  }
  if (memoryDirectory === undefined) return undefined;
  const cachePath = join(memoryDirectory, "update.json");
  const now = options.now?.() ?? Date.now();
  const previous = await readCache(cachePath);
  const running = normalizeVersion(options.current ?? currentVersion());
  const checkedAt = previous === undefined ? Number.NaN : Date.parse(previous.checked_at);
  // A cache computed for another version (the user just updated) must not keep announcing an old comparison.
  if (previous !== undefined && Number.isFinite(checkedAt) && previous.current === running
      && now - checkedAt >= 0 && now - checkedAt < (options.maxAgeMs ?? DAY_MS)) {
    return previous;
  }

  let temporaryPath: string | undefined;
  try {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Update check timed out"));
      }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    });
    let response: Response;
    let release: unknown = {};
    let noRelease = false;
    try {
      response = await Promise.race([
        (options.fetch ?? globalThis.fetch)(UPDATE_URL, {
          headers: { "User-Agent": "subagent-mcp-update-check" },
          signal: controller.signal,
        }),
        timedOut,
      ]);
      noRelease = response.status === 404;
      if (!response.ok && !noRelease) return previous;
      // The one deadline covers the body too (a server that sends headers and then stalls), and the body is capped.
      if (!noRelease) release = JSON.parse(await Promise.race([readCapped(response), timedOut]));
    } finally {
      clearTimeout(timer);
    }
    const current = running;
    if (current === undefined) return previous;
    if (!isRecord(release)) return previous;

    let latest: string | null = null;
    let url: string | null = null;
    if (!noRelease && release["draft"] !== true && release["prerelease"] !== true) {
      if (typeof release["tag_name"] !== "string" || typeof release["html_url"] !== "string") return previous;
      latest = normalizeVersion(release["tag_name"]) ?? null;
      if (latest === null) return previous;
      url = release["html_url"];
    }
    const result: UpdateCache = {
      checked_at: new Date(now).toISOString(),
      current,
      latest,
      url,
      available: latest !== null && compareVersions(latest, current) > 0,
    };

    await mkdir(memoryDirectory, { recursive: true });
    temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, cachePath);
    temporaryPath = undefined;
    return result;
  } catch {
    return previous;
  } finally {
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.SUBAGENT_MCP_UPDATE_CHECK?.trim().toLowerCase();
  return setting === "0" || setting === "false";
}

const MAX_BODY_BYTES = 256 * 1024;

async function readCapped(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Update response too large");
  return text;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return undefined;
  const prerelease = match[4]?.split(".");
  if (prerelease?.some((part) => part.length === 0)) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

function normalizeVersion(value: string): string | undefined {
  const parsed = parseVersion(value);
  if (parsed === undefined) return undefined;
  const base = parsed.numbers.join(".");
  return parsed.prerelease === undefined ? base : `${base}-${parsed.prerelease.join(".")}`;
}

async function readCache(path: string): Promise<UpdateCache | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)
        || typeof parsed["checked_at"] !== "string"
        || typeof parsed["current"] !== "string"
        || !(typeof parsed["latest"] === "string" || parsed["latest"] === null)
        || !(typeof parsed["url"] === "string" || parsed["url"] === null)
        || typeof parsed["available"] !== "boolean") return undefined;
    // `available` is derived, never trusted: a hand-edited or stale file cannot announce an older release.
    const latest = parsed["latest"] === null ? undefined : normalizeVersion(parsed["latest"]);
    const current = normalizeVersion(parsed["current"]);
    return {
      checked_at: parsed["checked_at"],
      current: parsed["current"],
      latest: parsed["latest"],
      url: parsed["url"],
      available: latest !== undefined && current !== undefined && compareVersions(latest, current) > 0,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
