import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenCodeAdapter } from "../src/adapters/opencode/adapter.js";
import type { SpawnRequest } from "../src/adapters/adapter.js";
import type { AgentEvent } from "../src/events/schema.js";

const permission = { allow: [], deny: [], default: "escalate" as const };
const PASSWORD = "test-password";
const BASIC = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    prompt: "say hi",
    description: "opencode v2 test",
    model: "opencode/space-bunny-free",
    cwd: "/tmp",
    systemPrompt: "",
    env: {},
    permission,
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

/** A fake opencode 2.x server: just enough of /api to drive one adapter turn. */
class FakeV2 {
  readonly calls: Call[] = [];
  readonly server: Server;
  /** Newest-first session log, as `GET /api/session/{id}/message?order=desc` returns it. */
  log: Record<string, unknown>[] = [];
  permissions: Record<string, unknown>[] = [];
  /** `GET /api/model` entries; the first is also `GET /api/model/default`. */
  models: Record<string, unknown>[] = [];
  /** `GET /api/experimental/usage/limits` data; undefined makes the endpoint fail with 500. */
  usageLimits: Record<string, unknown> | undefined;
  private nextMessage = 1;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  /** Append to the log the way the server does: newest first. */
  push(message: Record<string, unknown>): void {
    this.log.unshift(message);
  }

