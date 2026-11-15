import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { formatChannelEvent, formatEnsembleEvent } from "../src/channel.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentConfig } from "../src/config/schema.js";
import { aggregate, normalizeLocation } from "../src/ensemble/aggregators.js";
import { extractJson, fitToBudget } from "../src/ensemble/budget.js";
import { loadProfiles, resolveSpec } from "../src/ensemble/config.js";
import { EnsembleManager } from "../src/ensemble/manager.js";
import type { AggregationSpec, MemberResult } from "../src/ensemble/types.js";
import { Supervisor } from "../src/supervisor.js";

const permission = { allow: [], deny: [], default: "escalate" as const };
const config = (name: string, backend: AgentConfig["backend"]): AgentConfig =>
  ({ name, backend, description: name, systemPrompt: "", permission, env: {}, sourcePath: `/configs/${name}.md` });

function fixture(options: { maxConcurrent?: number; directory?: string; supervisorPath?: string } = {}) {
  const codex = new FakeAdapter("codex");
  const opencode = new FakeAdapter("opencode");
  const registry = new ConfigRegistry([config("codex-general", "codex"), config("opencode-general", "opencode")], {
    claude: [], codex: [{ name: "sol" }, { name: "luna" }], opencode: [{ name: "provider/a" }], antigravity: [], cursor: [], copilot: [], vibe: [],
  });
  const detached: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let manager: EnsembleManager | undefined;
  const supervisor = new Supervisor({
    registry, adapters: new AdapterRegistry([codex, opencode]), cwd: "/repo", maxConcurrent: options.maxConcurrent ?? 6,
    onDetachedSettled: (result) => { if (manager?.routeDetached(result) !== true) detached.push({ ...result }); },
  });
  if (options.supervisorPath) supervisor.enablePersistence(options.supervisorPath);
  manager = new EnsembleManager({
    supervisor, cwd: "/repo", launchWaitMs: 200,
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    profileSources: [],
    onSettled: (event) => events.push({ ...event }),
  });
  return { codex, opencode, supervisor, manager, detached, events };
}

const roster = [
  { role: "correctness", config: "codex-general", model: "sol" },
  { role: "concurrency", config: "opencode-general", model: "provider/a" },
  { role: "quick", config: "codex-general", model: "luna" },
];

async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function memberIds(manager: EnsembleManager, id: string) {
  return manager.get({ ensemble: id, detail: "members" }).then((view) =>
    (view.members as { role: string; agent_id: string; backend: string }[]));
}

function complete(adapter: FakeAdapter, agentId: string, text: string, usage?: Record<string, number>) {
  adapter.emit(agentId, "turn.completed", { turnId: `${agentId}-t`, status: "completed", finalText: text, ...(usage ? { usage } : {}) });
}

