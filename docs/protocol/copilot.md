# GitHub Copilot CLI adapter protocol

Verified live against `copilot 1.0.109` (GitHub Copilot CLI) on macOS. The adapter is
`src/adapters/copilot/adapter.ts`; the process fixture and tests are `test/copilot-fixture.mjs` +
`test/copilot-adapter.test.ts`.

## Invocation

Like Cursor, the Copilot CLI is **one process per turn**. Each turn runs:

```sh
copilot --output-format json --no-auto-update --no-ask-user --model <explicit-model> \
  [--reasoning-effort <level>] [--resume <sessionId>] <permission flags> --prompt=<prompt>
```

- The prompt goes in the `--prompt=<prompt>` form so a prompt that starts with `-` is never read as
  a flag. stdin is closed at launch.
- `--no-ask-user` removes the tool the model would use to ask the user a question, which headless
  mode cannot answer.
- The child runs in its own process group so `stop_agent` and turn timeouts reap the shells it
  starts.
- Copilot has no system-prompt flag. The agent config body is prepended to the first prompt,
  separated by `---`; resumed turns send the prompt alone.

## Output

stdout is JSONL: one object per line with `type`, `data`, `id`, `timestamp`, and sometimes
`ephemeral: true`. The records the adapter reads:

| Record | Meaning |
|---|---|
| `session.start` | New session; `data.sessionId` is the agent ID. |
| `session.resume` | Resumed session (`--resume`). It carries no session ID field; the ID is the one passed to `--resume`. |
| `assistant.message` | A complete assistant message; non-empty `data.content` becomes `message.delta`. The last one is the turn's `finalText`. |
| `tool.execution_start` | `data.toolCallId`, `data.toolName` (for example `bash`), `data.arguments`. |
| `tool.execution_complete` | `data.success`; on failure `data.error.{message,code}`. `code: "denied"` maps to a `denied` tool end. |
| `session.error` | `data.message`, for example `Execution failed: Model "x" is not available.` Fails the turn. |
| `result` | Ends the turn. Top-level `sessionId`, `exitCode`, and `usage` (`premiumRequests`, durations). |

Everything else (`*_delta` records, `session.mcp_*`, `session.auto_mode_resolved`,
`session.usage_checkpoint`, `model.call_*`, `assistant.turn_start`/`turn_end`, `assistant.idle`,
`tool.shell_output`, `tool.execution_partial_result`) is ignored.

Two live quirks the adapter handles:

- Copilot **locks a session while its process runs**. A resume launched before the previous
  turn's process exits fails with `SessionInUseError`, so the adapter waits for that process to
  exit (up to 10 s, then SIGTERM) before resuming.
- Some startup errors are printed as **plain text** on stdout or stderr (for example
  `Error: Model "auto" does not support reasoning effort configuration`), followed by a `result`
  with `exitCode: 1` and **no `session.start`**. Non-JSON stdout lines and stderr are kept as diagnostics, and a
  `result` that arrives first opens the session from its `sessionId`.
- A failed turn with no assistant text uses the error message (or the diagnostics) as its
  `finalText`, so the parent always sees why it failed.

## Usage

`result.usage` reports premium requests and durations, not tokens, so Copilot turns carry no token
usage.

## Permissions

Headless mode cannot prompt. A tool request that no rule allows completes with `success: false`
and `error.code: "denied"`, and the model carries on. `approve()` is therefore not supported
(`relaysDenyMessage: false`). The agent's rules map to native flags instead:

| Config | Flags |
|---|---|
| `permission.default: allow` | `--allow-all-tools` |
| `escalate` or `deny` | one `--allow-tool` per translatable `allow` rule |
| every `deny` rule | `--deny-tool`, which Copilot enforces over any allow |

Translation from the Claude-style rule syntax:

| Config rule | Copilot rule |
|---|---|
| `Bash`, `Bash(cmd)` | `shell`, `shell(cmd)`; `cmd *:*` becomes `cmd:*` |
| `Read`, `Grep`, `Glob` (optional path) | `read`, `read(path)` |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` (optional path) | `write`, `write(path)` |
| `shell(...)`, `write(...)`, `read(...)`, `url(...)`, `memory` | unchanged |
| anything else (`WebFetch`, MCP tools) | dropped |

File access is limited to the working directory and the system temp directory, which covers a
managed worktree.

## Models and effort

Model IDs are the names `copilot --model` accepts. The CLI's help lists many, but only the ones
your Copilot plan and model settings allow will run; an unavailable model fails the turn with
`session.error`. `auto` lets Copilot pick a model the plan allows. `effort` maps to
`--reasoning-effort`; not every model accepts it, and `auto` rejects it at startup.

## Interruption

`stop_agent` sends SIGTERM to the process group, waits a short grace interval for the process to
exit, then sends SIGKILL and reports the turn `interrupted`. A turn timeout does the same and
reports `failed` with a `COPILOT_TURN_TIMEOUT` error.
