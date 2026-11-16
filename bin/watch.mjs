#!/usr/bin/env node
// `subagent-mcp wait` and `subagent-mcp events`: completion signals for clients without Claude Code
// channels (the desktop app). Run from the project directory, or pass --cwd. Requires `npm run build`.
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { readResults, resultsLogPath, summarizeEntry, waitForAgentsCommand, WAIT_EXIT } from "../dist/src/watch.js";

const usage = `subagent-mcp wait <agent...> [--any] [--timeout SECONDS] [--max-result-chars N] [--cwd DIR]
subagent-mcp events [--follow] [--all | --since ISO-TIME] [--full] [--max-result-chars N] [--cwd DIR]

wait     block until the agents settle (or one needs approval), then print one JSON line per agent.
         Exit codes: 0 completed, 2 failed or interrupted, 3 needs approval, 124 --timeout reached,
         1 error. Agents are names or ids, as in wait_for_agents.
events   print one JSON line per settled turn from .subagents/memory/sessions.json.results.jsonl.
         With --follow, keep printing as turns settle (starting from now unless --all or --since).
         --full prints the log entries unchanged.
`;

const [command, ...rest] = process.argv.slice(2);
if (command === undefined || command === "-h" || command === "--help") {
  process.stdout.write(usage);
  process.exit(command === undefined ? 1 : 0);
}

const fail = (message) => {
  process.stderr.write(`subagent-mcp: ${message}\n\n${usage}`);
  process.exit(1);
};

let parsed;
try {
  parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      any: { type: "boolean" },
      timeout: { type: "string" },
      "max-result-chars": { type: "string" },
      follow: { type: "boolean", short: "f" },
      all: { type: "boolean" },
      since: { type: "string" },
      full: { type: "boolean" },
    },
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { values, positionals } = parsed;
const cwd = resolve(values.cwd ?? process.cwd());
const number = (name, text) => {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number`);
  return value;
};
const maxResultChars = number("max-result-chars", values["max-result-chars"]);
const write = (line) => process.stdout.write(`${line}\n`);

if (command === "wait") {
  if (positionals.length === 0) fail("wait needs at least one agent");
  const code = await waitForAgentsCommand({
    cwd,
    agents: positionals,
    mode: values.any ? "any" : "all",
    ...(values.timeout === undefined ? {} : { timeoutSeconds: number("timeout", values.timeout) }),
    ...(maxResultChars === undefined ? {} : { maxResultChars }),
    write,
  });
  process.exit(code);
} else if (command === "events") {
  if (positionals.length > 0) fail(`unexpected argument ${positionals[0]}`);
  const since = values.since === undefined ? undefined : Date.parse(values.since);
  if (since !== undefined && Number.isNaN(since)) fail("--since must be an ISO time");
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
  const entries = readResults(resultsLogPath(cwd), {
    fromStart: !values.follow || values.all === true || since !== undefined,
    follow: values.follow === true,
    signal: controller.signal,
  });
  for await (const entry of entries) {
    if (since !== undefined && !(Date.parse(entry.finished_at ?? "") > since)) continue;
    write(JSON.stringify(values.full ? entry : summarizeEntry(entry, maxResultChars ?? 500)));
  }
  process.exit(WAIT_EXIT.completed);
} else {
  fail(`unknown command ${command}`);
}