test("one call launches every member; children are suppressed and one ensemble event carries the aggregate", async () => {
  const f = fixture();
  const started = await f.manager.start({ name: "review", task: "Review the diff", agents: roster });
  assert.equal(started.status, "running");
  assert.equal(started.agents_started, 3);
  assert.equal(f.codex.spawnRequests.length + f.opencode.spawnRequests.length, 3);
  assert.match(f.codex.spawnRequests[0]!.prompt, /Review the diff[\s\S]*"correctness" member/);
  const members = await memberIds(f.manager, String(started.ensemble_id));
  for (const member of members) {
    const adapter = member.backend === "codex" ? f.codex : f.opencode;
    complete(adapter, member.agent_id, `report from ${member.role}`, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  }
  await until(() => f.events.length === 1);
  assert.equal(f.detached.length, 0, "member notifications are consumed by the ensemble");
  const event = f.events[0]!;
  assert.equal(event.status, "completed");
  const summary = event.summary as Record<string, unknown>;
  assert.equal(summary.valid, 3);
  assert.deepEqual(summary.usage, { cost_usd: 0.03, tokens: 45 });
  assert.ok(JSON.stringify(summary).length <= 1600);
  const items = (summary.aggregate as { items: { role: string; result: string }[] }).items;
  assert.deepEqual(items.map((item) => item.role).sort(), ["concurrency", "correctness", "quick"]);
  // Re-aggregation and per-member detail are on demand.
  const detail = await f.manager.get({ ensemble: "review", role: "quick" });
  assert.equal(detail.result, "report from quick");
  const channel = formatEnsembleEvent(event);
  assert.equal(channel.meta.kind, "ensemble");
  assert.equal(channel.meta.status, "completed");
});

test("a bad member refuses the whole ensemble before anything launches", async () => {
  const f = fixture();
  await assert.rejects(f.manager.start({ task: "t", agents: [roster[0]!, { role: "bad", config: "codex-general", model: "nope" }] }),
    /agents\[1\] \(bad\).*Unknown model/);
  assert.equal(f.codex.spawnRequests.length, 0);
});

test("first_valid finalizes on the first valid result and leaves the rest running unless cancel_remaining", async () => {
  const f = fixture();
  const started = await f.manager.start({ task: "t", agents: roster.slice(0, 2), completion: { strategy: "first_valid" } });
  const [first, second] = await memberIds(f.manager, String(started.ensemble_id));
  complete(f.codex, first!.agent_id, "");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.events.length, 0, "an empty result is not valid");
  complete(f.opencode, second!.agent_id, "answer");
  await until(() => f.events.length === 1);
  assert.equal(f.events[0]!.status, "completed");

  const g = fixture();
  const other = await g.manager.start({ task: "t", agents: roster, completion: { strategy: "first_valid", cancel_remaining: true } });
  const ids = await memberIds(g.manager, String(other.ensemble_id));
  complete(g.codex, ids[0]!.agent_id, "fast answer");
  await until(() => g.events.length === 1);
  await until(() => g.supervisor.outcome(ids[2]!.agent_id).state === "interrupted");
  assert.equal(g.supervisor.outcome(ids[1]!.agent_id).state, "interrupted");
});

test("quorum finalizes early as partial once it can no longer be reached", async () => {
  const f = fixture();
  const started = await f.manager.start({ task: "t", agents: roster, completion: { strategy: "quorum", quorum: 3 } });
  const ids = await memberIds(f.manager, String(started.ensemble_id));
  complete(f.codex, ids[0]!.agent_id, "yes");
  f.opencode.emit(ids[1]!.agent_id, "turn.completed", { turnId: "x", status: "failed" });
  await until(() => f.events.length === 1);
  assert.equal(f.events[0]!.status, "partial");
  assert.equal(f.events[0]!.reason, "quorum_unreachable");
});

test("structured results: fenced JSON is recovered, mismatches are not counted", async () => {
  const f = fixture();
  const started = await f.manager.start({
    task: "Classify", agents: roster, aggregation: { strategy: "vote", choices: ["safe", "unsafe"] },
  });
  const ids = await memberIds(f.manager, String(started.ensemble_id));
  complete(f.codex, ids[0]!.agent_id, '{"answer":"safe","rationale":"ok"}');
  complete(f.opencode, ids[1]!.agent_id, 'Here you go:\n```json\n{"answer":"safe"}\n```');
  complete(f.codex, ids[2]!.agent_id, '{"answer":"maybe"}');
  await until(() => f.events.length === 1);
  const summary = f.events[0]!.summary as Record<string, unknown>;
  assert.equal(f.events[0]!.status, "partial");
  const votes = summary.aggregate as Record<string, unknown>;
  assert.equal(votes.leader, "safe");
  assert.equal(votes.cast, 2);
  assert.equal((votes.abstentions as unknown[]).length, 1);
  const members = await f.manager.get({ ensemble: String(started.ensemble_id), detail: "members" });
  assert.deepEqual((members.members as { value_source?: string }[]).map((member) => member.value_source), ["structured", "recovered", undefined]);
});

