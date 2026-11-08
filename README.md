# subagent-mcp

A resumable, approval-aware MCP server for delegating work from a Claude Code session to
subagents across five backends: Claude Code, Codex, OpenCode, Google Antigravity CLI, and the
Cursor Agent CLI. All five have been exercised live against their installed CLIs.

## Setup

Follow [`SETUP.md`](SETUP.md), or point Claude Code at this repo and ask it to **"set up subagent-mcp"**.

That installs: the server (user-scoped MCP), the `subagent-mcp` launcher, and the status-line mod.

### Backends and providers

| Backend | Notes |
| --- | --- |
| Claude | needs `claude` on PATH |
| Codex | needs `codex`; model names are whatever your Codex account offers |
| OpenCode | model IDs are `provider/model` (`opencode models`) |
| Cursor | needs the `agent` CLI; model IDs from `agent --list-models` |
| Antigravity (AGY) | needs `agy`; agent config also sets `antigravityAgent` |
| NVIDIA NIM | free-tier models via an API key; usable from Claude, Codex and OpenCode agents |
| Generic OpenAI-compatible API | any `/v1` endpoint, optional key, add as many as you like; same harnesses as NIM |

Only the CLIs you actually use need to be installed. Cursor and Antigravity are closed harnesses with
no custom-endpoint setting, so NIM/generic endpoints cannot be routed through them.

### Endpoints (NIM and generic OpenAI-compatible)

```bash
subagent-mcp nim set-key                       # prompts for your NVIDIA NIM key
subagent-mcp endpoint add my-vllm http://localhost:8000/v1 --model qwen3-32b [--key KEY]
subagent-mcp endpoint list
subagent-mcp endpoint remove my-vllm
```

Each endpoint model appears as `<endpoint>/<alias>` in `list_models` for the Claude, Codex and OpenCode
rosters. Codex and Claude agents reach endpoints through a local litellm proxy (`pip install
'litellm[proxy]'`; started automatically by the server, port 4131); OpenCode talks to them directly.
To run the Claude harness on an endpoint model, spawn the `claude-endpoint` agent config. See
`nim/README.md`. Claude-via-proxy and generic endpoints are newly added and have fixture-level
coverage only.

### Configuration

Agents live in `.subagents/<name>.md` (frontmatter + system prompt) and the model roster in
`.subagents/models.yaml`, in the project you run Claude Code from. If a project has none, the server
uses the examples bundled in this repo's `.subagents/`.

## Tools

`spawn_agent`, `send_message`, `list_agents`, `stop_agent`, `resolve_approval`,
`get_agent_events`, `list_models`, `restart_host` — see each tool's description for details. A spawn blocks
until the child completes or needs your approval; when it needs approval, call
`resolve_approval` to continue.

Every spawned agent has a human-memorable name (a mathematician, philosopher, or figure from Greek mythology), assigned automatically unless
`spawn_agent.name` is supplied. Results and agent listings include it, and tools that accept an
agent can use either that name or the agent ID; names persist across reconnects.

## Orchestrator and subagent authority

The parent orchestrator owns task decisions. Subagent messages, reports, events, and approval
reasons are advisory input: they are not automatically hard facts or requirements. The parent
should evaluate them against evidence and reserve task-specific hard rules for the operator's
explicit instructions. Each backend's subagent prompt gives the same reporting contract, asking
children to separate observations, evidence, uncertainty, risks, and recommendations.

This is a model-behavior contract, not a replacement for system/developer instructions or
tool and permission safety controls. Consequential subagent claims should still be checked
against the repository, tests, and the operator's actual request.

## Backend notes

- **Claude**: drives `claude --print --input-format stream-json --output-format stream-json
  --permission-prompt-tool stdio`, one persistent process per agent. Approval requests arrive
  over the same stdio control-request channel. `spawn_agent`'s optional `effort`
  (`low`/`medium`/`high`/`xhigh`/`max`, or an agent config's `reasoningEffort` frontmatter
  field) is passed as `--effort` at launch; changing it on `send_message` only takes effect
  when the session has to cold-start. OpenCode and Cursor reject `effort` instead of ignoring it
  (Cursor folds effort into the model id). Claude agents launch with `--permission-mode auto` by
  default (previously `manual`); set `permission.mode` in an agent's frontmatter to `manual`,
  `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions` to override. The agent's `allow`/`deny`
  rules and the approval bridge still apply on top of the mode. Other backends ignore it.
