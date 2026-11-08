import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkForUpdate, compareVersions, currentVersion, type UpdateCache } from "../src/update-check.js";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function release(tag: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    html_url: `https://github.com/BlueMonkey262/subagent-mcp/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

async function withMemory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "subagent-update-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function putCache(directory: string, cache: UpdateCache): Promise<void> {
  await writeFile(join(directory, "update.json"), JSON.stringify(cache));
}

test("currentVersion reads the package version and semantic versions compare numerically", () => {
  assert.equal(currentVersion(), "0.1.0");
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.2.3-beta.1", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3-beta.2", "1.2.3-beta.10"), -1);
});

test("a fresh cache is returned without fetching, while a stale cache is refreshed", async () => {
  await withMemory(async (directory) => {
    const cached: UpdateCache = {
      checked_at: new Date(NOW - 999).toISOString(),
      current: "0.1.0",
      latest: null,
      url: null,
      available: false,
    };
    await putCache(directory, cached);
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return response(release("v0.2.0"));
    };
    assert.deepEqual(await checkForUpdate({
      memoryDirectory: directory, fetch: fetcher as typeof fetch, now: () => NOW, maxAgeMs: 1_000, current: "0.1.0",
    }), cached);
    assert.equal(calls, 0);

    const updated = await checkForUpdate({
      memoryDirectory: directory, fetch: fetcher as typeof fetch, now: () => NOW, maxAgeMs: 500, current: "0.1.0",
    });
    assert.equal(calls, 1);
    assert.deepEqual(updated, {
      checked_at: new Date(NOW).toISOString(),
      current: "0.1.0",
      latest: "0.2.0",
      url: "https://github.com/BlueMonkey262/subagent-mcp/releases/tag/v0.2.0",
      available: true,
    });
  });
});

test("the environment opt-out skips cache and network access entirely", async () => {
  await withMemory(async (directory) => {
    let calls = 0;
    const result = await checkForUpdate({
      memoryDirectory: directory,
      env: { SUBAGENT_MCP_UPDATE_CHECK: "false" },
      fetch: (async () => { calls += 1; return response(release("1.0.0")); }) as typeof fetch,
    });
    assert.equal(result, undefined);
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("offline, non-200, and malformed JSON failures stay silent", async () => {
  await withMemory(async (directory) => {
    const failures: Array<typeof fetch> = [
      (async () => { throw new Error("offline"); }) as typeof fetch,
      (async () => response({ message: "rate limited" }, 403)) as typeof fetch,
      (async () => response("not json")) as typeof fetch,
    ];
    for (const fetcher of failures) {
      assert.equal(await checkForUpdate({ memoryDirectory: directory, fetch: fetcher, now: () => NOW }), undefined);
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test("a fetch that ignores abort still observes the configured timeout", async () => {
  await withMemory(async (directory) => {
    const started = Date.now();
    const result = await checkForUpdate({
      memoryDirectory: directory,
      timeoutMs: 10,
      fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    });
    assert.equal(result, undefined);
    assert.ok(Date.now() - started < 1_000);
  });
});

test("draft and prerelease responses are ignored and cached as no stable release", async () => {
  for (const ignored of [{ draft: true }, { prerelease: true }]) {
    await withMemory(async (directory) => {
      const result = await checkForUpdate({
        memoryDirectory: directory,
        current: "0.1.0",
        now: () => NOW,
        fetch: (async () => response(release("v9.0.0-beta.1", ignored))) as typeof fetch,
      });
      assert.deepEqual(result, {
        checked_at: new Date(NOW).toISOString(), current: "0.1.0", latest: null, url: null, available: false,
      });
      assert.deepEqual(JSON.parse(await readFile(join(directory, "update.json"), "utf8")), result);
    });
  }
});

test("available is true only for a strictly newer release", async () => {
  for (const [tag, available] of [["0.2.0", true], ["0.1.0", false], ["0.0.9", false]] as const) {
    await withMemory(async (directory) => {
      const result = await checkForUpdate({
        memoryDirectory: directory,
        current: "0.1.0",
        now: () => NOW,
        fetch: (async () => response(release(tag))) as typeof fetch,
      });
      assert.equal(result?.available, available);
    });
  }
});

test("cache replacement is atomic and leaves no temporary file", async () => {
  await withMemory(async (directory) => {
    await putCache(directory, {
      checked_at: new Date(0).toISOString(), current: "0.1.0", latest: null, url: null, available: false,
    });
    const result = await checkForUpdate({
      memoryDirectory: directory,
      current: "0.1.0",
      now: () => NOW,
      fetch: (async (_input, init) => {
        assert.equal((init?.headers as Record<string, string>)["User-Agent"], "subagent-mcp-update-check");
        return response(release("0.2.0"));
      }) as typeof fetch,
    });
    assert.deepEqual(await readdir(directory), ["update.json"]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "update.json"), "utf8")), result);
  });
});

test("a stale cache is returned unchanged when its refresh fails", async () => {
  await withMemory(async (directory) => {
    const old: UpdateCache = {
      checked_at: new Date(0).toISOString(),
      current: "0.0.9",
      latest: "0.1.0",
      url: "https://example.test/old",
      available: true,
    };
    await putCache(directory, old);
    const result = await checkForUpdate({
      memoryDirectory: directory,
      fetch: (async () => response({ message: "server error" }, 500)) as typeof fetch,
      now: () => NOW,
    });
    assert.deepEqual(result, old);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "update.json"), "utf8")), old);
  });
});

test("a fresh cache computed for another version is refetched (the user just updated)", async () => {
  await withMemory(async (directory) => {
    await putCache(directory, {
      checked_at: new Date(NOW - 60_000).toISOString(), current: "0.1.0", latest: "0.2.0",
      url: "https://example.test/r", available: true,
    });
    let calls = 0;
    const result = await checkForUpdate({
      memoryDirectory: directory, now: () => NOW, current: "0.2.0", env: {},
      fetch: async () => { calls += 1; return response(release("v0.2.0")); },
    });
    assert.equal(calls, 1);
    assert.equal(result?.available, false);
    assert.equal(result?.current, "0.2.0");
  });
});

test("no release published yet (404) is cached as no update, so it is not rechecked on every start", async () => {
  await withMemory(async (directory) => {
    let calls = 0;
    const fetchNone = async () => { calls += 1; return response({ message: "Not Found" }, 404); };
    const first = await checkForUpdate({ memoryDirectory: directory, now: () => NOW, current: "0.1.0", env: {}, fetch: fetchNone });
    assert.deepEqual([first?.available, first?.latest, first?.url], [false, null, null]);
    await checkForUpdate({ memoryDirectory: directory, now: () => NOW + 1_000, current: "0.1.0", env: {}, fetch: fetchNone });
    assert.equal(calls, 1);
    const other = await checkForUpdate({
      memoryDirectory: directory, now: () => NOW + 2_000, current: "0.1.0", env: {},
      fetch: async () => response({ message: "boom" }, 500),
    });
    assert.equal(other?.available, false, "a 5xx keeps the cached answer");
  });
});