test("approvals pass through with ensemble attribution and resolving one does not block on the member", async () => {
  const f = fixture();
  const started = await f.manager.start({ task: "t", agents: roster.slice(0, 1) });
  const [member] = await memberIds(f.manager, String(started.ensemble_id));
  f.codex.emit(member!.agent_id, "approval.requested", {
    requestId: "req-1", agentId: member!.agent_id, backend: "codex", toolName: "Bash", command: "rm -rf build",
    input: { command: "rm -rf build" }, cwd: "/repo", requestedAt: new Date().toISOString(),
  });
  await until(() => f.detached.length === 1);
  assert.equal(f.detached[0]!.status, "needs_approval");
  assert.equal(f.detached[0]!.ensemble_id, started.ensemble_id);
  assert.match(formatChannelEvent(f.detached[0]!).content, /Member "correctness" of ensemble/);
  const waiting = await f.manager.get({ ensemble: String(started.ensemble_id), wait_seconds: 1 });
  assert.equal((waiting.pending_approvals as { request_id: string }[])[0]!.request_id, "req-1");
  const resolved = await f.supervisor.resolveApproval("req-1", "allow");
  assert.equal(resolved.status, "running");
  complete(f.codex, member!.agent_id, "done");
  await until(() => f.events.length === 1);
  assert.equal(f.detached.length, 1, "the completion is consolidated, not sent per member");
});

test("cancel stops members and finalizes as cancelled with the results so far", async () => {
  const f = fixture();
  const started = await f.manager.start({ task: "t", agents: roster });
  const ids = await memberIds(f.manager, String(started.ensemble_id));
  complete(f.codex, ids[0]!.agent_id, "partial work");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelled = await f.manager.cancel(String(started.ensemble_id));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.valid, 1);
  assert.equal(f.supervisor.outcome(ids[1]!.agent_id).state, "interrupted");
});

test("deadline finalizes with what is available", async () => {
  const f = fixture();
  const started = await f.manager.start({ task: "t", agents: roster.slice(0, 2), completion: { strategy: "deadline", deadline_seconds: 1 } });
  const ids = await memberIds(f.manager, String(started.ensemble_id));
  complete(f.codex, ids[0]!.agent_id, "in time");
  const final = await f.manager.get({ ensemble: String(started.ensemble_id), wait_seconds: 3 });
  assert.equal(final.status, "partial");
  assert.equal(final.reason, "deadline");
  assert.equal(final.still_running, 1);
});

test("pipeline members start after their predecessor succeeds and receive its result", async () => {
  const f = fixture();
  const started = await f.manager.start({ task: "Fix and verify", mode: "pipeline", agents: [
    { role: "implementer", config: "codex-general", model: "sol" },
    { role: "verifier", config: "opencode-general", model: "provider/a" },
  ] });
  assert.equal(f.opencode.spawnRequests.length, 0);
  const [implementer] = await memberIds(f.manager, String(started.ensemble_id));
  complete(f.codex, implementer!.agent_id, "patched foo.ts");
  await until(() => f.opencode.spawnRequests.length === 1);
  assert.match(f.opencode.spawnRequests[0]!.prompt, /patched foo\.ts/);
  const members = await memberIds(f.manager, String(started.ensemble_id));
  assert.match(members[1]!.agent_id, /^fake-opencode/);
  complete(f.opencode, members[1]!.agent_id, "verified");
  await until(() => f.events.length === 1);
  assert.equal(f.events[0]!.status, "completed");
});

test("an identical running ensemble is returned instead of launched twice", async () => {
  const f = fixture();
  const first = await f.manager.start({ task: "t", agents: roster.slice(0, 1) });
  const again = await f.manager.start({ task: "t", agents: roster.slice(0, 1) });
  assert.equal(again.ensemble_id, first.ensemble_id);
  assert.equal(again.deduplicated, true);
  assert.equal(f.codex.spawnRequests.length, 1);
});

