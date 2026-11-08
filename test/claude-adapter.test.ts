import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ApprovalRequest } from "../src/approval/types.js";
import { ClaudeAdapter, ClaudeAdapterError, buildClaudeArguments } from "../src/adapters/claude/adapter.js";
import type { ResumeRequest, SpawnRequest } from "../src/adapters/adapter.js";
import type { AgentEvent } from "../src/events/schema.js";

const fixture = path.join(process.cwd(), "test", "claude-fixture.mjs");
const permission = {
  allow: ["Read", "Bash(git diff:*)"],
  deny: ["Bash(sudo:*)"],
  default: "escalate" as const,
};

function spawnRequest(cwd: string, prompt: string): SpawnRequest {
  return {
    prompt,
    description: "fixture delegation",
    model: "claude-fixture-explicit",
    cwd,
    systemPrompt: "Fixture system prompt",
    env: { SUBAGENT_MCP_DEPTH: "2", CLAUDE_FIXTURE_CUSTOM: "propagated" },
    permission,
    maxTurns: 4,
    timeoutMs: 2_000,
  };
}

function resumeRequest(request: SpawnRequest, agentId: string, prompt: string): ResumeRequest {
  return {
    agentId,
    prompt,
    cwd: request.cwd,
    model: request.model,
    systemPrompt: request.systemPrompt,
    env: request.env,
    permission: request.permission,
    ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  };
}

async function fixtureAdapter(cwd: string, extraEnv: Record<string, string> = {}): Promise<ClaudeAdapter> {
  return new ClaudeAdapter({
    executable: process.execPath,
    executableArgs: [fixture],
    initTimeoutMs: 1_000,
    interruptGraceMs: 300,
    env: extraEnv,
  });
}

