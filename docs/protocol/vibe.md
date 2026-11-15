# Mistral Vibe CLI adapter protocol

Status: **built against `mistral-vibe 3.1.2` (source at commit `b20313e`, 2026-11-10) and
exercised live against an installed Vibe 3.1.2 on 2026-11-14** (spawn, resume, resume from a fresh
adapter as after a host restart, stop mid-turn, read-only denials, and the export shape including
`config`). The contract comes from Vibe's own `docs/programmatic-mode.md`, the public history-entry
models in `vibe/app_server/models.py`, and the export model in
`vibe/cli-rust/src/run_export/model.rs`. Process behavior is also covered offline by
`test/vibe-fixture.mjs` + `test/vibe-adapter.test.ts`.

## Invocation

Headless Vibe is **one process per turn**, like Cursor. The adapter launches:

```text
vibe --output streaming --output-dir <tmp>/subagent-vibe-XXXX --workdir <cwd> \
  --model <alias>            # new sessions only
  --resume <session-id>      # resumed turns only, instead of --model
  [--max-turns N] [--time-limit SECONDS] [--max-tokens N] [--max-price USD] \
  <profile flags> -p
```

- The prompt is written to stdin (`-p` with no text reads stdin), so it is never on argv. `-p` is
  last so clap cannot take a following flag as its value.
- `--model` is a usage error on a resumed session; a session keeps the model it started with.
- `--workdir` is explicit so an inherited `VIBE_CWD` cannot redirect the run.
- `--continue` (which may pick another session) and Vibe's own `--worktree` are never used; the
  supervisor allocates worktrees itself.
- `--time-limit` is the turn's `timeout`, rounded up to whole seconds. Vibe stops the turn and
  still writes its export (`outcome: deadline`). The adapter keeps a backstop timer 20 s later.

## Output

`--output streaming` writes one JSON line per public history entry once the entry's
`generationStatus` is `completed`. A completed entry is frozen, so:

- assistant text arrives as whole messages (`type: "message"`, `role: "assistant"`, text in
  `content[].text`), not token deltas. A message whose `outcome.type` is `discarded` (a draft a
  hook rejected) is skipped and is never the final answer;
- a tool call (`type: "effect"`) is written once, after it settled, with `detail.toolName`,
  `detail.input` and a terminal `state.status` (`completed`, `failed`, `cancelled`, `skipped`).
  The adapter emits `tool.start` and `tool.end` together. `failed` with `error.code: "tool_denied"`
  and `skipped` become `denied`.
- Every entry carries `sessionId`. The first one names the session: the adapter uses it as the
  agent ID and resolves the spawn receipt. Entries whose `sessionId` differs (Vibe's own `task`
  subagents) are ignored.

`reasoning`, `checkpoint`, `callback` and `notice` entries are not mapped. A malformed stdout line
is reported as a non-fatal `VIBE_PROTOCOL_WARNING` and skipped; the export stays authoritative.

## Export and outcomes

`<output-dir>/export.json` is written however the run ends, except when the argument parser itself
rejects the command line. Fields used: `outcome`, `session_id`, `exit_code`, `error.message`,
`error.code`, `stop_reason`, `usage.{input_tokens,output_tokens,cached_input_tokens}`, `cost_usd`,
`steps`, `warnings[].message`, `vibe_version`. Usage and cost count **this run only**, also on a
resumed session, so nothing is double-counted.