  userMessageId(): string {
    return `msg_user${this.nextMessage}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const body = text === "" ? undefined : (JSON.parse(text) as unknown);
    this.calls.push({ method: req.method ?? "", path: url.pathname + url.search, body, authorization: req.headers.authorization });
    if (req.headers.authorization !== BASIC) {
      res.writeHead(401).end();
      return;
    }
    const json = (value: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/model") return json({ data: this.models });
    if (req.method === "GET" && path === "/api/model/default") return json({ data: this.models[0] });
    if (req.method === "GET" && path === "/api/experimental/usage/limits") {
      return this.usageLimits === undefined ? json({ error: "gone" }, 500) : json({ data: this.usageLimits });
    }
    if (req.method === "POST" && path === "/api/session") return json({ data: { id: "ses_fake1", location: { directory: "/tmp" } } });
    const session = /^\/api\/session\/(ses_[^/]+)(\/.*)?$/.exec(path);
    if (session) {
      const rest = session[2] ?? "";
      if (req.method === "POST" && rest === "/model") return json({ data: {} });
      if (req.method === "POST" && rest === "/prompt") {
        const id = this.userMessageId();
        this.nextMessage += 1;
        this.push({ id, type: "user", time: { created: Date.now() }, text: (body as { text: string }).text });
        return json({ data: { id, sessionID: session[1], type: "user", delivery: "steer" } });
      }
      if (req.method === "POST" && rest === "/interrupt") return json({ interrupted: true });
      if (req.method === "GET" && rest === "/permission") return json({ data: this.permissions });
      if (req.method === "POST" && /^\/permission\/per_[^/]+\/reply$/.test(rest)) return json({});
      if (req.method === "GET" && rest === "/message") return json({ data: this.log, cursor: {} });
      if (req.method === "GET" && rest === "") return json({ data: { id: session[1] } });
    }
    res.writeHead(404).end();
  }
}

async function nextEvent(iterator: AsyncIterator<AgentEvent>, type: string): Promise<AgentEvent> {
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false, `stream ended before ${type}`);
    if (next.value.type === type) return next.value;
  }
}

function assistant(id: string, content: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    agent: "build",
    model: { providerID: "opencode", id: "space-bunny-free" },
    content,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 1 } },
    cost: 0.25,
    ...extra,
  };
}

const fast = { pollActiveMs: 20, pollIdleMs: 20, interruptGraceMs: 200 };

test("v2: creates a session scoped to the directory, authenticates with Basic, streams text and tools, finishes on idle", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, ...fast });
  try {
    const turn = await adapter.spawn(request({ cwd: "/work/project", model: "openrouter/nvidia/nemotron:free" }));
    assert.equal(turn.agentId, "ses_fake1");

    const create = fake.calls.find((call) => call.path === "/api/session");
    assert.deepEqual(create?.body, { location: { directory: "/work/project" }, model: { providerID: "openrouter", id: "nvidia/nemotron:free" } });
    assert.ok(fake.calls.every((call) => call.authorization === BASIC), "every call carries the Basic credentials");
    assert.ok(fake.calls.some((call) => call.path === "/api/session/ses_fake1/prompt" && (call.body as { text: string }).text === "say hi"));
    assert.ok(!fake.calls.some((call) => call.path.endsWith("/model")), "no model switch for the model the session was created with");

    // The server answers: a tool call that finishes, then text, then idle.
    fake.push(assistant("msg_a1", [
      { type: "text", text: "Running it." },
      { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "file.txt" }] }, time: { created: 1 } },
    ]));
    fake.push(assistant("msg_a2", [{ type: "text", text: "All done." }]));
    fake.push({ id: "msg_idle", type: "idle", time: { created: Date.now() }, outcome: "succeeded" });

    const iterator = adapter.events(turn.agentId)[Symbol.asyncIterator]();
    const delta = await nextEvent(iterator, "message.delta");
    assert.equal((delta.data as { text: string }).text, "Running it.");
    const toolStart = await nextEvent(iterator, "tool.start");
    assert.deepEqual(toolStart.data, { toolCallId: "call_1", toolName: "shell", input: { command: "ls" } });
    const toolEnd = await nextEvent(iterator, "tool.end");
    assert.deepEqual(toolEnd.data, { toolCallId: "call_1", status: "completed", output: "file.txt" });
    const done = await nextEvent(iterator, "turn.completed");
    const data = done.data as { status: string; finalText?: string; usage?: Record<string, number> };
    assert.equal(data.status, "completed");
    assert.equal(data.finalText, "All done.");
    assert.deepEqual(data.usage, { inputTokens: 20, outputTokens: 10, cachedInputTokens: 6, uncachedInputTokens: 22, costUsd: 0.5 });
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

test("v2: an idle message from an EARLIER turn does not finish the current one", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  fake.push({ id: "msg_old_user", type: "user", time: { created: Date.now() - 5000 }, text: "earlier" });
  fake.push(assistant("msg_old_a", [{ type: "text", text: "earlier answer" }]));
  fake.push({ id: "msg_old_idle", type: "idle", time: { created: Date.now() - 4000 }, outcome: "interrupted" });
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, ...fast });
  try {
    const turn = await adapter.resume({ ...request(), agentId: "ses_fake1", cwd: "/tmp" });
    const iterator = adapter.events(turn.agentId)[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 150));
    fake.push(assistant("msg_new_a", [{ type: "text", text: "fresh" }]));
    fake.push({ id: "msg_new_idle", type: "idle", time: { created: Date.now() }, outcome: "succeeded" });
    const done = await nextEvent(iterator, "turn.completed");
    assert.equal((done.data as { status: string }).status, "completed", "the earlier interrupted idle must not end this turn");
    assert.equal((done.data as { finalText?: string }).finalText, "fresh");
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

test("v2: failed and interrupted outcomes map to the matching turn status", async () => {
  for (const [outcome, expected] of [["failed", "failed"], ["interrupted", "interrupted"]] as const) {
    const fake = new FakeV2();
    const baseUrl = await fake.listen();
    const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, ...fast });
    try {
      const turn = await adapter.spawn(request());
      fake.push({ id: `msg_idle_${outcome}`, type: "idle", time: { created: Date.now() }, outcome });
      const done = await nextEvent(adapter.events(turn.agentId)[Symbol.asyncIterator](), "turn.completed");
      assert.equal((done.data as { status: string }).status, expected);
    } finally {
      await adapter.closeAll();
      fake.close();
    }
  }
});

test("v2: pending permissions come from the session route and replies use /permission/{id}/reply", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, ...fast });
  try {
    const turn = await adapter.spawn(request());
    fake.permissions = [{ id: "per_1", sessionID: "ses_fake1", action: "external_directory", resources: ["/etc/*"], metadata: { command: "cat /etc/hostname" } }];
    const iterator = adapter.events(turn.agentId)[Symbol.asyncIterator]();
    const requested = await nextEvent(iterator, "approval.requested");
    const data = requested.data as unknown as { requestId: string; toolName: string; command?: string; paths?: string[] };
    assert.equal(data.requestId, "per_1");
    assert.equal(data.toolName, "external_directory");
    assert.equal(data.command, "cat /etc/hostname");
    assert.deepEqual(data.paths, ["/etc/*"]);
    assert.ok(fake.calls.some((call) => call.method === "GET" && call.path === "/api/session/ses_fake1/permission"));
    assert.ok(!fake.calls.some((call) => call.path.startsWith("/api/permission/request")), "the directory-scoped global route must not be used");

    await adapter.approve(turn.agentId, { requestId: "per_1", decision: "allow" });
    const reply = fake.calls.find((call) => call.path === "/api/session/ses_fake1/permission/per_1/reply");
    assert.deepEqual(reply?.body, { decision: "once" });
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

test("v2: resume switches the session model only when it changed", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, ...fast });
  try {
    const turn = await adapter.spawn(request({ model: "opencode/space-bunny-free" }));
    fake.push({ id: "msg_i1", type: "idle", time: { created: Date.now() }, outcome: "succeeded" });
    await nextEvent(adapter.events(turn.agentId)[Symbol.asyncIterator](), "turn.completed");

    await adapter.resume({ ...request({ model: "opencode/space-bunny-free" }), agentId: turn.agentId });
    assert.equal(fake.calls.filter((call) => call.path.endsWith("/model")).length, 0);
    fake.push({ id: "msg_i2", type: "idle", time: { created: Date.now() + 1 }, outcome: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await adapter.resume({ ...request({ model: "openai/gpt-5.6-luna" }), agentId: turn.agentId });
    const switches = fake.calls.filter((call) => call.path.endsWith("/model"));
    assert.equal(switches.length, 1);
    assert.deepEqual(switches[0]?.body, { model: { providerID: "openai", id: "gpt-5.6-luna" } });
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

test("interrupt: the grace timer of an old turn never force-completes a newer turn", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, pollActiveMs: 20, pollIdleMs: 20, interruptGraceMs: 300 });
  try {
    const first = await adapter.spawn(request());
    const iterator = adapter.events(first.agentId)[Symbol.asyncIterator]();
    const interrupting = adapter.interrupt(first.agentId);
    fake.push({ id: "msg_int", type: "idle", time: { created: Date.now() }, outcome: "interrupted" });
    const ended = await nextEvent(iterator, "turn.completed");
    assert.equal((ended.data as { status: string }).status, "interrupted");

    // A new turn starts at once, before the first interrupt()'s 300ms grace timer would have fired.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await adapter.resume({ ...request(), agentId: first.agentId });
    await interrupting;
    await new Promise((resolve) => setTimeout(resolve, 450));
    fake.push({ id: "msg_ok", type: "idle", time: { created: Date.now() }, outcome: "succeeded" });
    const second = await nextEvent(iterator, "turn.completed");
    assert.equal((second.data as { status: string }).status, "completed", "the new turn must end on its own idle, not on the old interrupt's timer");
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

/** A stand-in `opencode` binary: prints its version, and on `serve` records argv/env then "listens". */
async function fakeOpencode(version: string, listenUrl: string): Promise<{ executable: string; argsFile: string; envFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
  const executable = join(dir, "opencode");
  const argsFile = join(dir, "args.txt");
  const envFile = join(dir, "env.txt");
  await writeFile(executable, [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo "opencode v${version}"; exit 0; fi`,
    `echo "$@" > "${argsFile}"`,
    `echo "$OPENCODE_SERVER_PASSWORD" > "${envFile}"`,
    `echo "server listening on ${listenUrl}"`,
    "exec sleep 30",
  ].join("\n"));
  await chmod(executable, 0o755);
  return { executable, argsFile, envFile };
}

