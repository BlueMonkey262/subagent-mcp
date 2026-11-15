#!/usr/bin/env node
// Offline stand-in for `vibe-acp` (ACP over stdio, one JSON-RPC message per line). Message shapes
// follow what vibe-acp 3.1.2 sent live (docs/protocol/vibe-acp.md). The prompt text selects a
// scenario; every request is appended to VIBE_ACP_FIXTURE_LOG; cumulative usage persists in
// VIBE_ACP_FIXTURE_STATE so a resumed process reports the session's history like Vibe does.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const logPath = process.env.VIBE_ACP_FIXTURE_LOG;
const statePath = process.env.VIBE_ACP_FIXTURE_STATE;
const model = process.env.VIBE_ACTIVE_MODEL ?? "";
const log = (entry) => { if (logPath) appendFileSync(logPath, `${JSON.stringify({ ...entry, model, pid: process.pid })}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });

let totals = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { input: 0, output: 0, cached: 0, cost: 0 };
const saveTotals = () => { if (statePath) writeFileSync(statePath, JSON.stringify(totals)); };
const usageUpdate = (sessionId) => update(sessionId, {
  sessionUpdate: "usage_update", used: totals.input, size: 200000,
  ...(totals.cost > 0 ? { cost: { amount: totals.cost, currency: "USD" } } : {}),
  _meta: { steps: 1, promptTokens: totals.input, completionTokens: totals.output, cachedTokens: totals.cached, totalTokens: totals.input + totals.output },
});
const promptUsage = () => ({ totalTokens: totals.input + totals.output, inputTokens: totals.input, outputTokens: totals.output, cachedReadTokens: totals.cached });

const OPTIONS = process.env.VIBE_ACP_FIXTURE_OPTIONS === "once_only"
  ? [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }, { optionId: "reject_once", name: "Deny", kind: "reject_once" }]
  : [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for remainder of this session", kind: "allow_always" },
    { optionId: "allow_always_permanent", name: "Always allow", kind: "allow_always" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ];

let nextId = 1000;
const waiting = new Map();
let cancelled = () => undefined;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt?.[0]?.text ?? "";
  log({ method: "session/prompt", text });
  const finish = (stopReason = "end_turn") => { saveTotals(); usageUpdate(sessionId); send({ id, result: { stopReason, usage: promptUsage() } }); };
  update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, messageId: "user-1" });
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" }, messageId: "reasoning-1" });
  if (text.includes("CRASH")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" }, messageId: "m-crash" });
    process.stderr.write("fixture crashed\n");
    setTimeout(() => process.exit(1), 10);
    return;
  }
  if (text.includes("SLOW")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "effect-slow", title: "Running sleep", kind: "execute", status: "in_progress", rawInput: { command: "sleep 100" }, _meta: { tool_name: "bash" } });
    const permission = text.includes("PERMISSION") ? ask("session/request_permission", { sessionId, toolCall: { toolCallId: "effect-slow" }, options: OPTIONS }) : undefined;
    if (text.includes("IGNORE_CANCEL")) return;
    await new Promise((resolve) => { cancelled = resolve; });
    if (permission) log({ method: "permission-after-cancel", response: await permission });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "effect-slow", status: "failed", rawOutput: { error: { code: "cancelled" } } });
    finish("cancelled");
    return;
  }
  if (text.includes("FSREQ")) {
    const response = await ask("fs/read_text_file", { sessionId, path: "/etc/hosts" });
    log({ method: "fs-response", response });
  }
  if (text.includes("APPROVE")) {
    const shell = text.includes("SHELL");
    update(sessionId, shell
      ? { sessionUpdate: "tool_call", toolCallId: "effect-1", title: "Running rm", kind: "execute", status: "in_progress", rawInput: { command: "rm -rf build" }, _meta: { tool_name: "bash", effect_kind: "shell" } }
      : { sessionUpdate: "tool_call", toolCallId: "effect-1", title: "Writing out.txt", kind: "edit", status: "in_progress", content: [{ type: "diff", path: "out.txt", newText: "hi" }],
        locations: [{ path: `${process.cwd()}/out.txt` }], rawInput: { filePath: "out.txt", content: "hi" }, _meta: { tool_name: "write_file", effect_kind: "file_write" } });
    const response = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "effect-1" }, options: OPTIONS });
    log({ method: "permission-response", response });
    const outcome = response?.outcome;
    const allowed = outcome?.outcome === "selected" && String(outcome.optionId).startsWith("allow");
    update(sessionId, allowed
      ? { sessionUpdate: "tool_call_update", toolCallId: "effect-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] }
      : { sessionUpdate: "tool_call_update", toolCallId: "effect-1", status: "failed", content: [{ type: "content", content: { type: "text", text: "Tool execution denied by approval callback" } }],
        rawOutput: { type: "failure", error: { code: "tool_denied", message: "Tool execution denied by approval callback" } } });
    totals = { ...totals, input: totals.input + 50, output: totals.output + 5 };
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done:${outcome?.optionId ?? outcome?.outcome}` }, messageId: "m-approve" });
    finish();
    return;
  }
  if (text.includes("LIMIT")) { finish("max_turn_requests"); return; }
  totals = { input: totals.input + 100, output: totals.output + 10, cached: totals.cached + 40, cost: totals.cost + 0.01 };
  usageUpdate(sessionId);
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" }, messageId: "m-1" });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" }, messageId: "m-1" });
  finish();
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.result ?? { error: message.error });
    return;
  }
  const { id, method, params = {} } = message;
  if (method !== "session/prompt") log({ method, params });
  switch (method) {
    case "initialize":
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "@mistralai/mistral-vibe", version: "3.1.2" } } });
      return;
    case "session/new": {
      const sessionId = process.env.VIBE_ACP_FIXTURE_SESSION ?? "acp-sess-1";
      const running = model === "unknown-alias" ? "mistral-medium-3.5" : model;
      usageUpdate(sessionId);
      send({ id, result: { sessionId, modes: { currentModeId: "accept-edits" }, configOptions: [
        { id: "mode", currentValue: "accept-edits", type: "select", options: [] },
        { id: "model", currentValue: running, type: "select", options: [{ value: "mistral-medium-3.5" }, { value: "zai-glm-5-3-flash" }] },
      ] } });
      return;
    }
    case "session/resume":
      if (process.env.VIBE_ACP_FIXTURE_NO_RESUME) { send({ id, error: { code: -32601, message: "Method not found" } }); return; }
      usageUpdate(params.sessionId);
      send({ id, result: {} });
      return;
    case "session/load":
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" }, messageId: "m-old" });
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "effect-old", title: "old", kind: "edit", status: "completed" });
      usageUpdate(params.sessionId);
      send({ id, result: {} });
      return;
    case "session/set_mode":
    case "session/set_config_option":
      send({ id, result: {} });
      return;
    case "session/cancel":
      cancelled();
      return;
    case "session/prompt":
      void prompt(id, params);
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown ${method}` } });
  }
}
