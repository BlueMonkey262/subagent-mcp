# Mistral Vibe ACP transport

Status: **verified live against `vibe-acp` from mistral-vibe 3.1.2 (2026-11-14)**: session
creation, approvals bridged in both directions, session-wide grants, denials, resume from a
fresh process, interrupt, and the per-process model and tool overrides. The contract was read
from Vibe's installed source (`vibe/acp/agent.py`, `vibe/acp/utils.py`,
`vibe/acp/session_updates.py`; ACP SDK `agent_client_protocol` 0.11.0). Offline coverage:
`test/vibe-acp-fixture.mjs` + `test/vibe-acp-adapter.test.ts`.

Agent configs opt in with `vibeTransport: acp` (default `cli`, see [vibe.md](vibe.md)). ACP agent
ids are `acp:<vibe session id>`; the prefix fixes the transport for the agent's lifetime.

## Process and session

One `vibe-acp` process per agent, spawned in the agent's cwd with its own process group, JSON-RPC
2.0 with one message per line on stdio.

1. `initialize` with `protocolVersion: 1` and no `fs`, `terminal` or elicitation capabilities:
   Vibe does its own file and shell I/O, and disables its ask-the-user tool.
2. `session/new {cwd, mcpServers: []}`, or `session/resume {sessionId, cwd}` for a later turn when
   no process is warm (`session/load` if resume is unsupported; its replayed history is dropped,
   and its permission requests answered `cancelled`; no turn runs before step 3).
3. `session/set_mode {modeId: "ask"}` always. Without it Vibe uses the user's `default_agent`
   (`accept-edits` here), which writes files without asking.
4. Optional `session/set_config_option` for `max_turns` (agent `maxTurns`) and `max_tokens`
   (`vibeMaxTokens`). There is no price option, so `vibeMaxPriceUsd` is refused for ACP agents.
5. `session/prompt`; the response's `stopReason` ends the turn.

The process stays warm between turns and is closed after 10 idle minutes; the next turn resumes.

**Model.** `VIBE_ACTIVE_MODEL=<alias>` in the process environment. ACP's
`set_config_option model` calls Vibe's `config/model/write`, which **persists `active_model` to
the user's `~/.vibe/config.toml`** (observed live), so it is never used. The `model` config
option in the `session/new` response is checked: a mismatch (an alias Vibe does not have) fails
the spawn instead of silently running Vibe's default. `thinking` is also written to config, so
`effort` stays refused.

## Approvals

Vibe sends a `tool_call` update (title, `kind`, `rawInput`, absolute `locations`,
`_meta.tool_name`) and then `session/request_permission {toolCall: {toolCallId}, options}`. The
adapter emits `approval.requested` with:

| Field | From |
| --- | --- |
| `toolName` | `_meta.tool_name` mapped to policy names: `bash`→`Bash`, `write_file`→`Write`, `edit`/`search_replace`→`Edit`, `read_file`→`Read`, `grep`→`Grep`, `web_fetch`→`WebFetch`, `web_search`→`WebSearch`; others unchanged |
| `command` | `rawInput.command` |
| `paths` | `locations[].path` (absolute) |
| `reason` | the update's `title` (untrusted) |

The supervisor's policy then applies the agent's `allow`/`deny` rules, its heuristics and
`permission.default`; whatever it escalates waits for `resolve_approval`. Decisions map to
Vibe's options by **id**:

| Decision | Option |
| --- | --- |
| `allow` | `allow_once` |
| `allow_for_session` | `allow_session_exact`, else `allow_always` (session); a directory-recursive grant is wider than what was approved, so it fails closed |
| `deny` | `reject_once`, else a `cancelled` outcome |

`allow_always_permanent` and `allow_permanent_*` are never chosen: they share `kind:
allow_always` with the session option but persist the grant in Vibe's config. A decision with no
safe option fails closed: `approve()` throws and the request stays answerable. A deny `message`
is not relayed (Vibe sends its own fixed feedback), so `relaysDenyMessage` is false. On interrupt
or timeout, open requests are answered `cancelled`, as ACP requires, and when the turn ends the
supervisor cancels any approval still parked for it (this applies to every backend).

**What Vibe asks about.** In `ask` mode Vibe still auto-runs `read_file`, `grep` and shell
commands on its own prefix allowlist (`ls` ran unasked live). So every process gets
`VIBE_TOOLS__BASH__ALLOWLIST=[]` (also `GIT_BASH`, `POWERSHELL`): each shell command reaches the
policy. Tools that change files, run commands, reach the network or start Vibe subagents
(`bash`, `git_bash`, `powershell`, `write_file`, `edit`, `search_replace`, `web_fetch`,
`web_search`, `task`) are pinned to `ask`, since a user's Vibe config could set them to run
unasked. A tool named by a `deny` rule is also switched to `VIBE_TOOLS__<TOOL>__PERMISSION=ask`
(`Read(...)` → `read_file`, `*` → all), so the rule is enforced. These overrides apply to that
process only and are set after the agent's own `env`. Vibe's private session scratchpad tool runs
without approval; it writes outside the project.

## Events

| ACP `session/update` | Event |
| --- | --- |
| `agent_message_chunk` | `message.delta`; the last message's text is the turn's `finalText` |
| `tool_call` | `tool.start` |
| `tool_call_update` `completed` / `failed` / `cancelled` | `tool.end`; `failed` with `rawOutput.error.code: tool_denied` → `denied` |
| `usage_update` | `usage.updated` (this turn's share) |
| `agent_thought_chunk`, `plan`, `user_message_chunk`, `session_info_update`, `available_commands_update` | not mapped |

| `stopReason` | Turn |
| --- | --- |
| `end_turn` | completed |
| `cancelled` | interrupted (failed with `VIBE_TURN_TIMEOUT` after a timeout) |
| `max_tokens`, `max_turn_requests` | failed, `VIBE_LIMIT_REACHED` |
| `refusal` | failed, `VIBE_REFUSAL` |

A process exit mid-turn fails it with `VIBE_ACP_EXITED` (stderr in details); the next message
resumes in a new process. A turn that ignores `session/cancel` is killed after 15 s.

## Usage

`usage_update._meta` (`promptTokens`, `completionTokens`, `cachedTokens`), `cost.amount` and the
prompt response's `usage` are **cumulative for the session**, history included after a resume.
Each turn reports the difference from the counters seen before it started (the first
`usage_update` after `session/new`/`resume` is the baseline). Without a baseline a turn reports no
usage rather than the whole history; a cancelled turn whose counters have not moved reports none.
Cost is Vibe's estimate (`costBasis: estimated`).
