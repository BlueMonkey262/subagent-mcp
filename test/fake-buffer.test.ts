import assert from "node:assert/strict";
import test from "node:test";

import { FakeAdapter } from "../src/adapters/fake.js";
import { EventBuffer } from "../src/events/buffer.js";

const spawnRequest = {
  prompt: "Do work",
  description: "Test work",
  model: "explicit-model",
  cwd: "/workspace",
  systemPrompt: "Act as a test worker.",
  env: { TEST_MODE: "true" },
  permission: { allow: ["Read"], deny: [], default: "escalate" as const },
};

test("fake adapter buffers fast events and resumes the same agent", async () => {
  const buffer = new EventBuffer();
  const adapter = new FakeAdapter("claude", buffer);
  adapter.queueScript([
    {
      create: ({ agentId, backend }) => ({
        type: "message.delta",
        agentId,
        backend,
        data: { text: "done" },
      }),
    },
    {
      create: ({ agentId, backend, turnId }) => ({
        type: "turn.completed",
        agentId,
        backend,
        data: { turnId, status: "completed", finalText: "done" },
      }),
    },
  ]);
  const first = await adapter.spawn(spawnRequest);
  await Promise.resolve();
  await Promise.resolve();
  const events = buffer.read(first.agentId).events;
  assert.deepEqual(events.map((event) => event.type), ["thread.started", "message.delta", "turn.completed"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);

  const resumed = await adapter.resume({
    agentId: first.agentId,
    prompt: "Again",
    cwd: "/workspace",
    model: "explicit-model",
    systemPrompt: spawnRequest.systemPrompt,
    env: spawnRequest.env,
    permission: spawnRequest.permission,
  });
  assert.equal(resumed.agentId, first.agentId);
  assert.notEqual(resumed.turnId, first.turnId);
  assert.deepEqual(adapter.spawnRequests[0]?.permission, spawnRequest.permission);
  assert.deepEqual(adapter.resumeRequests[0]?.env, spawnRequest.env);
});

test("buffer reports retention truncation", () => {
  const buffer = new EventBuffer(2);
  for (let index = 0; index < 3; index += 1) {
    buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: String(index) } });
  }
  const result = buffer.read("a", 0);
  assert.deepEqual(result.events.map((event) => event.sequence), [2, 3]);
  assert.equal(result.truncatedBefore, 2);
});

test("currentSequence is always the true latest sequence, even on an empty or out-of-range read (issue #3)", () => {
  const buffer = new EventBuffer();
  for (let index = 0; index < 5; index += 1) {
    buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: String(index) } });
  }
  // Caught up: no new events, but currentSequence still reports where "now" is instead of
  // echoing the caller's own `since` back (the exact bug the review hit with `since: 100000`).
  const caughtUp = buffer.read("a", 5);
  assert.deepEqual(caughtUp.events, []);
  assert.equal(caughtUp.currentSequence, 5);
  assert.equal(caughtUp.nextSequence, 5);

  // A `since` far beyond the true max behaves the same way, not as an error.
  const wayAhead = buffer.read("a", 100_000);
  assert.deepEqual(wayAhead.events, []);
  assert.equal(wayAhead.currentSequence, 5);

  // An agent with no events at all reports currentSequence 0, not the caller's `since`.
  assert.equal(buffer.read("unknown-agent", 0).currentSequence, 0);
});

test("limit caps a read and hasMore reports whether more events remain", () => {
  const buffer = new EventBuffer();
  for (let index = 0; index < 5; index += 1) {
    buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: String(index) } });
  }
  const page = buffer.read("a", 0, 2);
  assert.deepEqual(page.events.map((event) => event.sequence), [1, 2]);
  assert.equal(page.nextSequence, 2);
  assert.equal(page.currentSequence, 5);
  assert.equal(page.hasMore, true);

  const nextPage = buffer.read("a", page.nextSequence, 2);
  assert.deepEqual(nextPage.events.map((event) => event.sequence), [3, 4]);
  assert.equal(nextPage.hasMore, true);

  const lastPage = buffer.read("a", nextPage.nextSequence, 2);
  assert.deepEqual(lastPage.events.map((event) => event.sequence), [5]);
  assert.equal(lastPage.hasMore, undefined);
});