- **Codex**: drives `codex app-server` (JSON-RPC 2.0 over stdio, verified against
  `codex-cli 0.153.3`), one process per agent. `spawn_agent`'s optional `effort` (or an
  agent config's `reasoningEffort` frontmatter field, which pins it the same way `model` does)
  is sent as `reasoningEffort` on every `turn/start` call. **Important,
  discovered by testing against the
  real binary rather than assumed from docs:** on this development host, Codex's
  `workspaceWrite` sandbox does not actually confine writes to the declared `writableRoots`,
  and `networkAccess: false` did not block a live HTTPS request — neither ever produced an
  `item/*/requestApproval` callback. This looks like a Linux sandbox (Landlock/seccomp) that
  silently degrades to no enforcement when unavailable (e.g. in a container), rather than
  failing closed. The adapter still implements the full approval-request/response protocol
  correctly, and will work as intended on a host where Codex's own sandbox actually enforces —
  but until you've confirmed that on your target host, treat the Codex backend as running with
  effectively full execution trust, not as sandboxed. Verify this on your own host rather than assuming it.
- **OpenCode**: drives one shared `opencode serve --pure` process (verified against
  `opencode 1.17.6`), with each agent as a `directory`-scoped session on that one server. This
  adapter is **polling-only by design** — no SSE — per the brief's own guidance that `GET
  /event` is best-effort and has regressed across releases; `GET /session/{id}/message`'s
  `info.time.completed` marker is the authoritative terminal signal it polls instead.
- **Antigravity**: drives `agy --input-format stream-json --output-format stream-json`, one
  persistent process per conversation. The CLI `conversation_id` is the resumable agent ID;
  cold resumes launch with `--conversation <id>`. It maps `init`, `step_update`, and `result`
  records into normal server events. It deliberately does **not** pass
  `--dangerously-skip-permissions`: configure Antigravity's native allow/ask/deny rules in its
  settings. Headless Antigravity has no host approval-response channel, so native soft-denials
  are reported as tool failures and cannot enter this server's `resolve_approval` loop.
  `reasoningEffort` accepts only `low`, `medium`, or `high` for this backend. See
  [`docs/protocol/antigravity.md`](docs/protocol/antigravity.md) for the verified protocol and
  outstanding live-acceptance probes.
- **Cursor**: drives the Cursor Agent CLI in print mode, `agent -p --output-format stream-json
  --trust --sandbox enabled --workspace <cwd> --model <explicit> <prompt>` (verified against
  `agent 2026.10.16-e3cb207`). This backend is **one process per turn**: the only durable state is
  the CLI `session_id` from the first `system/init`, and `send_message` resumes with a new process
  `--resume <session_id>`. Print mode has no interactive approval channel, so `approve()` cannot be
  honored (`relaysDenyMessage: false`) and native `allow`/`deny` pattern lists are not enforceable.
  Instead the resolved permission default maps to the CLI: `permission.default: allow` →
  `--force` with `--sandbox enabled` (the operator's common invocation; only this lets the agent
  actually run commands/edits), while `escalate`/`deny` → `--mode plan` (read-only). Interrupts and
  timeouts signal the whole process group (`agent --force` spawns shells). Codex, Claude, and
  Antigravity do the same: `stop_agent` and a turn timeout signal the child's process group, so
  shells and builds it spawned (`cargo`, `check_task`) are reaped with it. See
  [`docs/protocol/cursor.md`](docs/protocol/cursor.md) for the verified protocol.

## Operational limits

- **Turn cap.** Whatever `timeout` the agent config or the tool call sets is returned as
  `timeout_seconds` on spawn, resume, and `list_agents`. The sample agents set `timeout: 1200`
  (20 minutes). `send_message` accepts `timeout` to raise or lower the cap for that turn.
  A timeout also kills the child's process group.
- **Codex resume cost.** Resuming a Codex agent replays the whole thread with no prompt cache.
  The result includes a `warning`. After `codexResumeIdleSeconds` (default 30 minutes) the resume
  is refused unless `allow_expensive_resume` is true.
- **Concurrency.** At most `maxConcurrent` agents run at once (default 12, or
  `SUBAGENT_MCP_MAX_CONCURRENT`). Further `spawn_agent` calls wait for a free slot.
  `list_models` and `list_agents` report `concurrency.active` and `concurrency.waiting`.
- **Blocking backends and models.** Three `models.yaml` settings refuse agents before they start:

  | Setting | Refuses | Environment variable |
  |---|---|---|
  | `disabledBackends: [cursor, antigravity]` | Every model on those backends | `SUBAGENT_MCP_DISABLED_BACKENDS=cursor,antigravity` (adds to the file's list) |
  | `blockModels: ["*grok*", "codex:gpt-5.6-sol"]` | Model ids matching a case-insensitive glob (`*`, `?`); a `backend:` prefix limits a pattern to that backend | `SUBAGENT_MCP_BLOCK_MODELS=*grok*,codex:gpt-5.6-sol` (adds to the file's list) |
  | `blockClaudeModels: true` | Anthropic Claude models on every backend | `SUBAGENT_MCP_BLOCK_CLAUDE_MODELS=1` (overrides the file; `0` forces it off) |

  The variables go in the MCP server's environment and apply to every project; a project's file
  can add blocks but not lift the variables' list entries. The host takes its environment from
  the MCP connection that started it, so after changing them, run `/mcp` to reconnect and then
  restart the host process; restarting the host alone keeps the old environment.
  `models.yaml` changes need neither step: the file is reloaded live.

  Blocks apply to spawns, scheduled spawns (refused up front), and `send_message` to an existing
  agent. A model counts as Claude when its id contains `claude` or an `anthropic` provider
  segment, or when it is a bare id on the `claude` backend (`sonnet`, `opus`); `claude` backend
  endpoint models (`<endpoint>/<alias>`) still run. Inside Claude Code, a Claude subagent costs
  less through its own Agent tool, so that refusal (`CLAUDE_MODEL_BLOCKED`) tells the orchestrator
  to ask the user for explicit approval and use the built-in Agent tool. The others are
  `BACKEND_DISABLED` and `MODEL_BLOCKED`. `list_models` reports the active `model_policy` and
  marks refused roster entries `blocked` with `blocked_by`; it skips live queries for disabled
  backends. `list_agent_configs` marks configs on a disabled backend or pinned to a blocked model.
- **Usage.** `list_models` includes per-backend and per-model counters (spawns, resumes, turns,
  failures, timeouts, tokens, cost), persisted under `.subagents/memory/`. Optional `allowances`
  in `models.yaml` produce a `remaining` object (allowance minus observed usage).
- **Per-agent token counts.** `list_agents` reports each agent's `cumulative_usage`: its finished
  turns plus the turn in progress. Claude, Codex and OpenCode 2.x report usage mid-turn (as
  `usage.updated` events in `get_agent_events`); Cursor and Antigravity report it when a turn ends.
  Usage fields:

  | Field | Meaning |
  |---|---|
  | `inputTokens` | Input as the backend reports it. Codex includes cache reads; Claude, OpenCode and Cursor do not. |
  | `cachedInputTokens` | Input served from the prompt cache. |
  | `uncachedInputTokens` | Input processed fresh, including cache writes. Set for Claude, Codex, OpenCode and Cursor; Antigravity's semantics are unverified, so it is left unset. |
  | `outputTokens`, `costUsd` | As reported. Codex reports no cost. |

  Compare backends with `uncachedInputTokens` + `cachedInputTokens`, not `inputTokens`.
- **Live models and plan usage.** `list_models` with a `backend` (or `live: true`) adds a `live`
  section from that backend's own API. The `opencode` section, from the OpenCode 2.x server,
  covers every model it can run (context, max output, cost per million tokens), the default model,
  OpenCode Go rolling/weekly/monthly usage, and workspace budgets. The `codex` section, from a
  short-lived `codex app-server`, covers the model catalog (reasoning efforts, default, hidden
  models), the ChatGPT plan's rate-limit windows (5-hour and weekly) and credits, and recent daily
  token totals. Each usage window reports `percent_used`, `remaining_percent` and `resets_at`.
  `roster_not_offered` lists roster entries the backend doesn't offer, except entries routed to a
  custom `provider`. These numbers come from the vendor's own account records and don't include
  quotas on external API keys. If one section fails (for example, Codex plan limits under API-key
  auth, or OpenCode's experimental usage endpoint), `live.errors` names it and the rest is still
  returned. Emails and account IDs are removed from the output.
- **Config hot-reload and reconnect.** The MCP process is a proxy. Agent processes live in a
  host for this working directory, so `/mcp` reconnect does not drop running agents, and edits
  to `.subagents/` are picked up without a restart. If no config is loaded, tool calls return
  the files to create and ask the user to run `/mcp` and then reconnect `subagent-mcp`.
- **Picking up code changes.** After rebuilding subagent-mcp (`npm run build`), run `/mcp` and
  reconnect. The host reports a fingerprint of the compiled code it loaded and when it was built;
  the reconnecting proxy replaces the host only when it runs *older* code, is idle, and no other
  Claude Code session is attached. Agent records, results and usage carry over. A host running
  newer code than the proxy is never downgraded; tool responses then carry a `host_warning` to
  reconnect. When agents are running or another session is attached, the old host is kept and the
  `host_warning` says so; `restart_host` then reloads it once agents finish. `restart_host` is
  always refused while agents are running or waiting, and also refused when the host already runs
  the code on disk or other sessions are attached, unless called with `force: true`. Changes to
  tool definitions need the `/mcp` reconnect either way.

## Update notifications

When update checks are enabled, the host looks up the latest GitHub release of
`BlueMonkey262/subagent-mcp` via the public API (a normal request; nothing else is sent). A result, including
"no release yet", is cached for 24 hours; a failed request (offline, rate limit) retries on the next
host start. The result is cached at `<project>/.subagents/memory/update.json`. The status line shows a dim
notice when a newer release is available. Nothing is updated automatically. Opt out with
`SUBAGENT_MCP_UPDATE_CHECK=0` (or `false`); that also removes the cached notice. To update: `git fetch --tags`, `git checkout <tag>`, then
`npm ci && npm run build`, and restart. Rebuilding in a live checkout can drop a running session's host
connection, so do it between sessions.

## Known gaps

- The approval heuristic (`src/approval/policy.ts`) catches the common dangerous patterns
  (sudo, recursive force delete, outside-cwd writes, force-push, network egress, `.git`/
  `.claude`/credential paths) but is not a full shell-effect classifier — an unrecognized
  command with no write/network signature falls through to the agent's configured default
  rather than always escalating.
- No routing digest is injected into `spawn_agent`'s description yet (P7-05).
- Progress is polling-only via `get_agent_events` for all five backends. Pass `summary: true`
  for a compact digest (tool counts, the last few tool calls with their file or command, the
  tail of the latest message) instead of the raw log; add `since` (the previous
  `currentSequence`) to see only what is new. For the raw log, `types` filters event types and
  `coalesce: true` merges the per-chunk `message.delta` events. The one push is the Claude Code
  channel below, which covers completion, failure, and approval requests only.
- Antigravity works in live use, including tool soft-denial and interrupts.

## Claude Code channel (background completion alerts)

When a `run_in_background` agent (or `send_message` with `run_in_background`) settles, the
server pushes a `notifications/claude/channel` event, which Claude Code shows in the session as
`<channel source="subagent-mcp" agent_id=… status=…>` and treats as a new turn. Completed and
failed events carry the (truncated) result; `needs_approval` events carry the request so the
orchestrator can call `resolve_approval`. Blocking calls never push, because they already return
the outcome. See `src/channel.ts`.

- **Claude Code only.** The capability key is sent to every client (it has to be declared before
  the client is known), but events are emitted only when `clientInfo.name` is `claude-code`.
- **Opt-in per session.** Channels are a research preview; a custom server is not on the
  allowlist, so start Claude Code with
  `claude --dangerously-load-development-channels server:subagent-mcp`. Without it Claude Code
  drops the events silently and polling still works. Team/Enterprise orgs also need channels
  enabled by an admin.
- Session-scoped approval memory (`allow_for_session`) is bridge-side only; it is not yet
  translated to Codex's native `acceptForSession` reply at the coordinator layer beyond a
  straight decision-string mapping (no persistence across a resumed process). It does now
  generalize by program+subcommand (`sessionRuleForRequest()` in `src/approval/policy.ts`), not
  just an exact repeat of the same command.

### Long-running agents and workflows

Use `list_agent_configs` before spawning to discover callable names, config source
paths, pinned options, and backend capabilities. `list_agents` returns up to 25
summaries by default (maximum 100), newest first by creation time. Filter with `states`,
`backend`, or `updated_since`, and pass `next_cursor` back as `cursor` for another
page. Active agents expose `last_activity_at` and a bounded `current_activity`
from tool events. These describe backend activity, not a connectivity heartbeat.
Order and paging use creation time, which never changes, so an agent whose activity
changes does not move between pages.

For background work, call:

```json
{"agents":["Ada","Emmy"],"mode":"all","timeout_seconds":60}
```

on `wait_for_agents`. It waits on events and returns on completion, approval, or
timeout. `mode: "any"` returns after the first outcome. Timeouts never cancel work. To loop
"wait for the next one to finish", pass `since` (an ISO timestamp): only agents that settled
after it count, and `newly_settled` names them. Results returned by `spawn_agent`,
`send_message` and `wait_for_agents` are capped at 4000 characters (`max_result_chars`
overrides); `result_truncated` is set and `get_agent_result` returns the full text. A
`structured_result` more than four times that size is returned as `null` with
`structured_result_truncated` and its size; `get_agent_result` has it whole.
`get_agent_result` retrieves final text, JSON validation details, per-turn usage,
and cumulative usage. Use `turn` to select a turn, or `offset` and `limit` to page
history. Unknown usage totals remain null. Results survive client disconnection
and host restart; live turns interrupted by a host restart still require explicit
resume. Turn results are also appended to `sessions.json.results.jsonl` beside
the host snapshot, before completion notifications. `storage_error` reports
persistence failures. Notifications are convenience signals, not durable delivery.

Spawn options:

- `isolation: "worktree"` creates a branch and sibling worktree from committed
  HEAD. Uncommitted source changes are excluded. Git isolation does not enforce
  filesystem confinement. The branch and path are returned and retained for
  review and resume. `cleanup_worktree` removes only inactive, clean worktrees,
  retaining their branches; cleaned agents cannot resume. Optional config
  `worktreeSetup: ["npm ci"]` runs configured commands in each new worktree.
  No source-tree symlinks or automatic merges are created.
- `permission` can narrow a Claude config's allow rules, add deny rules, and
  tighten the default to `escalate` or `deny`. Its mode must be `manual` when
  supplied. Other backends reject overrides rather than silently ignoring them.
  Saved restrictions are intersected with current configuration on resume.
- `result_schema` accepts JSON Schema (Ajv strict validation, draft-07). The
  bridge requests JSON and validates it locally; it does not assume native
  constrained generation. Inspect `structured_result` and `validation_errors`.
  Invalid output is retained and never retried automatically.
- `depends_on: ["Ada"]` pins prerequisites to their current turns. Spawn returns
  a `task_id` immediately; queued tasks consume no execution slots. Task IDs can
  also be dependencies for further chaining. Only successful, schema-valid
  results launch dependents. Failed prerequisites block them. Dependency results
  are passed as delimited input data. Cycles cannot be created because only
  existing prerequisites may be referenced. Queues survive restart; tasks caught
  during launch become interrupted to avoid duplicate execution.
- `group_id` labels related agents/tasks. `stop_agents` accepts `agents` or
  `group_id`, cancels queued tasks, and interrupts running members. It returns
  individual outcomes and is safe to repeat. Task IDs can be used for waiting,
  result lookup, and cancellation after launch.

Effort support is reported by discovery. OpenCode currently has no verified effort
mapping in this adapter; Cursor uses model IDs containing effort. Unsupported
values remain errors. Usage and monetary cost are reported only when supplied by
the backend; the bridge does not invent price estimates.
