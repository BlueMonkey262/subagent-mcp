import assert from "node:assert/strict";
import test from "node:test";

import { FakeAdapter } from "../src/adapters/fake.js";
import { ApprovalCoordinator } from "../src/approval/coordinator.js";
import type { ApprovalRequest } from "../src/approval/types.js";

class FakeClock {
  nowValue = 0;
  next = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.nowValue; }
  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = ++this.next;
    this.timers.set(id, { at: this.nowValue + milliseconds, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.nowValue) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

async function setup(requestId = "req-1") {
  const adapter = new FakeAdapter("codex");
  const turn = await adapter.spawn({
    prompt: "x",
    description: "x",
    model: "explicit",
    cwd: "/work",
    systemPrompt: "",
    env: {},
    permission: { allow: [], deny: [], default: "escalate" },
  });
  const request: ApprovalRequest = {
    requestId,
    agentId: turn.agentId,
    backend: "codex",
    toolName: "Bash",
    input: { command: "npm test" },
    command: "npm test",
    cwd: "/work",
    requestedAt: new Date(0).toISOString(),
  };
  adapter.emit(turn.agentId, "approval.requested", request);
  return { adapter, request };
}

test("allow_for_session resolves once and auto-allows the same later operation", async () => {
  const { adapter, request } = await setup();
  const coordinator = new ApprovalCoordinator({ adapterFor: () => adapter, watchdogMs: 100 });
  const routed = await coordinator.route(request, { allow: [], deny: [], default: "escalate" });
  assert.equal(routed.status, "pending");
  assert.equal((await coordinator.resolve(request.requestId, "allow_for_session")).status, "resolved");

  const second: ApprovalRequest = { ...request, requestId: "req-2", requestedAt: new Date(1).toISOString() };
  adapter.emit(request.agentId, "approval.requested", second);
  const rerouted = await coordinator.route(second, { allow: [], deny: [], default: "escalate" });
  assert.equal(rerouted.status, "resolved");
  assert.equal(rerouted.evaluation.source, "session");
  assert.deepEqual(adapter.approvals.map((entry) => entry.resolution.decision), ["allow_for_session", "allow"]);
});

test("allow_for_session also auto-allows a different command sharing the same program+subcommand (issue #2)", async () => {
  const { adapter, request } = await setup(); // request.command === "npm test"
  const coordinator = new ApprovalCoordinator({ adapterFor: () => adapter, watchdogMs: 100 });
  const routed = await coordinator.route(request, { allow: [], deny: [], default: "escalate" });
  assert.equal(routed.status, "pending");
  assert.equal((await coordinator.resolve(request.requestId, "allow_for_session")).status, "resolved");

  const differentCommand: ApprovalRequest = {
    ...request,
    requestId: "req-2",
    command: "npm test -- --watch",
    input: { command: "npm test -- --watch" },
    requestedAt: new Date(1).toISOString(),
  };
  adapter.emit(request.agentId, "approval.requested", differentCommand);
  const rerouted = await coordinator.route(differentCommand, { allow: [], deny: [], default: "escalate" });
  assert.equal(rerouted.status, "resolved");
  assert.equal(rerouted.evaluation.source, "session");
  assert.deepEqual(adapter.approvals.map((entry) => entry.resolution.decision), ["allow_for_session", "allow"]);
});

test("only one resolver can transition a pending request", async () => {
  const { adapter, request } = await setup();
  const coordinator = new ApprovalCoordinator({ adapterFor: () => adapter });
  coordinator.park(request);
  await coordinator.resolve(request.requestId, "deny", "No");
  await assert.rejects(coordinator.resolve(request.requestId, "allow"), /already resolved/);
  assert.equal((await coordinator.resolve(request.requestId, "deny")).status, "resolved");
});

test("watchdog deterministically expires and fails closed", async () => {
  const { adapter, request } = await setup();
  const clock = new FakeClock();
  const coordinator = new ApprovalCoordinator({ adapterFor: () => adapter, watchdogMs: 50, clock });
  coordinator.park(request);
  clock.advance(50);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(coordinator.get(request.requestId)?.status, "expired");
  assert.equal(adapter.approvals[0]?.resolution.decision, "deny");
  assert.match(adapter.approvals[0]?.resolution.message ?? "", /watchdog expired/i);
});
