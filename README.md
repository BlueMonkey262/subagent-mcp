# subagent-mcp

A resumable, approval-aware MCP server for delegating work from a Claude Code session to
subagents across seven backends: Claude Code, Codex, OpenCode, Google Antigravity CLI, the
Cursor Agent CLI, the GitHub Copilot CLI, and Mistral Vibe. All seven have been exercised live
against their installed CLIs (Vibe's contract: [`docs/protocol/vibe.md`](docs/protocol/vibe.md)).

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
| GitHub Copilot | needs the `copilot` CLI, signed in; model IDs as `copilot --model` accepts them (`auto` routes within your plan) |
| Antigravity (AGY) | needs `agy`; agent config sets `antigravityAgent` (and optionally `antigravityAgentFile`) |
| Mistral Vibe | needs `vibe` (logged in with `vibe --setup`); model names are your Vibe model aliases |
| Mistral API | through OpenCode's `mistral` provider: roster entries `mistral/<model-id>` under `opencode` |
| NVIDIA NIM | free-tier models via an API key; usable from Claude, Codex and OpenCode agents |
| Generic OpenAI-compatible API | any `/v1` endpoint, optional key, add as many as you like; same harnesses as NIM |

Only the CLIs you actually use need to be installed. Cursor, Antigravity and Copilot are closed harnesses with
no custom-endpoint setting, so NIM/generic endpoints cannot be routed through them. Vibe is not routed to
them by `subagent-mcp endpoint add` either (it has its own provider config in `~/.vibe/config.toml`).

### Endpoints (NIM and generic OpenAI-compatible)

```bash
subagent-mcp nim set-key                       # prompts for your NVIDIA NIM key
subagent-mcp endpoint add my-vllm http://localhost:8000/v1 --model qwen3-32b [--key KEY | --key-env VAR]
subagent-mcp endpoint list
subagent-mcp endpoint remove my-vllm
```

Each endpoint model appears as `<endpoint>/<alias>` in `list_models` for the Claude, Codex and OpenCode
rosters. Codex and Claude agents reach endpoints through a local litellm proxy (`pip install
'litellm[proxy]'`; started automatically by the server, port 4131); OpenCode talks to them directly.
To run the Claude harness on an endpoint model, spawn the `claude-endpoint` agent config. See
`nim/README.md`. Claude-via-proxy and generic endpoints are newly added and have fixture-level
coverage only.

`--key-env VAR` stores only the variable's name: the generated litellm and OpenCode files reference
it (`os.environ/VAR`, `{env:VAR}`), so the key is never copied to disk. The generated `opencode.json`
uses the V1 provider shape, which OpenCode 2.x still reads.

### Mistral: Vibe subscription vs. API

Two separate routes, booked separately in usage:

- **Mistral Vibe** (`vibe` backend): runs the Vibe CLI with its own login (`vibe --setup`), e.g. a
  Le Chat Pro plan. Roster names are your Vibe model aliases. Its cost figure is an estimate.
  `list_models` with `backend: vibe` lists the aliases, providers, prices and context sizes from the
  latest Vibe run (Vibe has no command that lists them without a run) and flags roster entries Vibe
  does not offer. Agent configs can cap a turn with `vibeMaxTokens` and `vibeMaxPriceUsd`
  (`--max-tokens`, `--max-price`); the price cap uses Vibe's own price table, so treat it as
  approximate, not as a billing guarantee.
- **Mistral API** (pay-as-you-go, through OpenCode): connect Mistral in OpenCode (`/connect`,
  choose Mistral, or set `MISTRAL_API_KEY`), list what you can run with `opencode models mistral`,
  and add the ids you want under `opencode` in `models.yaml` as `mistral/<model-id>`. Spawn them with
  an OpenCode agent config (`opencode-general`). `list_models` with `backend: opencode` shows each
  model's context, output limit, price, `provider` and, for Mistral, `billing_channel: api`. Usage
  is tracked per model and per provider (`usage_by_provider` in `list_models`, e.g.
  `mistral: { opencode, vibe }`), so `mistral/*` API spend stays distinct from Vibe and from other
  OpenCode providers. Use an API key meant for API automation, not your Vibe plan's key.
- **Provider limits** (`providerLimits` in `models.yaml`): for OpenCode models, keyed by the provider
  prefix of the model id.

  ```yaml
  providerLimits:
    mistral:
      maxConcurrent: 2     # Mistral agents at once; more spawns and resumes wait for a slot
      cooldownSeconds: 60  # after a turn fails on a rate limit, new Mistral turns wait (±20% jitter)
  ```

  `maxConcurrent` slots and the `perBackendConcurrency`/`perModelConcurrency` pools are the same
  capacity guard: a `providerLimits.maxConcurrent` registers a `provider:<id>` pool beside them, so
  a throttled provider queues its own spawns instead of holding global slots. The cooldown is
  separate. This is apart from Vibe's own plan limits. A failed OpenCode
  turn now reports the provider's error as an `error` event (`OPENCODE_RATE_LIMITED`,
  `OPENCODE_AUTH_FAILED`, `OPENCODE_QUOTA_EXCEEDED` or `OPENCODE_PROVIDER_ERROR`), and
  `list_models` shows each provider's slots, cooldown, and rate-limit, auth and quota failure
  counts under `providers`. OpenCode retries individual requests itself; subagent-mcp never replays
  a whole turn, which may already have changed files.