test("types filters events, and limit/nextSequence/hasMore account for the filter so pagination doesn't stall", () => {
  const buffer = new EventBuffer();
  // 1: tool.start, 2-3: message.delta, 4: tool.end, 5: message.delta, 6: turn.completed
  buffer.append({ type: "tool.start", agentId: "a", backend: "codex", data: { toolCallId: "1", toolName: "x", input: {} } });
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "a" } });
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "b" } });
  buffer.append({ type: "tool.end", agentId: "a", backend: "codex", data: { toolCallId: "1", status: "completed" } });
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "c" } });
  buffer.append({ type: "turn.completed", agentId: "a", backend: "codex", data: { turnId: "t1", status: "completed" } });

  const page = buffer.read("a", 0, 1, { types: ["tool.start", "tool.end"] });
  assert.deepEqual(page.events.map((event) => event.type), ["tool.start"]);
  assert.equal(page.nextSequence, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.currentSequence, 6);

  // nextSequence must skip past the message.delta events filtered out of the window, not stall on them.
  const nextPage = buffer.read("a", page.nextSequence, 1, { types: ["tool.start", "tool.end"] });
  assert.deepEqual(nextPage.events.map((event) => event.type), ["tool.end"]);
  assert.equal(nextPage.events[0]?.sequence, 4);
  assert.equal(nextPage.nextSequence, 4);
  assert.equal(nextPage.hasMore, undefined);

  // A `since` that lands only on filtered-out events must not re-return them or go backwards.
  const caughtUp = buffer.read("a", nextPage.nextSequence, 1, { types: ["tool.start", "tool.end"] });
  assert.deepEqual(caughtUp.events, []);
  assert.equal(caughtUp.nextSequence, 4);
});

test("coalesce merges consecutive message.delta events on read without changing what's stored", () => {
  const buffer = new EventBuffer();
  // 1-3: message.delta "a","b","c", 4: tool.start, 5-6: message.delta "d","e"
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "a" } });
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "b" } });
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "c" } });
  buffer.append({ type: "tool.start", agentId: "a", backend: "codex", data: { toolCallId: "1", toolName: "x", input: {} } });
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "d" } });
  buffer.append({ type: "message.delta", agentId: "a", backend: "codex", data: { text: "e" } });

  const raw = buffer.read("a", 0);
  assert.equal(raw.events.length, 6, "storage itself must stay one event per delta");

  const coalesced = buffer.read("a", 0, undefined, { coalesce: true });
  assert.equal(coalesced.events.length, 3);
  const [first, second, third] = coalesced.events;
  assert.equal(first?.type, "message.delta");
  assert.equal(first?.sequence, 1, "merged event keeps the first sequence number");
  assert.equal(first?.type === "message.delta" ? first.data.text : undefined, "abc");
  assert.equal(second?.type, "tool.start");
  assert.equal(second?.sequence, 4);
  assert.equal(third?.type === "message.delta" ? third.data.text : undefined, "de");
  assert.equal(third?.sequence, 5);
  assert.equal(coalesced.nextSequence, 6, "nextSequence is the last merged sequence");
  assert.equal(coalesced.hasMore, undefined);

  // limit applies to coalesced groups, and nextSequence/hasMore follow the merged group's last sequence.
  const page = buffer.read("a", 0, 2, { coalesce: true });
  assert.equal(page.events.length, 2);
  assert.equal(page.nextSequence, 4);
  assert.equal(page.hasMore, true);

  const nextPage = buffer.read("a", page.nextSequence, 2, { coalesce: true });
  assert.equal(nextPage.events.length, 1);
  assert.equal(nextPage.events[0]?.type === "message.delta" ? nextPage.events[0].data.text : undefined, "de");
  assert.equal(nextPage.nextSequence, 6);
  assert.equal(nextPage.hasMore, undefined);
});