| `outcome` | exit | Turn status | Error event |
| --- | --- | --- | --- |
| `finished` | 0 | completed | — |
| `terminated` | 3 | interrupted (failed if the adapter's timeout caused it) | — (`VIBE_TURN_TIMEOUT` on timeout) |
| `deadline` | 3 | failed | `VIBE_TURN_TIMEOUT` |
| `turn_limit`, `token_limit`, `price_limit` | 3 | failed | `VIBE_LIMIT_REACHED` (non-fatal) |
| `length` | 3 | failed | `VIBE_LENGTH` (non-fatal) |
| `refusal` | 3 | failed | `VIBE_REFUSAL` (non-fatal) |
| `usage_error`, `config_error` | 1 | failed | `VIBE_CONFIG_ERROR` |
| `infrastructure_failure` | 2 | failed | `VIBE_INFRASTRUCTURE_FAILURE` |
| `aborted` | 4 | failed | `VIBE_ABORTED` (only with `--agent-socket`, which is unused) |
| missing or unparseable export | any | failed (interrupted after a stop) | `VIBE_EXPORT_MISSING` |

The last assistant text streamed in the turn is kept as `finalText` whatever the outcome. An
export whose `session_id` differs from the streamed one fails the turn (`VIBE_PROTOCOL_ERROR`).

A run that ends before naming a session (an unknown model alias, a missing login, a crash) fails
the spawn itself with the export's message and stderr. No session ID is ever guessed.

`input_tokens` includes cache reads, so `uncachedInputTokens = input_tokens - cached_input_tokens`.
`cost_usd` is Vibe's estimate from configured model prices; it is reported with
`costBasis: "estimated"` and booked as `estimatedCostUsd` in the usage ledger.

## Permissions

Headless Vibe has no approval channel: a call that would need approval is denied and the model is
told so. `approve()` is unsupported and `relaysDenyMessage` is false.

| `permission.default` | Flags | Effect |
| --- | --- | --- |
| `allow` | `--auto-approve --trust` | Every tool call runs. `--trust` loads the project's `.vibe/` config and `AGENTS.md`, which can run hooks and MCP servers: no wider than auto-approved shell access. Use `isolation: worktree`; a worktree separates changes, it is not a sandbox. |
| `escalate`, `deny` | `--agent ask --enabled-tools read_file --enabled-tools grep` | Read-only, enforced by the `ask` agent: it runs reads and headless mode denies every call that would need approval. The project's `.vibe/` config is not loaded. |

Observed live on 3.1.2: `--enabled-tools` (and `--disabled-tools`) do **not** hide Vibe's core
tools. The model still sees `bash`, `write_file`, `edit`, `run_typescript`, `skill` and
`search_tool_functions`; calls to `bash` and `write_file` (also when made from inside
`run_typescript`) come back `failed` with `error.code: "tool_denied"`. `run_typescript`'s sandbox
has no `require`, `process`, `Deno` or filesystem of its own. The filter flags stay as a second layer
for versions that honor them; the `ask` agent is the enforcement.

Non-empty `permission.allow` or `permission.deny` lists are refused: Vibe's CLI cannot enforce
per-command rules, and silently ignoring them would overstate the protection.

## Instructions

The agent config's body is sent once, wrapped in `<subagent_instructions>` ahead of the first
prompt. `--system-prompt-file` was not used because it replaces Vibe's own coding-agent
instructions. Resumed turns send only the new prompt; the session history keeps the instructions.

## Stop and timeout

`stop_agent` sends SIGTERM to the Vibe process only. Vibe stops the turn and its tools and writes
an export (`terminated`) within its 10 s wind-down. After `interruptGraceMs` (15 s) the adapter
SIGKILLs the process group. Signalling the whole group first would kill Vibe's app-server before
the export is written.

## Model catalog and provider

The export's `config.models` lists every alias Vibe offered for the run (`alias`, `provider`,
upstream `name`, `input_price`/`output_price`/`cached_input_price` per million tokens, `thinking`,
`thinking_levels`, `max_context_length`), and `config.active_model` names the alias used (empty on a
resumed run, which keeps its session's model). The adapter keeps the latest catalog (cached in
`.subagents/memory/vibe-models.json`) and serves it as `list_models` live data, and tags each turn's
usage with the alias's `provider` so usage can be grouped by provider.

## Limits

`vibeMaxTokens` and `vibeMaxPriceUsd` in an agent config become `--max-tokens` and `--max-price`
on every turn. Both count the run's root session and Vibe's own subagents; reaching one ends the
turn as `token_limit` / `price_limit` (`VIBE_LIMIT_REACHED`). `--max-price` relies on Vibe's price
table, which Mistral notes may be missing or stale, so it is an approximate brake. Configs that set
either are refused on any other backend rather than silently uncapped.

## Not covered yet

- Interactive approvals: use the ACP transport (`vibeTransport: acp`, [vibe-acp.md](vibe-acp.md)).
- `vibe run-server` (experimental, needs a sandboxing agent socket) is not used.
