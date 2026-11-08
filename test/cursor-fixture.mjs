import { writeFileSync } from "node:fs";

// Stand-in for the Cursor `agent` CLI in `--print --output-format stream-json` mode: one process
// per turn, newline-delimited JSON on stdout, then exit. Modelled on test/claude-fixture.mjs and
// test/antigravity-fixture.mjs. Behaviour is selected by keywords in the prompt.

const invocation = process.env.CURSOR_FIXTURE_INVOCATION;
const args = process.argv.slice(2);

const VALUE_OPTIONS = new Set([
  "--output-format", "--sandbox", "--workspace", "--model", "--resume", "--mode",
  "--add-dir", "--plugin-dir", "--header", "--endpoint", "--api-key", "--worktree", "--worktree-base",
  "-H", "-e",
]);

function optionValue(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed === undefined ? undefined : prefixed.slice(name.length + 1);
}

const positionals = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg.startsWith("-")) {
    if (!arg.includes("=") && VALUE_OPTIONS.has(arg)) index += 1;
    continue;
  }
  positionals.push(arg);
}

const prompt = positionals.at(-1) ?? "";
const resumed = optionValue("--resume");
const sessionId = resumed ?? process.env.CURSOR_FIXTURE_SESSION_ID ?? "33333333-3333-4333-8333-333333333333";
const model = optionValue("--model") ?? "auto";
const force = args.includes("--force") || args.includes("--yolo");
const plan = args.includes("--plan") || optionValue("--mode") === "plan";

if (invocation) {
  writeFileSync(invocation, JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    model,
    resume: resumed,
    force,
    plan,
    prompt,
    customEnv: process.env.CURSOR_FIXTURE_CUSTOM,
  }));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Flush stdout, then exit with `code` so the parent reads every line before the pipe closes. */
function finish(code = 0) {
  process.stdout.write("", () => process.exit(code));
}

send({
  type: "system",
  subtype: "init",
  apiKeySource: "login",
  cwd: process.cwd(),
  session_id: sessionId,
  model: "Auto",
  permissionMode: plan ? "plan" : "default",
  additive_fixture_field: true,
});
send({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, session_id: sessionId });

if (prompt.includes("MALFORMED")) {
  process.stdout.write("not-json\n");
  // Stay alive; the adapter is expected to fail the turn on the malformed line and reap the process.
  setInterval(() => {}, 1_000);
} else if (prompt.includes("EXIT_EARLY")) {
  finish(17);
} else if (prompt.includes("HANG")) {
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] }, session_id: sessionId });
  // No result: the process hangs until stop_agent/timeout kills the group.
  setInterval(() => {}, 1_000);
} else if (prompt.includes("FAIL")) {
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "attempting the task" }] }, session_id: sessionId });
  send({
    type: "result",
    subtype: "error",
    duration_ms: 5,
    is_error: true,
    result: "fixture failure",
    session_id: sessionId,
    usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  finish(0);
} else {
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me look." }] }, session_id: sessionId });
  send({
    type: "tool_call",
    subtype: "started",
    call_id: "call-1",
    tool_call: { shellToolCall: { args: { command: "echo hi", description: "fixture command" } } },
    toolCallId: "call-1",
    session_id: sessionId,
    timestamp_ms: Date.now(),
  });
  send({
    type: "tool_call",
    subtype: "completed",
    call_id: "call-1",
    tool_call: {
      shellToolCall: {
        args: { command: "echo hi", description: "fixture command" },
        result: { success: { command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "" } },
      },
    },
    toolCallId: "call-1",
    session_id: sessionId,
    timestamp_ms: Date.now(),
  });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done." }] }, session_id: sessionId });
  send({
    type: "result",
    subtype: "success",
    duration_ms: 10,
    is_error: false,
    result: prompt.includes("SECOND") ? "final 2" : "final 1",
    session_id: sessionId,
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 3 },
  });
  finish(0);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
