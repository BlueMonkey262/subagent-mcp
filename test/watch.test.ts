import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { readResults, resultsLogPath, summarizeEntry, waitForAgentsCommand, WAIT_EXIT, type ResultEntry, type WaitHost } from "../src/watch.js";

const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;

test("readResults follows appended lines, holds back a partial line, and skips junk", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "watch-")), "results.jsonl");
  await writeFile(path, line({ agent_id: "old", name: "old-one", turn: 1, status: "completed" }));
  const controller = new AbortController();
  const seen: ResultEntry[] = [];
  const reading = (async () => {
    for await (const entry of readResults(path, { follow: true, signal: controller.signal, pollMs: 10 })) {
      seen.push(entry);
      if (seen.length === 2) controller.abort();
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await appendFile(path, `not json\n${JSON.stringify({ agent_id: "a", name: "alpha", turn: 1, status: "failed" }).slice(0, 20)}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.length, 0, "starts at the end and waits for the rest of a torn line");
  await appendFile(path, `${JSON.stringify({ agent_id: "a", name: "alpha", turn: 1, status: "failed" }).slice(20)}\n`);
  await appendFile(path, line({ agent_id: "b", turn: 2, status: "completed", result: "x".repeat(50) }));
  await reading;
  assert.deepEqual(seen.map((entry) => entry.agent_id), ["a", "b"]);
  assert.deepEqual(summarizeEntry(seen[1]!, 10), { agent_id: "b", turn: 2, status: "completed", result: "xxxxxxxxxx… [40 more chars]" });

  const all: string[] = [];
  for await (const entry of readResults(path, { fromStart: true })) all.push(entry.agent_id);
  assert.deepEqual(all, ["old", "a", "b"]);
});

function fakeHost(responses: unknown[]): WaitHost & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    closed: false,
    close() {},
    async call(method: string, params?: unknown) {
      assert.equal(method, "wait_for_agents");
      calls.push(params);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("wait renews 60-second rounds until the agents settle, and the exit code reports the outcome", async () => {
  const lines: string[] = [];
  const host = fakeHost([
    { timed_out: true, agents: [{ name: "alpha", agent_id: "a", status: "running" }] },
    { timed_out: false, agents: [{ name: "alpha", agent_id: "a", status: "completed", result: "done" }] },
  ]);
  const code = await waitForAgentsCommand({ cwd: "/work", agents: ["alpha"], write: (text) => lines.push(text), connect: async () => host });
  assert.equal(code, WAIT_EXIT.completed);
  assert.equal(host.calls.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { name: "alpha", agent_id: "a", state: "completed", result: "done" });

  const cases: [Record<string, unknown>[], number][] = [
    [[{ agent_id: "a", status: "failed", error: { code: "X", message: "boom", retryable: false } }], WAIT_EXIT.unsuccessful],
    [[{ agent_id: "a", status: "needs_approval", request_id: "r1", tool_name: "Bash", command: "rm" }, { agent_id: "b", status: "running" }], WAIT_EXIT.needsApproval],
    [[{ agent_id: "a", status: "completed" }, { agent_id: "b", status: "running" }], WAIT_EXIT.completed],
    [[{ id: "task-1", state: "blocked" }], WAIT_EXIT.unsuccessful],
  ];
  for (const [agents, expected] of cases) {
    const out: string[] = [];
    const result = await waitForAgentsCommand({ cwd: "/work", agents: ["a"], mode: "any", write: (text) => out.push(text), connect: async () => fakeHost([{ timed_out: false, agents }]) });
    assert.equal(result, expected, JSON.stringify(agents));
    if (expected === WAIT_EXIT.needsApproval) assert.deepEqual(JSON.parse(out[0]!).approval, { request_id: "r1", tool_name: "Bash", command: "rm" });
  }
});

test("wait stops at --timeout, reconnects after a host restart, and reports a host error", async () => {
  let clock = 0;
  const timedOut = await waitForAgentsCommand({
    cwd: "/work", agents: ["a"], timeoutSeconds: 5, write: () => {}, now: () => clock,
    connect: async () => ({ ...fakeHost([]), call: async (_method: string, params?: unknown) => {
      assert.equal((params as { timeout_seconds: number }).timeout_seconds, 5);
      clock += 5_000;
      return { timed_out: true, agents: [{ agent_id: "a", status: "running" }] };
    } }),
  });
  assert.equal(timedOut, WAIT_EXIT.timedOut);

  const first = fakeHost([]);
  Object.assign(first, { call: async () => { Object.assign(first, { closed: true }); throw new Error("connection closed"); } });
  const second = fakeHost([{ timed_out: false, agents: [{ agent_id: "a", status: "completed" }] }]);
  const hosts = [first, second];
  const restarted = await waitForAgentsCommand({ cwd: "/work", agents: ["a"], write: () => {}, connect: async () => hosts.shift() });
  assert.equal(restarted, WAIT_EXIT.completed);

  const out: string[] = [];
  const unknown = await waitForAgentsCommand({ cwd: "/work", agents: ["nope"], write: (text) => out.push(text), connect: async () => fakeHost([new Error("Unknown agent nope")]) });
  assert.equal(unknown, WAIT_EXIT.error);
  assert.match(out[0]!, /Unknown agent nope/);
});

test("with no host running, wait reads each agent's last logged turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "watch-project-"));
  const path = resultsLogPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, line({ agent_id: "a", name: "alpha", turn: 1, status: "failed" })
    + line({ agent_id: "a", name: "alpha", turn: 1, status: "completed", result: "ok" }));
  const out: string[] = [];
  const code = await waitForAgentsCommand({ cwd, agents: ["alpha"], write: (text) => out.push(text), connect: async () => undefined, reconnectMs: 0 });
  assert.equal(code, WAIT_EXIT.completed, "the last line for a turn wins");
  assert.deepEqual(JSON.parse(out[0]!), { name: "alpha", agent_id: "a", state: "completed", result: "ok" });

  const missing = await waitForAgentsCommand({ cwd, agents: ["beta"], write: (text) => out.push(text), connect: async () => undefined, reconnectMs: 0 });
  assert.equal(missing, WAIT_EXIT.error);
  assert.match(out.at(-1)!, /beta has no recorded result/);
});
