import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureProjectMemoryIgnored, projectRoutingPaths, RoutingStore } from "../src/storage/routing.js";

test("routing records append in order and observed outcomes stay separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-"));
  const store = new RoutingStore(projectRoutingPaths(root));
  await Promise.all([
    store.append({
      kind: "delegation",
      id: "d1",
      recordedAt: "2026-09-04T00:00:00Z",
      scope: "project",
      backend: "codex",
      model: "gpt-5.6-luna",
      modelVersion: "gpt-5.6-luna-2026-08-15",
      agentConfig: "reviewer",
      promptLength: 100,
      redelegated: false,
      exploratory: false,
      observed: { turnsUsed: 2, wallTimeMs: 10, escalationCount: 0, timeoutCount: 0, errors: [] },
    }),
    store.append({ kind: "note", recordedAt: "2026-09-04T00:00:01Z", scope: "project", text: "Useful" }),
  ]);
  assert.deepEqual(await store.pendingOutcomeIds(), ["d1"]);
  await store.append({
    kind: "outcome",
    delegationId: "d1",
    recordedAt: "2026-09-04T00:01:00Z",
    scope: "project",
    verdict: "success",
    score: 0.9,
  });
  assert.deepEqual(await store.pendingOutcomeIds(), []);
  assert.deepEqual((await store.records()).map((record) => record.kind), ["delegation", "note", "outcome"]);
});

test("project routing memory is gitignored idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-ignore-"));
  await ensureProjectMemoryIgnored(root);
  await ensureProjectMemoryIgnored(root);
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), ".subagents/memory/\n");
});