test("v2 binary: serve is started WITHOUT --pure and with a generated password the adapter then uses", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  const bin = await fakeOpencode("2.0.22", baseUrl);
  const adapter = new OpenCodeAdapter({ executable: bin.executable, ...fast });
  try {
    // The fake server only accepts PASSWORD, so a generated password cannot authenticate: that is what we
    // assert — the adapter must pass ITS password to the child and send the same one in Authorization.
    await adapter.spawn(request()).catch(() => undefined);
    const args = (await readFile(bin.argsFile, "utf8")).trim();
    assert.equal(args, "serve --hostname 127.0.0.1 --port 0");
    const password = (await readFile(bin.envFile, "utf8")).trim();
    assert.match(password, /^[0-9a-f]{48}$/);
    const first = fake.calls[0];
    assert.equal(first?.authorization, `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

test("v1 binary: serve keeps --pure and sends no Authorization header", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  const bin = await fakeOpencode("1.18.33", baseUrl);
  const adapter = new OpenCodeAdapter({ executable: bin.executable, ...fast });
  try {
    await adapter.spawn(request()).catch(() => undefined);
    const args = (await readFile(bin.argsFile, "utf8")).trim();
    assert.equal(args, "serve --hostname 127.0.0.1 --port 0 --pure");
    assert.equal(fake.calls[0]?.path, "/session?directory=%2Ftmp", "v1 still uses its own session route");
    assert.equal(fake.calls[0]?.authorization, undefined);
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

test("v2: providerInfo summarizes models, the default, and Go usage without leaking headers", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  fake.models = [{
    id: "hy4", modelID: "hy4", providerID: "opencode-go", name: "Hy4", status: "active", enabled: true,
    headers: { "x-opencode-org-id": "org_secret" }, settings: { baseURL: "https://example.invalid" },
    capabilities: { tools: true }, variants: [{ id: "none" }, { id: "high" }],
    cost: [{ input: 0.834, output: 2.501, cache: { read: 0.042, write: 0 } }],
    limit: { context: 1048576, output: 65536 },
  }];
  fake.usageLimits = {
    workspace: { id: "org_secret", name: "Personal", usageURL: "https://opencode.ai/console/x" },
    go: { weekly: { percent: 41, limited: false, resetsAt: Date.UTC(2026, 10, 15) } },
    budgets: [],
  };
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, ...fast });
  try {
    const info = await adapter.providerInfo();
    assert.equal(info["default_model"], "opencode-go/hy4");
    assert.deepEqual(info.models, [{
      id: "opencode-go/hy4", name: "Hy4", status: "active", context: 1048576, max_output: 65536,
      cost_per_mtok: { input: 0.834, output: 2.501, cache_read: 0.042 }, variants: ["none", "high"],
    }]);
    assert.deepEqual(info["usage_limits"], {
      workspace: { name: "Personal", usage_url: "https://opencode.ai/console/x" },
      go: { weekly: { percent_used: 41, remaining_percent: 59, limited: false, resets_at: "2026-11-15T00:00:00.000Z" } },
      budgets: [],
    });
    assert.equal(JSON.stringify(info).includes("org_secret"), false);
    assert.equal(info["errors"], undefined);

    fake.usageLimits = undefined;
    const partial = await adapter.providerInfo();
    assert.equal(partial.models?.length, 1, "a failing usage endpoint keeps the model list");
    assert.match(String((partial["errors"] as Record<string, string>)["usage_limits"]), /500/);
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});

test("v1: providerInfo reports live data as unsupported", async () => {
  const adapter = new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:9", protocol: "v1" });
  const info = await adapter.providerInfo();
  assert.equal(info["supported"], false);
  await adapter.closeAll();
});

test("v2: reports running usage mid-turn, once per change", async () => {
  const fake = new FakeV2();
  const baseUrl = await fake.listen();
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v2", password: PASSWORD, ...fast });
  try {
    const turn = await adapter.spawn(request());
    fake.push(assistant("msg_a1", [{ type: "text", text: "Working." }]));
    const iterator = adapter.events(turn.agentId)[Symbol.asyncIterator]();
    const first = await nextEvent(iterator, "usage.updated");
    assert.deepEqual((first.data as { usage: unknown }).usage, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, uncachedInputTokens: 11, costUsd: 0.25 });
    await new Promise((resolve) => setTimeout(resolve, 120)); // several unchanged polls
    fake.push(assistant("msg_a2", [{ type: "text", text: "Done." }]));
    const second = await nextEvent(iterator, "usage.updated");
    assert.deepEqual((second.data as { usage: unknown }).usage, { inputTokens: 20, outputTokens: 10, cachedInputTokens: 6, uncachedInputTokens: 22, costUsd: 0.5 });
    fake.push({ id: "msg_idle", type: "idle", time: { created: Date.now() }, outcome: "succeeded" });
    await nextEvent(iterator, "turn.completed");
    const updates = adapter.buffer.read(turn.agentId).events.filter((event) => event.type === "usage.updated");
    assert.equal(updates.length, 2, "an unchanged poll does not repeat the event");
  } finally {
    await adapter.closeAll();
    fake.close();
  }
});