### Configuration

Agents live in `.subagents/<name>.md` (frontmatter + system prompt) and the model roster in
`.subagents/models.yaml`, in the project you run Claude Code from. If a project has no `.subagents/`,
the server uses this repo's bundled agent templates. `.subagents/` belongs to each person and is
gitignored here; the repo tracks only templates (`<name>.md.example` and `models.yaml.example`, plus the
Antigravity agent template `.agents/agents/subagent-general.md.example`). Real `<name>.md` configs win
over their templates. There is no roster fallback: `models.yaml.example` only shows the format for each
backend. The roster comes from `SUBAGENT_MCP_MODELS_FILE` when set, then the project's
`.subagents/models.yaml`, then this install's `.subagents/models.yaml`; with none the server starts with
an empty roster and `list_models` / `spawn_agent` report the paths checked and how to create it. The
panel's `i` init builds a project's own `.subagents/` from the templates.

Useful `models.yaml` limits (all optional):

```yaml
maxConcurrent: 12
staleAgentSeconds: 300          # heartbeat threshold when a backend cannot be probed
sendMessageWaitSeconds: 30      # bounded send_message wait
scheduledGraceSeconds: 3600     # how late a restored scheduled task may start
perBackendConcurrency:
  opencode: 2
perModelConcurrency:
  "opencode:strata-coder/strata/gyro-s": 1
  "antigravity:gemini-3.8-flash-*": 1
```

For an Antigravity agent, pin its real definition into the project:

```yaml
antigravityAgent: gemini-review
antigravityAgentFile: .agents/agents/gemini-review.md
```

`subagent-mcp antigravity doctor` audits every resolved definition; `subagent-mcp antigravity
vendor <agent-config>` copies a global definition into the project. Antigravity tools and
permissions are always enforced by `agy`, not by the bridge (`bridge_enforced: false`).

## Tools

`spawn_agent`, `send_message`, `list_agents`, `stop_agent`, `resolve_approval`,
`get_agent_events`, `get_agent_diff`, `list_models`, `restart_host`, and the ensemble tools below — see each tool's description for details. A spawn blocks
until the child completes or needs your approval; when it needs approval, call
`resolve_approval` to continue.

- `get_agent_diff` returns an isolated agent's changes: everything in its managed worktree,
  committed or not and untracked files included, against the commit it started from (for snapshot
  isolation, the snapshot, so your own uncommitted edits are not shown as the agent's). Per-file
  line counts plus a unified diff capped at `max_chars`. The agent can't hide a change from it:
  `skip-worktree` and `assume-unchanged` flags are ignored, untracked files are filtered only by the
  tree's `.gitignore` files (not the shared repository's `info/exclude` or your global excludes), and
  a new `.gitignore` always appears. Taking the diff runs nothing the worktree configures: files are
  staged as raw bytes without `git add`, so no clean filter runs, and textconv, external diff and
  fsmonitor are off.
