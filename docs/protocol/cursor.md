# Cursor Agent CLI adapter protocol

Status: **verified against `agent 2026.10.16-e3cb207` on Linux**. Live probes captured the NDJSON
envelope for a shell tool turn and for a file-write turn. Process behavior (normal turn, resume,
interrupt, timeout, early exit, malformed output) is also covered by deterministic fixtures under
`test/cursor-fixture.mjs` + `test/cursor-adapter.test.ts`.

## Invocation

Unlike Claude, Codex, and Antigravity, the Cursor Agent CLI is **one process per turn**. The
adapter launches a fresh process for every `spawn_agent`/`send_message`:

```text
agent -p --output-format stream-json --trust --sandbox enabled \
  --workspace <cwd> --model <explicit-model> "<prompt>"
```

The adapter appends `--resume <session-id>` for a resumed turn and one of `--force` or
`--mode plan` depending on the resolved permission (below). It never passes
`--stream-partial-output`; whole assistant text blocks are emitted as `message.delta`.

`-p` is print (non-interactive) mode, so stdin is unused; the adapter closes it immediately. The
prompt is passed as the final positional argument, so it must remain the last argv element.

## Observed output

stdout is newline-delimited JSON. A live turn produced, in order:

1. `{"type":"system","subtype":"init","session_id":…,"cwd":…,"model":…,"permissionMode":…}` — the
   resumable session ID.
2. `{"type":"user",…}` — an echo of the prompt (ignored).
3. `{"type":"thinking","subtype":"delta"|"completed",…}` — internal reasoning deltas (ignored).
4. `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":…}]}}` —
   assistant text. The adapter emits each non-empty text block as `message.delta`. The final
   assistant block is not separately distinguished; `result.result` is the authoritative final
   text.
5. `{"type":"tool_call","subtype":"started"|"completed","call_id":…,"tool_call":{"shellToolCall"|
   "editToolCall":{…}}}` — tool activity. `started` becomes `tool.start`, `completed` becomes
   `tool.end`. The normalized `toolName` is the camel-case key with the `ToolCall` suffix removed
   (`shellToolCall` → `shell`, `editToolCall` → `edit`).
6. `{"type":"result","subtype":"success"|…,"is_error":…,"result":…,"usage":{…}}` — the terminal
   record for the turn.

The process exits on its own after writing `result`. Because the process ends every turn, the
adapter listens on the child's `close` event (not `exit`) so stdout drains and its trailing line is
parsed before the turn is reconciled. A non-zero exit or a `result` with `is_error: true` (or a
non-`success` subtype) is a failed turn.

### Usage mapping

`result.usage` is `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`. The adapter
maps `inputTokens`→`inputTokens`, `outputTokens`→`outputTokens`, and `cacheReadTokens`→
`cachedInputTokens`. `inputTokens` excludes cache reads, so `uncachedInputTokens` is
`inputTokens + cacheWriteTokens` (cache writes were processed fresh).

## Resume

The only durable per-agent state is the CLI `session_id` observed in the first `system/init`.
`send_message` launches a new process with `--resume <session_id>`; the adapter requires the new
process's `init.session_id` to equal the resumed ID and fails otherwise. There is no persistent
connection to reuse.

## Permissions and interruption

Print mode has **no interactive approval protocol**, so a request can never be parked:
`approve()` always throws and `relaysDenyMessage` is `false`. The adapter maps the resolved
permission default instead:

- `permission.default: "allow"` → `--force` with `--sandbox enabled`. This is the operator's
  common trustworthy invocation and the only configuration under which the agent may actually run
  commands and edit files; the sandbox confines the blast radius.
- `permission.default: "escalate"` (the bridge default) or `"deny"` → no `--force` and
  `--mode plan`: a read-only planning turn, because the bridge cannot answer the CLI's own prompt.

Consequently the CLI has no flag for the bridge's `allow`/`deny` pattern lists, so those lists
are **not natively enforceable** for this backend; a config that needs execution must opt in with
`permission.default: allow` and rely on the sandbox.

For interruption the adapter signals the **whole process group** (`--force` shells are children of
the agent process): `SIGTERM`, a short grace interval, then `SIGKILL`. A deliberate stop or a
timeout is not reported as a process fault. Timeouts follow the same path and complete the turn as
`failed` with a `CURSOR_TURN_TIMEOUT` error.

## Required promotion probe

With an authenticated `agent` installation, record redacted NDJSON for:

- a normal text turn and a turn that runs one harmless shell tool;
- a resumed turn (`--resume <id>`) that recalls the previous turn;
- interrupt while a turn is active; and
- malformed/failed model execution.

Assert stable `session_id` correlation, one terminal `result` per process, bounded diagnostics,
and that `--force` is only used when the resolved default is `allow`.