test("restore adopts members that launched and never relaunches an unrecorded one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensembles-"));
  const sessions = join(directory, "sessions.json");
  const f = fixture({ directory, supervisorPath: sessions });
  const started = await f.manager.start({ task: "t", agents: roster.slice(0, 2) });
  const id = String(started.ensemble_id);
  // Simulate a crash between the spawn and recording it: forget member 0's id, mark member 1 mid-launch.
  const path = join(directory, `${id}.json`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const saved = JSON.parse(await readFile(path, "utf8"));
  delete saved.members[0].agent_id; saved.members[0].launch = "launching";
  delete saved.members[1].agent_id; saved.members[1].launch = "launching";
  // Member 1 never reached the supervisor: drop it from the supervisor snapshot.
  const snapshot = f.supervisor.exportSnapshot().filter((agent) => agent.meta?.ensemble?.role !== "concurrency");
  await writeFile(path, JSON.stringify(saved));
  f.manager.close();

  const g = fixture({ directory });
  g.supervisor.restore(snapshot);
  await g.manager.restore();
  const view = await g.manager.get({ ensemble: id, detail: "members" });
  const members = view.members as { launch: string; agent_id?: string; state: string; error?: string }[];
  assert.equal(members[0]!.launch, "launched");
  assert.ok(members[0]!.agent_id);
  assert.equal(members[1]!.launch, "failed");
  assert.match(members[1]!.error ?? "", /not relaunched/);
  assert.equal(g.codex.spawnRequests.length + g.opencode.spawnRequests.length, 0);
  const final = await g.manager.get({ ensemble: id });
  assert.equal(final.status, "interrupted");
});

test("review_findings merges corroborated findings conservatively and ranks by severity", () => {
  const results: MemberResult[] = [
    { role: "a", state: "completed", valid: true, value: { findings: [
      { title: "Race on capacity counter release", severity: "high", file: "src/supervisor.ts", line: 120 },
      { title: "Typo in log message", severity: "low", file: "src/host.ts", line: 9 },
    ] } },
    { role: "b", state: "completed", valid: true, value: { findings: [
      { title: "capacity release race when turn completes", severity: "critical", file: "/repo/src/supervisor.ts:122" },
    ] } },
    { role: "c", state: "completed", valid: true, value: { findings: [] } },
    { role: "d", state: "failed", valid: false, reason: "TIMEOUT" },
  ];
  const options: AggregationSpec = { strategy: "review_findings", max_items: 5 };
  const result = aggregate(results, options, { cwd: "/repo" }) as Record<string, unknown>;
  const findings = result.findings as Record<string, unknown>[];
  assert.equal(result.distinct, 2);
  assert.equal(result.corroborated, 1);
  assert.equal(findings[0]!.severity, "critical");
  assert.deepEqual(findings[0]!.reported_by, ["b", "a"]);
  assert.deepEqual(findings[0]!.severity_disagreement, { b: "critical", a: "high" });
  assert.equal(findings[0]!.file, "src/supervisor.ts");
  assert.equal(findings[0]!.line, 120);
  assert.deepEqual(result.no_findings_from, ["c"]);
  assert.deepEqual((result.not_counted as { role: string }[]).map((entry) => entry.role), ["d"]);
  assert.deepEqual(normalizeLocation("./src/a.ts:10:2", undefined), { file: "src/a.ts", line: 10 });
});