- `get_dashboard` is for status UIs such as the `/subagent-mcp` panel and its poller (its
  description steers the model to `list_agents`; hiding it with a `tool.list` hook would also take
  it from the mod's own `$.mcp.call`): live agents, the most recent finished ones (`recent`, default 10) and any that settled in
  the last 15 minutes, pending approvals, recent ensembles with member states and the concurrency
  counters in one read. Pass the previous `revision` as `since` and an unchanged
  snapshot answers `{ revision, unchanged: true }`.
- Agent listings and `get_agent_events` summaries carry `phase` (`tool` while a call is open,
  `thinking` between calls, `approval` while waiting; a settled agent's state) and `last_tool`,
  the most recent call, kept after it ends. `current_activity` is still the open call only.

Every spawned agent has a human-memorable name (a mathematician, philosopher, or figure from Greek mythology), assigned automatically unless
`spawn_agent.name` is supplied. Results and agent listings include it, and tools that accept an
agent can use either that name or the agent ID; names persist across reconnects.

## Ensembles

`start_ensemble`, `get_ensemble` and `cancel_ensemble` run several agents (any mix of configs,
backends and models) on one task and return one aggregated result, so the orchestrator makes one
call and reads one compact summary instead of one report per agent.

```json
{
  "name": "diff-review",
  "task": "Review the uncommitted changes for correctness bugs and regressions.",
  "agents": [
    { "role": "primary", "config": "codex-general", "model": "gpt-5.6-sol" },
    { "role": "second-opinion", "config": "opencode-general", "model": "opencode-go/deepseek-v4.1-flash" },
    { "role": "thorough", "config": "cursor-general", "model": "grok-4.7-xhigh" }
  ],
  "aggregation": { "strategy": "review_findings", "max_items": 5 }
}
```

- **Members are ordinary spawns.** Each one goes through the same config, model-policy and
  permission checks as `spawn_agent`, and every member is validated before any launches. Membership
  grants no extra authority. Children see the shared `task`, their role and their own
  `instructions`; they never see the parent conversation.
- **Modes.** `parallel` (default); `specialist` (every member needs `instructions`); `competitive`
  (each member gets its own managed worktree; `isolation: none` is refused); `pipeline` (each member
  starts after the previous one succeeds and receives its result). `depends_on` lists earlier roles
  explicitly and works in any mode; in a pipeline it replaces that member's link to the one before it. With `on_dependency_failure: continue` a member starts once its
  dependencies have settled, successful or not, and receives each outcome cut to
  `dependency_max_chars` (default 4000).
- **Isolation.** `isolation` per member, or as the ensemble default: `none` shares your checkout;
  `worktree` gives a managed worktree at HEAD; `snapshot` gives a worktree holding your working tree
  as it was when the ensemble started (uncommitted and new, non-ignored files included, shown as
  uncommitted changes), the same snapshot for every member. Taking it never touches your index or
  files. Use `snapshot` for reviews of uncommitted work. The host cannot enforce read-only access, so
  the start response warns when more than one member shares your checkout. Worktrees are not
  filesystem sandboxes.
- **Completion** is separate from aggregation: `all`, `first_valid`, `quorum` (finishes early as
  `partial` once the quorum can no longer be reached) or `deadline` (`deadline_seconds`, which also
  caps the others). Members still running when the ensemble finishes keep running unless
  `cancel_remaining` is set. A result counts as valid only when the member completed and, when a
  result schema applies, its JSON matches; JSON wrapped in a code fence or a sentence is recovered.
  Final status: `completed`, `partial`, `failed`, `cancelled` or `interrupted` (host restart).
- **Aggregation is deterministic** (no model calls): `collect` (attributed results), `compare`
  (agreed and differing fields), `vote` (`field`, `choices`; reports abstentions and ties; a
  majority is not proof), `merge` (conflicting values are reported and omitted, or taken from the
  `prefer` role order, never silently overwritten) and `review_findings` (built-in findings schema;
  normalizes file locations, merges the same issue from different reviewers conservatively, ranks by
  severity and corroboration, and keeps severity disagreements). `get_ensemble` with `aggregation`
  re-aggregates the stored results another way at no model cost.
- **Compact output.** Responses are compact JSON measured in full, metadata included, against
  `output.max_chars` (default 1600). `get_ensemble` with `role` returns one member's full result;
  `detail: "members"` lists states, errors and usage. Unknown cost or token counts are reported as
  `null`, never as zero. `budget` (`max_cost_usd`, `max_total_tokens`) stops the ensemble when the
  reported usage reaches it.
- **Synthesis (opt-in).** `aggregation.synthesize: { config, model, max_input_chars, timeout_seconds }`
  runs one more agent after the members finish. It gets the task, the deterministic aggregate and
  the valid results, cut to `max_input_chars` (default 12000) and marked as untrusted data, and must
  return `{summary, consensus, disagreements, recommendation, confidence}`. Its reading is added as
  `synthesis` (marked advisory) next to the unchanged aggregate; if it fails, times out or returns
  the wrong shape, the summary says so and the deterministic aggregate stands. It is validated with
  the members before anything launches, counts toward `budget`, and is skipped when the budget is
  already reached or nothing is valid.
- **Notifications.** A background ensemble (the default) returns at once. Members' own channel
  events are suppressed and one `kind="ensemble"` event carries the summary when it finishes. When
  members were still running at that point (`first_valid`, `quorum`, `deadline` without
  `cancel_remaining`), their results update the stored aggregate, and one `update="true"` event
  follows once the last of them settles, if any added a valid result. An event that could not be
  delivered (no session connected) is retried after the next tool call.
  Member approval requests still arrive individually with their original `request_id`;
  `resolve_approval` returns immediately for a member instead of blocking on its turn.
- **Durability.** Each ensemble is saved in `.subagents/memory/ensembles/<id>.json` and reloaded by a
  restarted host. A member whose launch was in flight when the host stopped is adopted if the agent
  exists and otherwise marked failed; it is never relaunched. Starting an ensemble identical to one
  still running returns the running one unless `allow_duplicate` is set. An ensemble has at most 12
  members.
- **Profiles.** Named rosters live under `ensembles:` in `.subagents/ensembles.yaml`, or in
  `~/.config/subagent-mcp/ensembles.yaml` for every project (a project profile wins on a name
  clash). They are read on every call. `start_ensemble` with `profile` uses one, and fields in the
  call override it; `get_ensemble` with no arguments lists recent ensembles and the profiles.

### Model selection

A member can give `select` instead of `config`/`model`, and `selection: { count, ... }` adds
`count` selected members (roles `auto-1`…, or `roles`). Candidates are every unblocked roster model
of every config (a config that pins a model offers only that model), so selection can never pick
what `models.yaml`'s model policy refuses, and explicit members are never changed. Criteria:
`category`, `objective` (`balanced`, `quality`, `cost`, `latency`, `reliability`), `backends`,
`exclude_backends`, `configs`, `exclude_models`, `require` (capabilities), `min_quality`,
`distinct` (`model` default, `backend`, `none`), `explore`, and `live_quota` with
`min_remaining_percent` (default 5).

Each candidate gets an explainable score from:

- **Quality and capabilities**, declared by you under `routing.models` in `ensembles.yaml`. Undeclared
  quality scores as middling and is excluded by `min_quality`; undeclared capabilities fail `require`.
- **Reliability**, measured: the share of valid results among completed or failed runs (interrupted
  runs are ignored), Laplace-smoothed, per category when there is data for it. A bounded
  exploration bonus lets rarely tried models earn a record.
- **Cost and latency**, measured median per run when known, else the declared tier. Unknown cost
  ranks below a declared `medium` tier; it is never treated as free.
- **Quota**: a backend whose `allowances` in `models.yaml` are used up is excluded. With
  `live_quota`, so is a backend whose live plan usage (`list_models` live) is below the threshold,
  and a model its live catalog does not offer. With neither, quota is reported as unknown, not as
  unlimited.
- **Load**: a small penalty per agent already active on the backend.

Every member's outcome (backend, model, category, validity, duration, reported cost and tokens) is
appended to `.subagents/memory/routing-history.jsonl`. The start response (and `dry_run`) lists each
pick with its score and the reasons, and `get_ensemble` with `detail: "members"` shows the full
selection report including rejected candidates. `test/routing.test.ts` includes a seeded simulation
in which the router, learning from its own history, matches or beats a fixed configured model.

```yaml
routing:
  models:
    codex/gpt-5.6-sol: { quality: { review: 5, default: 4 }, cost: high, capabilities: [tools] }
    codex/gpt-5.6-luna: { quality: 3, cost: low, latency: fast, capabilities: [tools] }
    opencode/opencode-go/deepseek-v4.1-flash: { quality: 3, cost: low, latency: fast, capabilities: [tools] }

ensembles:
  standard-review:
    description: Three-model review of the working tree
    agents:
      - { role: primary, config: codex-general, model: gpt-5.6-sol }
      - { role: second-opinion, config: opencode-general, model: opencode-go/deepseek-v4.1-flash }
      - { role: quick, config: codex-general, model: gpt-5.6-luna }
    aggregation: { strategy: review_findings }
    completion: { strategy: all }
    isolation: snapshot
  auto-review:
    description: Three reviewers chosen by the router
    category: review
    selection: { count: 3, objective: quality, distinct: backend }
    aggregation: { strategy: review_findings }
```

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
  is sent as `reasoningEffort` on every `turn/start` call. An agent config's `env` frontmatter is
  added to the app-server's environment on spawn and cold resume, so `env: { CODEX_HOME:
  /Users/you/.codex-alt }` runs that agent under a second Codex home and its signed-in account
  (sign it in once with `CODEX_HOME=~/.codex-alt codex login`; use an absolute path in `env`, since
  `~` is not expanded). Live usage in `list_models` still reads the default home. **Important,
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
  settings. Headless Antigravity has no host approval-response channel, so an action no
  `permissions.allow` rule covers is auto-denied: the tool ends `denied`, the turn reports the
  denied actions (and fails if the agent produced no text), and nothing enters this server's
  `resolve_approval` loop. The custom agent must list `tools`, or agy gives it only a read-only set.
  `reasoningEffort` accepts only `low`, `medium`, or `high` for this backend.
  The real system prompt and tool list live in the `agy` custom agent, not in `.subagents/`.
  Before launch the bridge resolves the definition project-first
  (`.agents/agents/<name>.md`), then the global `~/.gemini/agents/<name>.md`, or an explicit
  `antigravityAgentFile` in the config. A missing project definition is first copied from its
  tracked `.example` template (the project's, then the install's); an existing file is never
  overwritten. It validates the frontmatter name, records the SHA-256,
  source path, tools and portability in the agent result/listing, and writes an exact copy to
  `.subagents/memory/antigravity-agents/<sha256>.md`. A definition that changes between turns
  refuses resume with `ANTIGRAVITY_AGENT_CHANGED` unless `allow_agent_definition_change: true`
  is passed. See [`docs/protocol/antigravity.md`](docs/protocol/antigravity.md) for the verified
  protocol and outstanding live-acceptance probes.
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
- **GitHub Copilot**: drives the Copilot CLI one process per turn, `copilot --output-format json
  --no-auto-update --no-ask-user --model <explicit> --prompt=<prompt>` (verified against `copilot
  1.0.109`); `send_message` resumes with `--resume <sessionId>`. Headless Copilot cannot prompt, so
  `approve()` is not honored; instead the agent's rules map to native flags: `permission.default:
  allow` → `--allow-all-tools`, otherwise only the `allow` rules become `--allow-tool` and anything
  else is denied (reported as a `denied` tool result). `deny` rules always become `--deny-tool`, which
  Copilot enforces over every allow. Rules translate from the Claude-style syntax (`Bash(git:*)` →
  `shell(git:*)`, `Read` → `read`, `Write(p)`/`Edit(p)` → `write(p)`); native Copilot rules pass
  through. Copilot has no system-prompt flag, so the agent config body is prepended to the first
  prompt. `effort` maps to `--reasoning-effort` (not every model accepts it; `auto` rejects it).
  Copilot reports premium requests, not tokens, so its turns carry no token usage. See
  [`docs/protocol/copilot.md`](docs/protocol/copilot.md).
- **Vibe**: drives Mistral Vibe's headless mode, `vibe --output streaming --output-dir <tmp>
  --workdir <cwd> --model <alias> ... -p` with the prompt on stdin (built against
  `mistral-vibe 3.1.2`). Like Cursor it is **one process per turn**: the agent ID is Vibe's own
  `session_id` (every streamed entry carries it), and `send_message` starts a new process with
  `--resume <session_id>` (no `--model`: a session keeps its model). The run's `export.json`, not
  the exit code, decides the outcome; a run with no readable export is a failure, never a success.
  Headless Vibe cannot ask for approval (calls that need it are denied), so `permission.default:
  allow` → `--auto-approve --trust`, and `escalate`/`deny` → the builtin `ask` agent, which runs
  reads and denies everything else (verified live: `bash` and `write_file` come back `tool_denied`).
  `--enabled-tools read_file --enabled-tools grep` is passed too, but Vibe 3.1.2 does not use it to
  hide its core tools, so the `ask` agent is what keeps the run read-only. Vibe cannot enforce per-command `allow`/`deny` lists, so configs
  that set them are refused. `effort` is refused too: Vibe sets thinking per model alias in its
  own config. The agent config's instructions go into the first prompt, not
  `--system-prompt-file`, which would replace Vibe's coding-agent instructions. `stop_agent`
  sends SIGTERM to Vibe itself (it stops its tools and writes the export), then kills the
  process group after a grace period. See [`docs/protocol/vibe.md`](docs/protocol/vibe.md).

- **Vibe over ACP** (`vibeTransport: acp` in the agent config; sample `.subagents/vibe-acp.md.example`):
  runs `vibe-acp` (Agent Client Protocol), one warm process per agent, and bridges Vibe's
  permission requests into the normal approval flow: the agent's `allow`/`deny` rules, the
  safety heuristics and `permission.default` decide, and anything escalated waits for
  `resolve_approval`. Unlike the CLI transport, per-command rules work here. Every shell command
  is checked (Vibe's own command allowlist is emptied for the process), and a tool named by a deny
  rule is made to ask too; reads otherwise run unasked. `allow_for_session` maps to Vibe's
  session-only grant, never its "always allow", which Vibe saves to its config. The model is set
  per process (`VIBE_ACTIVE_MODEL`), so `~/.vibe/config.toml` is never written. ACP agent ids start
  with `acp:` and keep their transport for life. `vibeMaxPriceUsd` and `effort` are refused.
  See [`docs/protocol/vibe-acp.md`](docs/protocol/vibe-acp.md).
## Operational limits

- **Turn cap and bounded resume wait.** Whatever `timeout` the agent config or the tool call sets is returned as
  `timeout_seconds` on spawn, resume, and `list_agents`. The sample agents set `timeout: 1200`
  (20 minutes). `send_message` accepts `timeout` to raise or lower the cap for that turn.
  It also accepts `wait_seconds` (default 30, or `sendMessageWaitSeconds` in `models.yaml`, `0`
  returns immediately). When the wait expires the call returns `status: "running"` with
  `wait_expired: true` and leaves the turn running; it never cancels work. Use
  `wait_for_agents` or `get_agent_events` to follow it.
  A timeout also kills the child's process group.
- **Codex resume cost.** Resuming a Codex agent replays the whole thread with no prompt cache.
  The result includes a `warning`. After `codexResumeIdleSeconds` (default 30 minutes) the resume
  is refused unless `allow_expensive_resume` is true.
- **Concurrency.** At most `maxConcurrent` agents run at once (default 12, or
  `SUBAGENT_MCP_MAX_CONCURRENT`). Further `spawn_agent` calls wait for a free slot.
  `perBackendConcurrency` and `perModelConcurrency` add narrower pools, so a one-slot local model
  cannot be oversubscribed by the global cap and does not block spawns on other models. A
  `providerLimits.maxConcurrent` joins those same pools as `provider:<id>`; `list_models` reports its
  slots, cooldown and failure counts under `providers`.
  `list_models` and `list_agents` report `concurrency.active`, `concurrency.waiting`, and the
  `per_backend`/`per_model` pools. Model patterns use the same case-insensitive globs as
  `blockModels`; every matching rule applies.
- **Failure reporting.** Every failed turn carries `error.code`, `error.message`,
  `error.category`, `error.retryable`, and `error.recommended_action`. Categories distinguish
  `quota`, `auth`, `rate_limit`, `timeout`, `process`, `protocol`, `transport`, `task`, `config`,
  `capacity`, `host`, `internal`, `cancelled`, and `unknown`. A failed turn with no backend error
  is synthesized as `TURN_FAILED` (`task`), and a lost backend process becomes
  `AGENT_UNRESPONSIVE` (`process`). A failed turn can never be labelled `*_SUCCESS`.
  `CLAUDE_*` codes remain backend-specific for diagnostics; use `category` for automation.
- **Liveness.** Active agents report `liveness: live | stale | unknown | settled`,
  `liveness_reason`, `last_heartbeat_at`, and `heartbeat_age_seconds`. A backend process that has
  exited is marked `stale` immediately and, after a second probe, failed with
  `AGENT_UNRESPONSIVE`; its capacity slot is released and `wait_for_agents` wakes. An adapter
  that cannot probe is marked stale only after `staleAgentSeconds` (default 300) without a
  heartbeat, and is not killed automatically, because a long tool call may legitimately be silent.
  The host also bounds `list_agents` so an unresponsive host returns an error instead of hanging.
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
  `models.yaml` changes need neither step: the file is reloaded live. If a reload is invalid,
  execution fails closed with `CONFIG_INVALID` (listing still shows the last good config and its
  `config_warning`) until a valid file is loaded.

  Blocks apply to spawns, scheduled spawns (refused up front), and `send_message` to an existing
  agent. Endpoint entries are checked by both their `<endpoint>/<alias>` and upstream model id for
  `blockModels`; `blockClaudeModels` uses the upstream id, so a vendor-looking alias alone does not
  count as Claude. Other models count as Claude when their id contains `claude` or an `anthropic`
  provider segment, or when it is a bare id on the `claude` backend (`sonnet`, `opus`). Inside
  Claude Code, a Claude subagent costs less through its own Agent tool, so that refusal
  (`CLAUDE_MODEL_BLOCKED`) tells the orchestrator to ask the user for explicit approval and use
  the built-in Agent tool. The others are
  `BACKEND_DISABLED` and `MODEL_BLOCKED`. `list_models` reports the active `model_policy` and
  marks refused roster and live entries `blocked` with `blocked_by`; it skips live queries for disabled
  backends. `list_agent_configs` marks configs on a disabled backend or pinned to a blocked model.
- **Usage.** `list_models` includes per-backend and per-model counters (spawns, resumes, turns,
  failures, timeouts, tokens, cost), persisted under `.subagents/memory/`. Optional `allowances`
  in `models.yaml` produce a `remaining` object (allowance minus observed usage).
- **Per-agent token counts.** `list_agents` reports each agent's `cumulative_usage`: its finished
  turns plus the turn in progress. Claude, Codex and OpenCode 2.x report usage mid-turn (as
  `usage.updated` events in `get_agent_events`); Cursor, Antigravity and Vibe report it when a turn ends.
  Copilot reports no token counts.
  Usage fields:

  | Field | Meaning |
  |---|---|
  | `inputTokens` | Input as the backend reports it. Codex and Vibe include cache reads; Claude, OpenCode and Cursor do not. |
  | `cachedInputTokens` | Input served from the prompt cache. |
  | `uncachedInputTokens` | Input processed fresh, including cache writes. Set for Claude, Codex, OpenCode, Cursor and Vibe; Antigravity's semantics are unverified, so it is left unset. |
  | `outputTokens`, `costUsd` | As reported. Codex reports no cost. |
  | `costBasis` | `estimated` when the cost is computed locally from configured prices (Vibe), not billed. |

  Vibe's `cost_usd` is an estimate from the per-token prices in your Vibe config, and on a Vibe
  subscription you are not billed per token at all. The usage ledger books it as
  `estimatedCostUsd`, separate from `costUsd`; both count against a `maxCostUsd` allowance.

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
  Claude Code session is attached. Agent records, results and usage carry over, and queued or
  scheduled tasks plus undelivered pings are preserved and re-armed. A host running
  newer code than the proxy is never downgraded. When agents are running or another session is
  attached, the old host is kept and the `host_warning` says so; `restart_host` then reloads it
  once agents finish. `restart_host` is always refused while agents are running or waiting, and
  also refused when the host already runs the code on disk or other sessions are attached, unless
  called with `force: true`.
- **Tool definitions follow the host.** The tools are defined once (`src/tool-catalog.ts`). The host
  serves them (`tool_catalog`) and checks every call's arguments against them; the proxy lists the
  connected host's catalog and sends `notifications/tools/list_changed` when a host on a new build
  brings different tools, so new tools appear without `/mcp`. A proxy whose host was restarted by
  another session reconnects on its next call. A host that predates `tool_catalog` (older than this
  proxy) gets the proxy's own tools; a proxy that predates it (connected to a newer host) still
  needs one `/mcp` reconnect to become a proxy that refreshes.

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
  channel below, which covers completion, failure, and approval requests only. In the desktop app,
  where channels can't be turned on, the panel mod's toasts cover the same three (SETUP.md step 4b).
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
- **Ping policy.** `spawn_agent` and `send_message` accept `notify: "always" | "on_failure" |
  "never"` (default `always`). `never` suppresses completed, failed, and interrupted pings;
  `on_failure` suppresses only completed. `needs_approval` always pings because the agent is
  blocked. Results stay retrievable through `list_agents`, `get_agent_result`, and
  `get_agent_events` regardless.
- **Offline queue.** If no attached Claude Code session is available when a background agent
  settles, the ping is persisted (up to 100, oldest dropped) and delivered after the next session
  completes the MCP initialize handshake and explicitly attaches. Probes and other MCP clients do
  not drain it. A ping is removed from the queue only after its socket write succeeds; a crash
  between the write and the removal can redeliver it.
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

### Delayed agents

`spawn_agent` can schedule work for later instead of starting it now. Pass exactly one of:

- `start_at`: an ISO datetime in the future (at most 7 days ahead).
- `delay_seconds`: a positive number of seconds (at most 604800).

The call returns immediately with a queued receipt:

```json
{"task_id":"task-…","agent_id":"task-…","status":"queued","start_at":"2026-11-13T06:00:00.000Z"}
```

For example, to run a migration review overnight:

```json
{
  "agent": "reviewer",
  "prompt": "Review the migration in migrations/0042 and report risks.",
  "description": "overnight migration review",
  "start_at": "2026-11-13T02:00:00Z",
  "notify": "on_failure"
}
```

Choose `notify` per job: `always` (default) pings when the agent completes, fails, or is
interrupted; `on_failure` only pings for failures and interruptions; `never` suppresses all
completion pings. A `needs_approval` ping is always sent, because the agent is blocked.
Scheduled tasks and dependency queues are persisted in `.subagents/memory/sessions.json`, so
they survive a host restart. The host writes a final snapshot on shutdown, and the replacement
host restores the queue and re-arms each timer. `list_agents` shows their `start_at` and
`notify`; `restart_host` reports `scheduled_tasks_preserved`. Queued completion pings persist
the same way and are delivered after the next session attaches. Concurrent attaches are
serialized, so each queued ping is delivered to exactly one session. Shutdown waits for
in-flight completion pings and stops scheduled tasks before writing the final snapshot, so a
task that comes due during shutdown stays queued for the replacement host. Delivered pings are
removed after a successful socket write; a crash between the write and the removal can
redeliver one.

Limits: the host must be running (or restarted) to launch the job, and the machine must be awake.
A sleeping machine starts the job when it wakes, subject to `scheduledGraceSeconds` (default
3600). A task restored later than that grace window is marked `blocked` with a structured
`MISSED_START` error instead of running late; reschedule it with a new `spawn_agent` call.

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
  existing prerequisites may be referenced. Queues survive restart. A task
  caught during launch is re-run only when no agent record was persisted; spawn
  is at-least-once, so a crash between `adapter.spawn` and the snapshot can run
  the task again.
- `start_at` / `delay_seconds` schedule a spawn for later (see "Delayed agents"). They can be
  combined with `depends_on`: the task waits for both the clock and its prerequisites.
  `stop_agents` cancels a scheduled task before it starts.
- `group_id` labels related agents/tasks. `stop_agents` accepts `agents` or
  `group_id`, cancels queued tasks, and interrupts running members. It returns
  individual outcomes and is safe to repeat. Task IDs can be used for waiting,
  result lookup, and cancellation after launch.

Effort support is reported by discovery. OpenCode currently has no verified effort
mapping in this adapter; Cursor uses model IDs containing effort; Copilot passes `--reasoning-effort`;
Vibe uses model aliases whose own config sets thinking. Unsupported
values remain errors. Usage and monetary cost are reported only when supplied by
the backend; the bridge does not invent price estimates (Vibe's own estimate is
labelled `costBasis: estimated`).
