import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Stand-in for Mistral Vibe 3.1.2 in `vibe -p --output streaming --output-dir DIR` mode: one
// process per turn, the prompt on stdin, one JSON line per completed history entry on stdout, then
// DIR/export.json and an exit code matching its outcome. Entry and export shapes follow
// vibe/app_server/models.py and vibe/cli-rust/src/run_export/model.rs. Behaviour is selected by
// keywords in the prompt.

const args = process.argv.slice(2);
const invocation = process.env.VIBE_FIXTURE_INVOCATION;

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function optionValues(name) {
  return args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));
}

const outputDir = optionValue("--output-dir");
const resumed = optionValue("--resume");
const sessionId = resumed ?? process.env.VIBE_FIXTURE_SESSION_ID ?? "44444444-4444-4444-8444-444444444444";
const model = optionValue("--model");
const prompt = readFileSync(0, "utf8");
const turnId = `turn-${process.pid}`;
let entryCount = 0;
const startedAt = new Date().toISOString();

if (invocation) {
  writeFileSync(invocation, JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    model,
    resume: resumed,
    prompt,
    autoApprove: args.includes("--auto-approve"),
    agent: optionValue("--agent"),
    enabledTools: optionValues("--enabled-tools"),
    workdir: optionValue("--workdir"),
    timeLimit: optionValue("--time-limit"),
    maxTurns: optionValue("--max-turns"),
    lastArg: args.at(-1),
    customEnv: process.env.VIBE_FIXTURE_CUSTOM,
  }));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function base(extra = {}, session = sessionId) {
  entryCount += 1;
  return { id: `entry-${entryCount}`, sessionId: session, turnId, createdAt: 1, updatedAt: 1, generationStatus: "completed", ...extra };
}
function message(role, text, extra = {}) {
  send(base({ type: "message", role, content: [{ type: "text", text }], ...extra }));
}
function effect(toolName, input, state, session = sessionId) {
  send(base({ type: "effect", title: toolName, detail: { kind: "tool", toolName, display: {}, input }, state }, session));
}

function writeExport(outcome, exitCode, extra = {}) {
  if (!outputDir) return;
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "export.json"), JSON.stringify({
    outcome,
    stop_reason: null,
    error: null,
    session_id: sessionId,
    usage: { input_tokens: 1200, output_tokens: 80, cached_input_tokens: 1000, total_tokens: 1280 },
    cost_usd: 0.0042,
    steps: 2,
    // "CATALOG" in the prompt: the effective config names the alias used and Vibe's model table.
    config: prompt.includes("CATALOG") ? {
      active_model: resumed === undefined ? "mistral-medium-3.5" : "",
      models: {
        "mistral-medium-3.5": { name: "mistral-vibe-cli-latest", provider: "mistral", alias: "mistral-medium-3.5", display_name: "Mistral Medium 3.5",
          input_price: 1.5, output_price: 7.5, cached_input_price: 0.15, thinking: "high", thinking_levels: ["off", "high"], supports_images: true, max_context_length: 262144, max_output_tokens: null },
        "zai-glm-5-3-flash": { name: "zai-glm-5-3-flash-vibe-free", provider: "mistral", alias: "zai-glm-5-3-flash", input_price: 0.0, output_price: 0.0 },
      },
    } : {},
    schema_version: 1,
    vibe_version: "3.1.2",
    journal_dir: "session",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    limits: { max_turns: null, max_price: null, max_tokens: null, time_limit_s: null },
    exit_code: exitCode,
    ...extra,
  }));
}

function finish(outcome, exitCode, extra) {
  writeExport(outcome, exitCode, extra);
  process.stdout.write("", () => process.exit(exitCode));
}

if (prompt.includes("NO_SESSION")) {
  process.stderr.write("Error: unknown model alias\n");
  finish("usage_error", 1, { session_id: null, usage: null, cost_usd: null, steps: null, error: { message: "unknown model alias", code: null } });
} else if (prompt.includes("CRASH_EARLY")) {
  process.stderr.write("boom\n");
  process.exit(2);
} else {
  message("user", prompt, { source: "turn_start" });
  if (prompt.includes("HANG") || prompt.includes("IGNORE_TERM")) {
    process.on("SIGTERM", () => {
      if (prompt.includes("IGNORE_TERM")) return;
      message("assistant", "partial before stop");
      finish("terminated", 3, { stop_reason: "interrupted" });
    });
    setInterval(() => {}, 1_000);
  } else {
    if (prompt.includes("MALFORMED")) process.stdout.write("not-json\n");
    if (prompt.includes("SUBAGENT")) send(base({ type: "message", role: "assistant", content: [{ type: "text", text: "subagent chatter" }] }, "child-session")), effect("read_file", { filePath: "x" }, { status: "completed", output: {}, display: {} }, "child-session");
    if (prompt.includes("DENIED")) {
      effect("bash", { command: "rm -rf /" }, {
        status: "failed",
        error: { message: "Tool execution denied by approval callback", code: "tool_denied" },
        display: {},
        approvalSource: "user",
      });
    } else {
      effect("read_file", { filePath: "README.md" }, { status: "completed", output: { content: "hello" }, display: {} });
    }
    message("assistant", "discarded draft", { outcome: { type: "discarded", cause: "retry" } });
    const answer = prompt.includes("JSON_ANSWER") ? '{"ok":true}' : `done: ${resumed ? "resumed" : "fresh"} ${model ?? "(session model)"}`;
    message("assistant", answer);
    if (prompt.includes("NO_EXPORT")) {
      process.stdout.write("", () => process.exit(0));
    } else if (prompt.includes("LIMIT")) {
      finish("turn_limit", 3, { stop_reason: "limit" });
    } else if (prompt.includes("BAD_EXPORT")) {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "export.json"), "{ torn");
      process.stdout.write("", () => process.exit(0));
    } else if (prompt.includes("INFRA")) {
      finish("infrastructure_failure", 2, { error: { message: "model API unavailable", code: "backend_error" } });
    } else if (prompt.includes("WRONG_EXPORT_SESSION")) {
      finish("finished", 0, { session_id: "someone-else" });
    } else {
      finish("finished", 0, prompt.includes("WARN") ? { warnings: [{ message: "skill foo could not load", source: "foo" }] } : {});
    }
  }
}
