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

send({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), permission_mode: "request-review" } });

// Keep the fixture alive when the test runner has not yet written a prompt.
const keepAlive = setInterval(() => {}, 1_000);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (transcript) appendFileSync(transcript, `${line}\n`);
  const message = JSON.parse(line);
  if (message.event !== "user") return;
  const prompt = String(message.message?.content ?? "");
  if (prompt.includes("MALFORMED")) {
    process.stdout.write("not-json\n");
    return;
  }
  if (prompt.includes("EXIT_EARLY")) {
    process.exit(17);
    return;
  }
  if (prompt.includes("HANG")) return;
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
