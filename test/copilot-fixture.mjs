import { existsSync, rmSync, writeFileSync } from "node:fs";

// Stand-in for the GitHub Copilot CLI in `--output-format json --prompt=...` mode: one process per
// turn, JSONL on stdout, then exit. Record shapes follow live `copilot 1.0.109` output.
// Behavior is selected by keywords in the prompt.

const invocation = process.env.COPILOT_FIXTURE_INVOCATION;
const args = process.argv.slice(2);

function optionValue(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed === undefined ? undefined : prefixed.slice(name.length + 1);
}

function optionValues(name) {
  const values = [];
  args.forEach((arg, index) => { if (arg === name) values.push(args[index + 1]); });
  return values;
}

const prompt = optionValue("--prompt") ?? "";
const resumed = optionValue("--resume");
const sessionId = resumed ?? process.env.COPILOT_FIXTURE_SESSION_ID ?? "44444444-4444-4444-8444-444444444444";
const model = optionValue("--model") ?? "auto";

if (invocation) {
  writeFileSync(invocation, JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    model,
    resume: resumed,
    effort: optionValue("--reasoning-effort"),
    allowAll: args.includes("--allow-all-tools"),
    allowTools: optionValues("--allow-tool"),
    denyTools: optionValues("--deny-tool"),
    prompt,
    customEnv: process.env.COPILOT_FIXTURE_CUSTOM,
  }));
}

let counter = 0;
function send(type, data, extra = {}) {
  counter += 1;
  process.stdout.write(`${JSON.stringify({ type, data, id: `evt-${counter}`, timestamp: new Date().toISOString(), ...extra })}\n`);
}

function result(exitCode) {
  process.stdout.write(`${JSON.stringify({
    type: "result",
    timestamp: new Date().toISOString(),
    sessionId,
    exitCode,
    usage: { premiumRequests: exitCode === 0 ? 1 : 0, totalApiDurationMs: 5, sessionDurationMs: 10 },
  })}\n`);
}

// Copilot locks a session while its process runs; COPILOT_FIXTURE_LOCK models that lock.
const lock = process.env.COPILOT_FIXTURE_LOCK;
if (lock && resumed && existsSync(lock)) {
  process.stderr.write(`SessionInUseError: Session ${sessionId} is in use by another Copilot process.\n`);
  process.exit(1);
}
if (lock) writeFileSync(lock, String(process.pid));

/** Flush stdout, then exit with `code` so the parent reads every line before the pipe closes. */
function finish(code = 0) {
  // LINGER keeps the process alive briefly after `result`, as live Copilot does while it saves.
  const delay = prompt.includes("LINGER") ? 400 : 0;
  process.stdout.write("", () => setTimeout(() => {
    if (lock) rmSync(lock, { force: true });
    process.exit(code);
  }, delay));
}

if (prompt.includes("STARTUP_ERROR")) {
  // Live behavior for a rejected flag combination: plain text, then a result with no session.start.
  process.stdout.write("Error: Model \"auto\" does not support reasoning effort configuration (requested: \"low\").\n");
  result(1);
  finish(1);
} else {
  if (resumed) {
    send("session.resume", { resumeTime: new Date().toISOString(), eventCount: 3, selectedModel: model });
  } else {
    send("session.start", { sessionId, version: 1, producer: "copilot-agent", copilotVersion: "fixture", selectedModel: model });
  }
  send("session.mcp_server_status_changed", { serverName: "github-mcp-server", status: "connected" }, { ephemeral: true });
  send("user.message", { content: prompt, turnId: "0" });

  if (prompt.includes("MALFORMED")) {
    process.stdout.write(`${JSON.stringify({ data: { note: "no type" } })}\n`);
    setInterval(() => {}, 1_000);
  } else if (prompt.includes("EXIT_EARLY")) {
    finish(17);
  } else if (prompt.includes("HANG")) {
    send("assistant.message", { messageId: "m-0", content: "working on it", toolRequests: [], turnId: "0" });
    setInterval(() => {}, 1_000);
  } else if (prompt.includes("MODEL_UNAVAILABLE")) {
    send("session.error", { errorType: "query", message: `Execution failed: Model "${model}" is not available.` });
    send("assistant.idle", {}, { ephemeral: true });
    result(1);
    finish(1);
  } else {
    send("assistant.turn_start", { turnId: "0" });
    send("assistant.message_delta", { messageId: "m-1", deltaContent: "Let" }, { ephemeral: true });
    send("assistant.message", { messageId: "m-1", content: "Let me look.", toolRequests: [], turnId: "0" });
    send("tool.execution_start", {
      toolCallId: "call-1",
      toolName: "bash",
      arguments: { command: "echo hi", description: "fixture command", mode: "sync" },
      turnId: "0",
    });
    send("tool.shell_output", { toolCallId: "call-1", stream: "stdout", text: "hi\n" }, { ephemeral: true });
    send("tool.execution_complete", {
      toolCallId: "call-1",
      success: true,
      result: { content: "hi\n<shellId: 0 completed with exit code 0>" },
      turnId: "0",
    });
    send("tool.execution_start", {
      toolCallId: "call-2",
      toolName: "bash",
      arguments: { command: "touch denied.txt", mode: "sync" },
      turnId: "0",
    });
    send("tool.execution_complete", {
      toolCallId: "call-2",
      success: false,
      error: { message: "Permission denied because no interactive user response was available.", code: "denied" },
      turnId: "0",
    });
    send("assistant.turn_end", { turnId: "0" });
    send("assistant.message", { messageId: "m-2", content: prompt.includes("SECOND") ? "final 2" : "final 1", toolRequests: [], turnId: "1", phase: "final_answer" });
    send("session.usage_checkpoint", { totalNanoAiu: 1, totalPremiumRequests: 1 });
    send("assistant.idle", {}, { ephemeral: true });
    result(0);
    finish(0);
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
