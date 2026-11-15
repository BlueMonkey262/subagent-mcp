import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const transcript = process.env.ANTIGRAVITY_FIXTURE_TRANSCRIPT;
const invocation = process.env.ANTIGRAVITY_FIXTURE_INVOCATION;
const conversationIndex = process.argv.indexOf("--conversation");
const conversationId = conversationIndex >= 0
  ? process.argv[conversationIndex + 1]
  : process.env.ANTIGRAVITY_FIXTURE_CONVERSATION_ID ?? "22222222-2222-4222-8222-222222222222";
let step = 0;

if (invocation) {
  writeFileSync(invocation, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), customEnv: process.env.ANTIGRAVITY_FIXTURE_CUSTOM }));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendDeniedStep(index) {
  const tool = { name: "run_command", parameters: { CommandLine: "date" } };
  send({ event: "step_update", step_update: {
    conversation_id: conversationId, step_index: index, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: tool,
  } });
  send({ event: "step_update", step_update: {
    conversation_id: conversationId, step_index: index, step_type: "tool", state: "ERROR", tool_name: "run_command",
    tool_info: { ...tool, error: { type: "TOOL_ERROR", message: "permission check failed for unsandboxed \"date\": user denied permission to run command:\ndate" } },
  } });
}

send({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), permission_mode: "request-review" } });

// Keep the fixture alive when the test runner has not yet written a prompt.
const keepAlive = setInterval(() => {}, 1_000);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (transcript) appendFileSync(transcript, `${line}\n`);
  const message = JSON.parse(line);
  if (message.event !== "user") return;
  const prompt = String(message.message?.content ?? "");
  if (prompt.includes("MALFORMED") && !prompt.includes("DENIED")) {
    process.stdout.write("not-json\n");
    return;
  }
  if (prompt.includes("EXIT_EARLY")) {
    process.exit(17);
    return;
  }
  if (prompt.includes("HANG")) return;
  if (prompt.includes("TOOL_FAIL")) {
    step += 1;
    const index = step * 10;
    const tool = { name: "run_command", parameters: { CommandLine: "false" } };
    send({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: index, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: tool,
    } });
    send({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: index, step_type: "tool", state: "ERROR", tool_name: "run_command",
      tool_info: { ...tool, output: "", error: { type: "TOOL_ERROR", message: "exit status 1" } },
    } });
    send({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "The command failed.",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_tokens: 0, total_tokens: 4 },
    } });
    return;
  }
  if (prompt.includes("ERROR_OUTPUT")) {
    step += 1;
    const index = step * 10;
    const tool = { name: "write_file", parameters: { Path: "notes.txt" } };
    send({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: index, step_type: "tool", state: "ACTIVE", tool_name: "write_file", tool_info: tool,
    } });
    send({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: index, step_type: "tool", state: "ERROR", tool_name: "write_file",
      tool_info: { ...tool, output: "", error: { type: "TOOL_ERROR", message: "disk full while writing notes.txt" } },
    } });
    send({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "I could not write the file.",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_tokens: 0, total_tokens: 4 },
    } });
    return;
  }
  if (prompt.includes("DENIED")) {
    // Live agy 1.2.x shape for a headless auto-denial: the tool step ends in ERROR and the result
    // still says SUCCESS, with denied_actions and (when the model stops there) an empty response.
    step += 1;
    const index = step * 10;
    sendDeniedStep(index);
    const explained = prompt.includes("EXPLAINED");
    const whitespace = prompt.includes("WHITESPACE");
    let deniedActions;
    if (prompt.includes("NO_ACTIONS")) deniedActions = undefined;
    else if (prompt.includes("MALFORMED")) deniedActions = [{ display_name: "RunCommand" }];
    else if (prompt.includes("NO_ACTION")) deniedActions = [{}];
    else deniedActions = [{ action: "command", display_name: "RunCommand" }];
    send({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS",
      response: whitespace ? " \n\t " : explained ? "I could not run date: permission denied." : "",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_tokens: 0, total_tokens: 4 },
      ...(deniedActions === undefined ? {} : { denied_actions: deniedActions }),
    } });
    return;
  }
  step += 1;
  const index = step * 10;
  send({ event: "step_update", step_update: {
    conversation_id: conversationId, step_index: index, step_type: "tool", state: "ACTIVE", tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "echo fixture" } },
  } });
  send({ event: "step_update", step_update: {
    conversation_id: conversationId, step_index: index, step_type: "tool", state: "DONE", tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "echo fixture" }, output: "fixture\n" },
  } });
  send({ event: "step_update", step_update: {
    conversation_id: conversationId, step_index: index + 1, step_type: "agent_response", state: "DONE", text_delta: `Assistant: turn ${step}\n`,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_tokens: 2, total_tokens: 10 },
  } });
  send({ event: "result", result: {
    conversation_id: conversationId, status: "SUCCESS", response: `<system-reminder>final ${step}</system-reminder>`,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_tokens: 2, total_tokens: 10 },
  } });
});

process.on("SIGINT", () => {
  send({ event: "result", result: { conversation_id: conversationId, status: "INTERRUPTED", response: "" } });
});
process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
