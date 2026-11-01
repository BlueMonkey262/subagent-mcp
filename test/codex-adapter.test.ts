import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CodexAdapter } from "../src/adapters/codex/adapter.js";
import type { ResumeRequest, SpawnRequest } from "../src/adapters/adapter.js";
import type { AgentEvent } from "../src/events/schema.js";

const permission = { allow: [], deny: [], default: "escalate" as const };

interface FakeCodexServer {
  readonly child: ChildProcessWithoutNullStreams;
  /** Every `params` object the fake server received, keyed by JSON-RPC method. */
  readonly received: Record<string, Readonly<Record<string, unknown>>[]>;
}

/**
 * Minimal fake `codex app-server`: answers `initialize`, `thread/start`, `thread/resume`, and
 * `turn/start` just enough for CodexAdapter.spawn()/resume() to resolve, while recording every
 * request's params so tests can assert on what the adapter actually sent over the wire.
 */
function fakeCodexServer(): FakeCodexServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin, stdout, stderr, killed: false, kill: () => { (child as unknown as { killed: boolean }).killed = true; } });

  const received: Record<string, Readonly<Record<string, unknown>>[]> = {};
  let threadIdCounter = 0;
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Readonly<Record<string, unknown>> };
      if (message.method === undefined || message.id === undefined) continue; // ignore notifications
      const params = message.params ?? {};
      (received[message.method] ??= []).push(params);
      const reply = (result: Readonly<Record<string, unknown>>): void => {
        stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      };
      switch (message.method) {
        case "initialize":
          reply({});
          break;
        case "thread/start":
          reply({ thread: { id: `thread-${++threadIdCounter}` } });
          break;
        case "thread/resume": {
          const threadId = typeof params.threadId === "string" ? params.threadId : `thread-${++threadIdCounter}`;
          reply({ thread: { id: threadId } });
          break;
        }
        case "turn/start": {
          const turnId = `turn-${message.id}`;
          reply({ turn: { id: turnId } });
          // Complete the turn right after, so the test doesn't depend on any of the adapter's
          // internal (deliberately unref'd) timers to observe a terminal state. Deferred to a
          // macrotask so the client has processed turn/start's own response (and recorded
          // currentTurn.id) before the completion notification arrives.
          setImmediate(() => {
            stdout.write(`${JSON.stringify({
              method: "turn/completed",
              params: { turn: { id: turnId, status: "completed", items: [] } },
            })}\n`);
          });
          break;
        }
        default:
          reply({});
      }
    }
  });

  return { child, received };
}

async function waitForTurnCompleted(adapter: CodexAdapter, agentId: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 2_000);
  try {
    for await (const event of adapter.events(agentId, { signal: abort.signal }) as AsyncIterable<AgentEvent>) {
      if (event.type === "turn.completed") return;
    }
    throw new Error("Timed out waiting for turn.completed");
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

function spawnRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    prompt: "do the thing",
    description: "fixture delegation",
    model: "gpt-5.6-luna",
    cwd: "/tmp",
    systemPrompt: "",
    env: {},
    permission,
    ...overrides,
  };
}

test("spawn detaches Codex into its own process group", async () => {
  const server = fakeCodexServer();
  let detached: boolean | undefined;
  const adapter = new CodexAdapter({
    spawnProcess: (_command, _args, options) => {
      detached = options.detached;
      return server.child;
    },
    initTimeoutMs: 2_000,
  });
  await adapter.spawn(spawnRequest());
  assert.equal(detached, true);
});

test("spawn() sends reasoningEffort on turn/start when provided", async () => {
  const server = fakeCodexServer();
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  await adapter.spawn(spawnRequest({ reasoningEffort: "xhigh" }));
  assert.equal(server.received["turn/start"]?.length, 1);
  assert.equal(server.received["turn/start"]?.[0]?.reasoningEffort, "xhigh");
});

test("spawn() omits reasoningEffort entirely when not provided", async () => {
  const server = fakeCodexServer();
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  await adapter.spawn(spawnRequest());
  assert.equal(server.received["turn/start"]?.length, 1);
  assert.ok(!("reasoningEffort" in (server.received["turn/start"]?.[0] ?? {})));
});

test("resume() on an existing session sends reasoningEffort on the new turn/start", async () => {
  const server = fakeCodexServer();
  const adapter = new CodexAdapter({ spawnProcess: () => server.child, initTimeoutMs: 2_000 });
  const spawned = await adapter.spawn(spawnRequest());
  // Wait for the fake server's completion notification so the session is terminal and resume()
  // takes the "existing session" branch instead of throwing "already has an active turn".
  await waitForTurnCompleted(adapter, spawned.agentId);

  const resumeRequest: ResumeRequest = {
    agentId: spawned.agentId,
    prompt: "follow up",
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    systemPrompt: "",
    env: {},
    permission,
    reasoningEffort: "low",
  };
  await adapter.resume(resumeRequest);
  assert.equal(server.received["turn/start"]?.length, 2);
  assert.equal(server.received["turn/start"]?.[1]?.reasoningEffort, "low");
});
