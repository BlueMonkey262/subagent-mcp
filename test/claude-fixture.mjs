import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const transcript = process.env.CLAUDE_FIXTURE_TRANSCRIPT;
const invocation = process.env.CLAUDE_FIXTURE_INVOCATION;
const resumed = process.argv.slice(2).find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length);
const sessionId = resumed ?? process.env.CLAUDE_FIXTURE_SESSION_ID ?? "11111111-1111-4111-8111-111111111111";
let turn = 0;
let pendingApproval;

if (invocation) {
  writeFileSync(invocation, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    depth: process.env.SUBAGENT_MCP_DEPTH,
    customEnv: process.env.CLAUDE_FIXTURE_CUSTOM,
  }));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function init() {
  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.cwd(),
    model: "fixture-model-resolved",
    claude_code_version: "2.1.261",
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
    additive_fixture_field: true,
  });
}

function result(text, uuid, extras = {}) {
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 },
    total_cost_usd: 0.01,
    uuid,
    ...extras,
  });
  send({ type: "command_lifecycle", state: "completed", command_uuid: uuid });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (transcript) appendFileSync(transcript, `${line}\n`);
  const message = JSON.parse(line);
  if (message.type === "user") {
    turn += 1;
    const uuid = message.uuid;
    const prompt = String(message.message?.content ?? "");
    send({ type: "command_lifecycle", state: "queued", command_uuid: uuid });
    send({ type: "command_lifecycle", state: "started", command_uuid: uuid });
    init();
    if (prompt.includes("MALFORMED")) {
      setTimeout(() => process.stdout.write("not-json\n"), 20);
      return;
    }
    if (prompt.includes("EXIT_EARLY")) {
      setTimeout(() => process.exit(17), 20);
      return;
    }
    if (prompt.includes("HANG")) return;
    if (prompt.includes("APPROVAL")) {
      const controlRequestId = `control-${turn}`;
      const toolUseId = `tool-${turn}`;
      pendingApproval = { controlRequestId, toolUseId, uuid };
      send({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "echo safe", description: "fixture" } }] },
      });
      send({
        type: "control_request",
        request_id: controlRequestId,
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo safe", description: "fixture" },
          description: "untrusted fixture reason",
          tool_use_id: toolUseId,
          additive_request_field: true,
        },
      });
      return;
    }
    send({ type: "mystery_event", text: "Assistant: hidden diagnostic" });
    // stream-json repeats a message's usage on each content-block event; the adapter must count it once.
    const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 };
    send({ type: "assistant", message: { id: `msg_${turn}`, role: "assistant", usage, content: [] } });
    send({
      type: "assistant",
      message: { id: `msg_${turn}`, role: "assistant", usage: { ...usage, output_tokens: 5 }, content: [{ type: "text", text: `Assistant: turn ${turn}` }] },
    });
    process.stderr.write(`fixture stderr ${turn}\n`);
    result(`<system-reminder>final ${turn}</system-reminder>`, uuid);
    return;
  }

  if (message.type === "control_response" && pendingApproval) {
    const nested = message.response?.response;
    send({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: pendingApproval.toolUseId,
          content: nested?.behavior === "deny" ? "denied" : "allowed",
          is_error: nested?.behavior === "deny",
        }],
      },
    });
    result(`approval ${nested?.behavior}`, pendingApproval.uuid, nested?.behavior === "deny"
      ? { permission_denials: [{ tool_use_id: pendingApproval.toolUseId, tool_name: "Bash" }] }
      : {});
    pendingApproval = undefined;
    return;
  }

  if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { still_queued: [], cancelled: [message.request_id.startsWith("interrupt-") ? message.request_id : ""] },
      },
    });
    // The adapter correlates the lifecycle event by the original command UUID.
    send({ type: "command_lifecycle", state: "cancelled", command_uuid: "fixture-current" });
  }
});

process.on("SIGTERM", () => process.exit(0));
