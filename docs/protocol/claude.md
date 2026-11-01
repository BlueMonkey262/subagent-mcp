# Claude Code adapter protocol

## Verification target

Verified on Linux against the installed native binary:

- executable: `~/.local/bin/claude`
- resolved binary: `~/.local/share/claude/versions/2.1.261`
- version: `2.1.261 (Claude Code)`
- matching locally installed Agent SDK types: `@anthropic-ai/claude-agent-sdk` `0.3.220`

The live tests used a loopback-only mock Anthropic endpoint. They exercised the real CLI's stream parser, turn loop, Bash permission gate, persistence/resume logic, and interrupt control channel without sending an external API request or executing the requested Bash command.

Pin the Claude Code version used in CI and production. The stream-json control surface is only partly documented, `--permission-prompt-tool` is absent from this version's public `--help`, and both message fields and lifecycle events have changed across releases. Feature-detect `system/init.capabilities` in addition to checking the pinned version.

## Recommended invocation

Run one long-lived process per child session:

```text
claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --permission-prompt-tool stdio \
  --model <explicit-model>
```

Add the configured `--allowedTools`, `--disallowedTools`, `--permission-mode`, settings, system prompt, `--add-dir`, and budget/turn flags as needed. The product must always pass an explicit model; the CLI itself otherwise selects one, which is contrary to this project's no-default rule.

Important flag constraints observed in `--help`/binary diagnostics:

- stream-json input requires `--print` and stream-json output.
- stdin must remain readable for the lifetime of a streaming session.
- each input is one JSON object on one newline-terminated line. Do not pretty-print or split an object across lines.
- `--include-partial-messages` adds token-level `stream_event` output and requires print + stream-json output.
- `--replay-user-messages` echoes accepted input user messages; it is optional.
- `--no-session-persistence` prevents later resume and should not be used for resumable agents.
- stdout is the NDJSON protocol. Consume stderr separately as diagnostics; do not merge it into the JSON decoder.

The official TypeScript Agent SDK `0.3.220` constructs this same invocation and adds `--permission-prompt-tool stdio` whenever its `canUseTool` callback is supplied.

## Input protocol

### User turn

Send one line and keep stdin open:

```json
{"type":"user","message":{"role":"user","content":"Do the delegated task."},"parent_tool_use_id":null,"uuid":"<client-generated-uuid>"}
```

`message.content` may be a string or normal Anthropic message content blocks. `parent_tool_use_id` should be `null` for a top-level child turn. `uuid` is optional in the SDK type but should always be supplied: it is echoed as `command_uuid` in lifecycle events and permits precise cancellation/correlation. Optional fields supported by current SDK types include `priority` (`now`, `next`, `later`) and `shouldQuery`; the adapter does not need them for the initial implementation.

Multiple turns work over the same process. A live probe sent a second user line after the first `result`; both turns used the same `session_id`. Do not treat a `result` as process EOF. Close stdin only when disposing the session. The current binary emitted another `system/init` before the second turn, so consumers must tolerate init more than once.

### Client-to-worker control request

Control operations use the same stdin:

```json
{"type":"control_request","request_id":"<unique-id>","request":{"subtype":"interrupt","cancel_queued":true}}
```

Correlate the reply by `response.request_id`.

### Permission response

When answering a `can_use_tool` request, send:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<request-id>","response":{"behavior":"allow","updatedInput":{"command":"..."},"updatedPermissions":[],"toolUseID":"<tool-use-id>"}}}
```

or:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<request-id>","response":{"behavior":"deny","message":"Reason shown to the model","interrupt":false,"toolUseID":"<tool-use-id>"}}}
```

The outer `control_response` envelope is required for stdio. This corrects the brief's direct `{"behavior": ...}` examples, which describe the permission decision value, not the full stream-json message. Echo both the control `request_id` and permission `tool_use_id`. An adapter error may instead use `response.subtype: "error"` plus `error`, but a policy denial is a successful control exchange whose nested behavior is `deny`.