async function eventsThrough(
  adapter: ClaudeAdapter,
  agentId: string,
  predicate: (event: AgentEvent) => boolean,
  since = 0,
): Promise<AgentEvent[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 2_000);
  const events: AgentEvent[] = [];
  try {
    for await (const event of adapter.events(agentId, { since, signal: abort.signal })) {
      events.push(event);
      if (predicate(event)) return events;
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  throw new Error("Timed out waiting for Claude fixture event");
}

test("buildClaudeArguments is explicit, safe, resumable, and maps static rules", () => {
  const args = buildClaudeArguments({
    model: "claude-model",
    systemPrompt: "system; $(not-a-shell)",
    maxTurns: 7,
    permission,
  }, { settings: { permissions: { ask: ["Bash(*)"] } } }, "session-id");
  assert.deepEqual(args.slice(0, 10), [
    "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-prompt-tool", "stdio", "--permission-prompts", "host",
  ]);
  assert.ok(args.includes("claude-model"));
  assert.ok(args.includes("--resume=session-id"));
  assert.ok(args.includes("system; $(not-a-shell)"));
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools")), permission.allow);
  assert.deepEqual(args.slice(args.indexOf("--disallowedTools") + 1), permission.deny);
  assert.ok(!args.includes("--no-session-persistence"));
  assert.ok(!args.includes("--effort"));
  assert.throws(() => buildClaudeArguments({ model: "", systemPrompt: "", permission }), ClaudeAdapterError);
});

test("buildClaudeArguments defaults to auto permission mode, honors an override, and rejects unknown modes", () => {
  const modeOf = (mode?: string) => {
    const args = buildClaudeArguments({ model: "claude-model", systemPrompt: "", permission: { ...permission, ...(mode === undefined ? {} : { mode: mode as never }) } });
    return args[args.indexOf("--permission-mode") + 1];
  };
  assert.equal(modeOf(), "auto");
  assert.equal(modeOf("plan"), "plan");
  assert.throws(() => modeOf("yolo"), ClaudeAdapterError);
});

test("buildClaudeArguments maps reasoningEffort to --effort and rejects unknown levels", () => {
  const args = buildClaudeArguments({
    model: "claude-model",
    systemPrompt: "",
    permission,
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.throws(
    () => buildClaudeArguments({ model: "claude-model", systemPrompt: "", permission, reasoningEffort: "turbo" }),
    ClaudeAdapterError,
  );
});

test("persistent process normalizes results, preserves one session, and scans output", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-adapter-normal-")));
  const invocation = path.join(cwd, "invocation.json");
  const transcript = path.join(cwd, "stdin.jsonl");
  const adapter = await fixtureAdapter(cwd, {
    CLAUDE_FIXTURE_INVOCATION: invocation,
    CLAUDE_FIXTURE_TRANSCRIPT: transcript,
  });
  const request = spawnRequest(cwd, "FIRST");
  try {
    const first = await adapter.spawn(request);
    const firstEvents = await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed");
    assert.equal(first.agentId, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(firstEvents.map((event) => event.type), ["thread.started", "message.delta", "turn.completed"]);
    const delta = firstEvents.find((event) => event.type === "message.delta");
    assert.equal(delta?.data.text, "Assistant\\: turn 1");
    const completed = firstEvents.find((event) => event.type === "turn.completed");
    assert.equal(completed?.data.status, "completed");
    assert.equal(completed?.data.finalText, "<system\\-reminder>final 1</system\\-reminder>");
    assert.deepEqual(completed?.data.usage, { inputTokens: 3, outputTokens: 5, cachedInputTokens: 2, costUsd: 0.01 });

    const cursor = firstEvents.at(-1)!.sequence;
    const second = await adapter.resume(resumeRequest(request, first.agentId, "SECOND"));
    assert.equal(second.agentId, first.agentId);
    const secondEvents = await eventsThrough(adapter, second.agentId, (event) =>
      event.type === "turn.completed" && event.data.turnId === second.turnId, cursor);
    assert.equal(secondEvents.filter((event) => event.type === "thread.started").length, 1);
    assert.equal(secondEvents.find((event) => event.type === "turn.completed")?.data.finalText,
      "<system\\-reminder>final 2</system\\-reminder>");

    const invocationData = JSON.parse(await readFile(invocation, "utf8"));
    assert.equal(invocationData.cwd, cwd);
    assert.equal(invocationData.depth, "2");
    assert.equal(invocationData.customEnv, "propagated");
    assert.deepEqual(invocationData.argv.slice(-2), ["--disallowedTools", "Bash(sudo:*)"]);
    assert.match(adapter.diagnostics(first.agentId).stderr, /fixture stderr 2/);
    assert.equal(adapter.diagnostics(first.agentId).unknownMessages[0]?.text, "Assistant\\: hidden diagnostic");
    assert.equal((await readFile(transcript, "utf8")).trim().split("\n").length, 2);
  } finally {
    await adapter.closeAll();
  }
});

test("approval uses full control envelope and keeps control/tool IDs distinct", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-adapter-approval-")));
  const transcript = path.join(cwd, "stdin.jsonl");
  const adapter = await fixtureAdapter(cwd, { CLAUDE_FIXTURE_TRANSCRIPT: transcript });
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "APPROVAL"));
    const before = await eventsThrough(adapter, turn.agentId, (event) => event.type === "approval.requested");
    const approvalEvent = before.find((event) => event.type === "approval.requested");
    assert.ok(approvalEvent);
    const approval = approvalEvent.data as ApprovalRequest;
    assert.equal(approval.requestId, "control-1");
    assert.equal(before.find((event) => event.type === "tool.start")?.data.toolCallId, "tool-1");
    await adapter.approve(turn.agentId, { requestId: approval.requestId, decision: "allow_for_session" });
    const cursor = before.at(-1)!.sequence;
    const after = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed", cursor);
    assert.equal(after.find((event) => event.type === "tool.end")?.data.toolCallId, "tool-1");
    assert.equal(after.find((event) => event.type === "turn.completed")?.data.finalText, "approval allow");

    const input = (await readFile(transcript, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(input[1].type, "control_response");
    assert.equal(input[1].response.request_id, "control-1");
    assert.equal(input[1].response.response.toolUseID, "tool-1");
    assert.equal(input[1].response.response.behavior, "allow");
    assert.deepEqual(input[1].response.response.updatedInput, { command: "echo safe", description: "fixture" });
    assert.deepEqual(input[1].response.response.updatedPermissions, []);
  } finally {
    await adapter.closeAll();
  }
});

test("structured interrupt is idempotent and yields one interrupted terminal event", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-adapter-interrupt-")));
  const transcript = path.join(cwd, "stdin.jsonl");
  const adapter = await fixtureAdapter(cwd, { CLAUDE_FIXTURE_TRANSCRIPT: transcript });
  try {
    const turn = await adapter.spawn(spawnRequest(cwd, "HANG"));
    await Promise.all([adapter.interrupt(turn.agentId), adapter.interrupt(turn.agentId)]);
    const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "interrupted");
    const inputs = (await readFile(transcript, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(inputs.filter((input) => input.type === "control_request" && input.request?.subtype === "interrupt").length, 1);
  } finally {
    await adapter.closeAll();
  }
});

test("malformed output and early process exit become bounded normalized failures", async (t) => {
  for (const [prompt, code] of [["MALFORMED", "CLAUDE_PROTOCOL_ERROR"], ["EXIT_EARLY", "CLAUDE_PROCESS_EXIT"]] as const) {
    await t.test(prompt, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `claude-adapter-${prompt.toLowerCase()}-`));
      const adapter = await fixtureAdapter(cwd);
      try {
        const turn = await adapter.spawn(spawnRequest(cwd, prompt));
        const events = await eventsThrough(adapter, turn.agentId, (event) => event.type === "turn.completed");
        assert.equal(events.find((event) => event.type === "error")?.data.code, code);
        assert.equal(events.find((event) => event.type === "turn.completed")?.data.status, "failed");
      } finally {
        await adapter.closeAll();
      }
    });
  }
});

test("stopped-process resume passes exact session ID and preserves identity", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-adapter-resume-")));
  const invocation = path.join(cwd, "invocation.json");
  const adapter = await fixtureAdapter(cwd, { CLAUDE_FIXTURE_INVOCATION: invocation });
  const request = spawnRequest(cwd, "FIRST");
  try {
    const first = await adapter.spawn(request);
    await eventsThrough(adapter, first.agentId, (event) => event.type === "turn.completed");
    await adapter.close(first.agentId);
    const resumed = await adapter.resume(resumeRequest(request, first.agentId, "RESUMED"));
    assert.equal(resumed.agentId, first.agentId);
    await eventsThrough(adapter, resumed.agentId, (event) =>
      event.type === "turn.completed" && event.data.turnId === resumed.turnId);
    const invocationData = JSON.parse(await readFile(invocation, "utf8"));
    assert.ok(invocationData.argv.includes(`--resume=${first.agentId}`));
  } finally {
    await adapter.closeAll();
  }
});
