# Google Antigravity CLI adapter protocol

Status: **partially verified against `agy 1.2.7` on Linux**. Live authenticated probes verified
the NDJSON envelope, two turns on one persistent process, and cold `--conversation` resume with
preserved context. The adapter's process behavior is also covered by deterministic fixtures.
Interruption, custom-agent selection, tool records, and native permission soft-denial still need
a redacted live acceptance transcript before they are promoted to live-verified behavior.

## Invocation

Run one persistent process per conversation:

```text
agy --input-format stream-json --output-format stream-json \
  --model <explicit-model> --agent <configured-custom-agent>
```

The adapter may add `--effort low|medium|high`, `--print-timeout <duration>`, and, for a cold
resume, `--conversation <conversation-id>`. Do not pass `--dangerously-skip-permissions`.

`--agent` selects an Antigravity custom agent whose Markdown body becomes its system prompt.
The project config's `antigravityAgent` must name an agent that Antigravity discovers from
`.agents/agents/<name>.md` or its configured global location. This bridge does not generate
workspace agent files or lower a system prompt into a user message.

Verified on agy 1.2.x:

- The agent file's frontmatter must list `tools` (for example
  `tools: [read_file, edit_file, write_file, run_command, manage_task, search_web]`). Without it,
  agy grants a small read-only default set (`read_file`, `search_web`, `manage_task` and a few
  others), so the agent cannot run commands or edit files.
- The global location `~/.gemini/antigravity-cli/agents/<name>/agent.md` is discovered from any
  working directory. Use it for `isolation: worktree` in projects that do not commit `.agents/`,
  because a managed worktree only contains committed files.

## Input

Each turn is one newline-delimited JSON object on stdin; retain the stdin stream after a result:

```json
{"event":"user","message":{"content":"Perform the delegated task."}}
```

`message.content` can be a string or text-block list. A persistent process receives another
user event for a warm resume. The documented cold-resume mechanism is a new process with
`--conversation <id>`; the adapter requires the next `init.conversation_id` to equal that id.
On the verified 1.2.7 installation, a new stream-json process given an emitted ID returned the
same ID and correctly recalled the preceding turn.

## Observed output

The live probe produced this sequence:

1. `init` with a top-level `conversation_id` and `init` details including `model`, `cwd`,
   `tools`, and `permission_mode`.
2. `step_update` records with `step_update.conversation_id`, `step_index`, `state`, and
   `step_type`; `agent_response` records carry `text_delta` and optional `usage`.
3. One terminal `result` record with `result.status`, `response`, `duration_seconds`,
   `num_turns`, and `usage`.

The adapter maps `SUCCESS` to a completed turn, `CANCELED`/`INTERRUPTED` to interrupted, and
all other terminal statuses to failed. It maps `input_tokens`, `output_tokens`, and
`cache_read_tokens` to the bridge's normalized usage fields. Whether `input_tokens` includes
`cache_read_tokens` is unverified, so the adapter leaves `uncachedInputTokens` unset and status
rows show a single input count. `agent_response.text_delta` is a
display delta, while `result.response` is the final result.

Tool `step_update` records are normalized by their turn-local `step_index`; `tool_info.name`,
`parameters`, `output`, and `error` provide the normalized tool lifecycle data. The decoder
tolerates unknown additive event types but fails on malformed JSON or missing required init/result
payloads. Stderr remains bounded diagnostics and never enters the NDJSON decoder.

## Permissions and interruption

Headless mode has no documented stdin approval-response message. Antigravity's own allow/ask/deny
rules control tool execution; an action that cannot be approved headlessly is soft-denied by the
CLI. Therefore this adapter does not emit `approval.requested`, cannot use the bridge's
`resolve_approval`, and exposes `relaysDenyMessage: false`. Native tool failures remain visible
as failed `tool.end` events when the CLI supplies `tool_info.error`.

A headless auto-denial (verified on agy 1.2.x) looks like this:

1. The tool's `step_update` ends in `state: "ERROR"` (not `DONE`) with
   `tool_info.error.message` starting `permission check failed ... user denied permission`. The
   adapter ends that tool with status `denied`; any other `ERROR` step ends it `failed`.
2. The `result` still has `status: "SUCCESS"`, carries
   `denied_actions: [{"action": "command", "display_name": "RunCommand"}]`, and often an empty
   `response`, because the model stops there.
3. stderr explains the fix (`Add an allow-rule under permissions.allow in settings.json`).

The adapter emits a non-fatal `ANTIGRAVITY_PERMISSION_DENIED` error naming the denied actions.
When the response is empty it fails the turn and uses that explanation as `finalText`, so the
parent never receives an empty success. Allow rules go in
`~/.gemini/antigravity-cli/settings.json`, for example:

```json
{ "permissions": { "allow": ["command(git)", "write_file(/path/to/repo)"], "deny": ["command(sudo)"] } }
```

For interruption the adapter sends `SIGINT`, waits a short grace interval for a terminal `result`,
then emits one interrupted terminal event and terminates the owned process if the CLI does not
settle. This behavior is fixture-tested; capture its real signal/result ordering before relying
on it for release certification.

## Required promotion probe

With an authenticated `agy` installation and a harmless custom agent, record redacted NDJSON for:

- two turns on one persistent process;
- one harmless tool call and a native soft-denial under configured policy;
- interrupt while a turn is active; and
- malformed/failed model execution.

Assert stable `conversation_id` correlation, one terminal result per turn, bounded diagnostics,
and no use of `--dangerously-skip-permissions`.