Current permission updates use camelCase in the nested response. Supported SDK variants are `addRules`, `replaceRules`, `removeRules`, `setMode`, `addDirectories`, and `removeDirectories`; destinations are `userSettings`, `projectSettings`, `localSettings`, `session`, or `cliArg`. Prefer `session` for this project's `allow_for_session` mapping and do not persist user/project settings without explicit authorization.

## Output protocol and lifecycle

Every output object is one NDJSON line. Treat the union as open: ignore/persist unknown event types rather than crashing. The useful core is:

1. `command_lifecycle` with `state: "queued"`, keyed by inbound `command_uuid`.
2. `command_lifecycle` with `state: "started"`.
3. `system/init`, containing at least `session_id`, `cwd`, `tools`, `mcp_servers`, `model`, `permissionMode`, `claude_code_version`, and `capabilities`.
4. zero or more `assistant` messages. `message.content` contains Anthropic content blocks such as text and tool use.
5. tool-result `user` messages after local tool execution or denial.
6. zero or more `control_request` messages, notably permissions.
7. one `result` per queried user turn.
8. `command_lifecycle` with `state: "completed"` (or `cancelled`).

With `--include-partial-messages`, `stream_event` carries raw Anthropic streaming events; assembled `assistant` messages are still the stable display/result boundary. Other currently typed outputs include system status and API retry events, tool progress, hook events, task/subagent events, auth status, permission-denied notices, and notifications.

A successful result currently resembles:

```json
{"type":"result","subtype":"success","is_error":false,"result":"final text","session_id":"<uuid>","num_turns":2,"stop_reason":"end_turn","permission_denials":[],"usage":{},"modelUsage":{},"total_cost_usd":0.0,"duration_ms":123,"duration_api_ms":100,"terminal_reason":"completed","uuid":"<event-uuid>"}
```

Do not equate `subtype: "success"` with every requested tool having run: the observed denial flow ended in a successful model turn while `permission_denials` contained the denied Bash tool use. Error result subtypes currently include `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, and `error_max_structured_output_retries`, with an `errors` array. Also handle process exit, malformed/non-JSON output, and a missing result as adapter errors.

## Permission requests

With `--permission-prompt-tool stdio`, the live binary emitted:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"echo SAFE_PERMISSION_PROBE","description":"Print a harmless marker"},"description":"Print a harmless marker","decision_reason_type":"rule","tool_use_id":"toolu_mock_1"}}
```

The full current request shape additionally permits `permission_suggestions`, `blocked_path`, `decision_reason`, `classifier_approvable`, `suppress_always_allow_rule`, `matched_ask_rule`, `title`, `agent_id`, and `requires_user_interaction`. Treat all human-readable strings and tool input as untrusted. `decision_reason_type` is an open-in-practice policy hint; current SDK types list `rule`, `mode`, `subcommandResults`, `permissionPromptTool`, `hook`, `asyncAgent`, `sandboxOverride`, `workingDir`, `safetyCheck`, `classifier`, and `other`.

Static policy is resolved before this callback: denied or auto-approved calls need not produce `can_use_tool`. The live forced-ask rule produced `decision_reason_type: "rule"`.

There is no permission park deadline in the current Agent SDK contract. A missing response can block the tool indefinitely. Maintain an adapter watchdog and, on timeout/disconnect, deny or interrupt explicitly. The stream may also send `control_cancel_request` with the original request id; abort the pending parent approval and do not send a late decision.

### Critical correction to the build brief

Version 2.1.261 accepts `--permission-prompt-tool stdio` even though the flag is hidden from `claude --help`. This is the path used by the official Agent SDK and is the recommended adapter mechanism.

`--permission-prompts host` is not a replacement for selecting the stdio handler. In a live raw-CLI test with `--permission-prompts host` but without `--permission-prompt-tool stdio`, the forced Bash ask produced no `control_request`; it was denied and appeared only in the final `permission_denials`. Therefore the adapter must pass the hidden stdio flag and verify at startup/integration-test time that a forced ask is actually observed.