test("compare and merge report disagreements instead of overwriting", () => {
  const results: MemberResult[] = [
    { role: "x", state: "completed", valid: true, value: { verdict: "ok", risks: ["a"], meta: { lang: "ts" } } },
    { role: "y", state: "completed", valid: true, value: { verdict: "bad", risks: ["b", "a"], meta: { lang: "ts" } } },
  ];
  const compared = aggregate(results, { strategy: "compare", max_items: 5 }) as Record<string, unknown>;
  assert.deepEqual(compared.agreed, { "meta.lang": "ts" });
  assert.deepEqual((compared.differing as { path: string }[]).map((entry) => entry.path), ["risks", "verdict"]);
  const merged = aggregate(results, { strategy: "merge", max_items: 5 }) as Record<string, unknown>;
  assert.deepEqual(merged.merged, { risks: ["a", "b"], meta: { lang: "ts" } });
  assert.equal((merged.conflicts as { path: string; resolution: string }[])[0]!.resolution, "omitted");
  const preferred = aggregate(results, { strategy: "merge", max_items: 5, prefer: ["y"] }) as Record<string, unknown>;
  assert.equal((preferred.merged as Record<string, unknown>).verdict, "bad");
});

test("responses fit the character budget, keeping top-level fields", () => {
  const big = { ensemble_id: "ens-1", status: "completed", aggregate: { items: Array.from({ length: 20 }, (_, index) => ({ role: `r${index}`, result: "x".repeat(2_000) })) } };
  const fitted = fitToBudget(big, 1_600);
  assert.ok(JSON.stringify(fitted).length <= 1_600);
  assert.equal(fitted.ensemble_id, "ens-1");
  assert.equal(fitted.truncated, true);
  assert.deepEqual(extractJson("noise ```json\n{\"a\":1}\n``` tail"), { ok: true, value: { a: 1 } });
  // The safety notice scanChildOutput prepends starts with a bracket; the object after it is still found.
  assert.deepEqual(extractJson("[Safety notice: child output mentions permission-control settings.]\n{\"findings\":[{\"t\":1}]}"),
    { ok: true, value: { findings: [{ t: 1 }] } });
  assert.deepEqual(extractJson("[1, 2]"), { ok: true, value: [1, 2] });
});

test("profiles supply rosters; call fields override them; competitive forces worktrees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profiles-"));
  const file = join(directory, "ensembles.yaml");
  await writeFile(file, [
    "ensembles:",
    "  standard-review:",
    "    mode: parallel",
    "    agents:",
    "      - { role: primary, config: codex-general, model: sol }",
    "      - { role: second, config: opencode-general, model: provider/a }",
    "    aggregation: { strategy: review_findings }",
  ].join("\n"));
  const profiles = await loadProfiles([{ path: file, scope: "project" }, { path: join(directory, "missing.yaml"), scope: "user" }]);
  const spec = resolveSpec({ profile: "standard-review", task: "Review", output: { max_chars: 900 } }, profiles);
  assert.equal(spec.name, "standard-review");
  assert.equal(spec.agents.length, 2);
  assert.equal(spec.aggregation.strategy, "review_findings");
  assert.equal(spec.aggregation.max_items, 5);
  assert.equal(spec.output.max_chars, 900);
  const competitive = resolveSpec({ task: "Implement", mode: "competitive", agents: roster.slice(0, 2) }, profiles);
  assert.ok(competitive.agents.every((agent) => agent.isolation === "worktree"));
  assert.throws(() => resolveSpec({ task: "t", mode: "competitive", agents: [{ ...roster[0]!, isolation: "none" }] }, profiles), /must not share/);
  assert.throws(() => resolveSpec({ task: "t", mode: "specialist", agents: roster }, profiles), /instructions/);
  assert.throws(() => resolveSpec({ task: "t", agents: [{ ...roster[0]!, depends_on: ["later"] }] }, profiles), /not an earlier member/);
  assert.throws(() => resolveSpec({ profile: "nope", task: "t" }, profiles), /Unknown ensemble profile/);
});

test("ordinary spawn_agent results are unchanged and still notify", async () => {
  const f = fixture();
  f.codex.queueScript([]);
  const result = await f.supervisor.spawnAgent({ agent: "codex-general", model: "sol", prompt: "p", description: "d", run_in_background: true });
  assert.equal(result.ensemble_id, undefined);
  complete(f.codex, String(result.agent_id), "done");
  await until(() => f.detached.length === 1);
  assert.equal(f.detached[0]!.status, "completed");
});