The brief proposes pointing `--permission-prompt-tool` at a second internal MCP tool. Older official CLI reference text describes a named MCP permission tool, and the current binary still accepts a non-stdio name syntactically, but the exact named-MCP call/result contract was **not live-verified** in this investigation. Do not build the adapter around that unverified second-MCP endpoint. The raw stdio control exchange is verified and removes that extra recursion/availability dependency.

## Interrupt

Send the `interrupt` control request shown above. On 2.1.261, `system/init.capabilities` advertised:

```json
["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]
```

An observed immediate interrupt with `cancel_queued: true` returned:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"interrupt-probe","response":{"still_queued":[],"cancelled":["<user-message-uuid>"]}}}
```

and emitted a `command_lifecycle` `cancelled` event for that UUID. With `cancel_queued` absent/false, the current SDK contract says queued UUIDs survive and are listed in `still_queued`; older CLIs may return an empty success payload. Feature-detect both interrupt capabilities. Closing stdin or killing the process is disposal/failure handling, not the normal per-turn interrupt operation.

## Sessions and resume

Use the `session_id` from `system/init`/`result` as the resumable agent id. It is a UUID. Persist it with the backend name, pinned CLI version, cwd, model, and process state.

For a stopped process, launch the same invocation with:

```text
--resume=<session-id>
```

A live resume probe reused the exact requested `session_id` and continued from the persisted transcript. Resume is cwd-scoped in normal Claude Code storage, so launch with the original cwd. `--continue` instead chooses the most recent conversation in the current directory and is too ambiguous for an adapter. `--fork-session` with resume creates a new session id and should only be used for an explicit fork operation, not `resume`.

Within a still-live process, send another user line instead of spawning `claude --resume`; this preserves pending controls and avoids a restart. `--no-session-persistence` makes later process-level resume impossible.

Failure cases to surface distinctly include an invalid/nonexistent session id, a transcript unavailable under the launch cwd/user, a resume attempted with persistence disabled, a version/model/config mismatch, and another process already owning or mutating the same session. Exact concurrent-resume behavior was not live-tested; serialize access per Claude session id.

## Adapter invariants and integration test

- Keep exactly one stdout NDJSON decoder and one serialized stdin writer per process.
- Correlate user turns by client UUID, controls by `request_id`, tools by `tool_use_id`, and the agent by `session_id`; do not substitute one id for another.
- Buffer events before returning `running` or `needs_approval` so a fast event cannot be lost.
- A `result` completes one turn, not necessarily the process.
- Time out pending permission requests locally and fail closed.
- Serialize resume/access for a session id.
- Preserve unknown fields/events for diagnostics and tolerate repeated `system/init`.
- Never infer approval from a tool-use assistant block; wait for execution/tool-result events or a terminal permission denial.

The pinned-binary integration test should use a local mock model endpoint (or an explicitly authorized real request) that returns a harmless Bash tool use forced through an ask rule. Assert that `--permission-prompt-tool stdio` yields `can_use_tool`, deny it through the full envelope, assert the Bash command did not run, and verify the final result records the denial. A separate test must omit the hidden flag and fail if the adapter mistakenly believes `--permission-prompts host` alone is sufficient. Also test two turns on one process, resume with the emitted id, and interrupt with `cancel_queued: true`.

## Not verified

- The non-stdio named-MCP `--permission-prompt-tool` request/result schema.
- Allow responses that mutate `updatedInput` or apply each `updatedPermissions` variant end to end (their shapes are taken from the matching installed Agent SDK types).
- Concurrent resume of one id from multiple processes.
- Signal-specific behavior while a tool subprocess is already running; only the structured interrupt/cancel-queued path before execution was live-tested.
- Provider-specific authentication/failure output for OAuth, Bedrock, Vertex, and Foundry.

