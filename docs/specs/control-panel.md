# Spec: `/subagent-mcp` control panel, `i` init, `u` update

Status: draft for review. Nothing here is built.

## Goals

1. One slash command, `/subagent-mcp`, opens a live control panel beside the chat.
2. From the panel a person can manage agents without asking Claude: stop them, resolve
   approvals, inspect them, message or resume them, and clean up leftover worktrees.
3. The same panel starts two guided flows, both run by Claude in the conversation:
   `i` (create or revise `.subagents/` config) and `u` (update subagent-mcp).
4. Replaces the earlier idea of a separate `/subagent-mcp-init` command file in
   `~/.claude/commands/`. Nothing is installed outside the repo.

Non-goals: replacing the status-line rows (they stay), changing how the server resolves config,
auto-updating anything, a panel for terminals that cannot seat a pane (see Open questions).

## Where it lives

The `mod/subagent-strip` plugin, which `bin/subagent-mcp` already loads through
`CLAUDE_CODE_PLUGIN_DIRS`. So the panel exists only in sessions started with the launcher; a plain
`claude` session has no `/subagent-mcp` command. The poller that feeds the status line also
feeds the panel (one `list_agents` poll, shared), so the panel adds no extra server load.

Implementation surface (plugin API on this Claude Code build; verify at build time):

- `$.command.register({ name: "subagent-mcp" })` in `session.start`, answered by a `command.run`
  hook that calls `$.ui.open({ id, title })`.
- A `ui.render` hook on `{ component: "Pane", requestId: id }` draws the pane.
- Server calls use `$.mcp.call("subagent-mcp", <tool>, args)`: `list_agents`, `get_agent_events`,
  `get_agent_result`, `stop_agent`, `stop_agents`, `resolve_approval`, `send_message`,
  `cleanup_worktree`, `list_models`, `list_agent_configs`.
- `i` and `u` hand Claude a fixed setup prompt (see "Delivering the `i` and `u` prompts"). Claude
  then does the work with its normal tools and permission prompts; the panel never writes files itself.

## Delivering the `i` and `u` prompts

The panel cannot interview anyone itself, so `i` and `u` must put a prompt in front of Claude.
Two mechanisms exist:

- **Channel message (requested approach).** The panel asks the server to push the setup prompt
  over the existing `subagent-mcp` channel, the same path that delivers agent completion events.
  Needs a small new server tool or host call (for example `send_setup_prompt`) and a channel event
  type that is clearly the person's request, not subagent output (agent results are advisory; this
  must read as an instruction from the user).
- **`$.prompt.submit({ text })` (found in the plugin API).** The mod submits a prompt directly as a
  turn, once the session is idle, with the plugin as its origin; `asUser: true` makes the model
  read it as the person's own words. No server change.

Both land in the conversation as a new turn. Default in this draft: channel message, per the
author's decision; `$.prompt.submit` is the fallback if the channel path proves awkward (it needs
no server work, so it is cheaper to build first). See open question 7.

## Layout: list + detail split

- Left column: agents, running first, then recent. Each row: backend, model, config, name,
  elapsed, state. A badge marks a pending approval. Worktrees appear in their own section below
  the agents (leftover `subagent/*` branches and their worktrees).
- Right column: detail for the selected row. For an agent: the `summary: true` digest from
  `get_agent_events` (tool counts, last tool calls, message tail), then its result once finished.
  For a worktree: path, branch, whether it has unmerged commits or uncommitted changes.
- Bottom key bar: `s` stop, `S` stop all, `a` approve/deny, `m` message/resume, `w` clean up
  worktree, `i` init, `u` update, `Esc` close. Keys act on the selected row.
- Update row: when `.subagents/memory/update.json` reports a newer release, a dim notice shows at
  the top of the list and `u` is highlighted.

## Actions

| Key | Does | Confirmation |
|---|---|---|
| `s` | `stop_agent` on the selected running agent | yes |
| `S` | `stop_agents` for every running agent | yes, shows the count |
| `a` | shows the pending approval's details; approve or deny via `resolve_approval` | no extra step (the details screen is the confirmation) |
| `m` | text input, then `send_message` (resumes a finished agent) | no |
| `w` | `cleanup_worktree` on the selected worktree | yes; warns if there are unmerged commits or uncommitted changes |
| `i` | submits the init prompt (below) | none; Claude asks its own questions |
| `u` | submits the update prompt (below); only offered when an update is available | none; the prompt gates itself |

Confirmed: stop one, stop all and worktree cleanup need a confirmation. Denying an approval does not.
Every action reports its result in the pane and surfaces server error codes as they come back
(`CODE: message`).

## `i`: init

Scope: roster, agent configs and policy. Project-level only: it writes `<project>/.subagents/`.

1. Claude calls `list_models` (live backends, models, plan usage) and `list_agent_configs`.
2. Question menus, one decision each:
   - Which backends to enable. Backends found not installed or not logged in are shown as such.
   - For each enabled backend, which models go in the roster, with the live list as the choices.
   - Which bundled agent configs (`.subagents/*.md`) to copy into the project.
   - Policy: `disabledBackends`, `blockModels`, `blockClaudeModels`. Only offered when the running
     server supports them (PR #7 merged); otherwise skipped silently.
3. Existing `.subagents/models.yaml`: Claude proposes edits against the current file, shows the
   diff, writes `models.yaml.bak`, then writes only after an explicit yes. Hand-written entries and
   comments (for example local OpenCode models) are preserved; nothing is regenerated from scratch.
4. Config hot-reloads, so no restart is needed. Claude confirms with `list_models`.

Out of scope for `i`: building, MCP registration, `~/.claude/settings.json`, the status line,
endpoints, the Agent-tool deny. Those stay in SETUP.md.

## `u`: update, and UPDATING.md

`UPDATING.md` is the procedure Claude follows when `u` submits its prompt (or when someone asks
Claude to "update subagent-mcp"). The prompt is just: follow UPDATING.md in the install repo.

Constraints the procedure must honor:

- Rebuilding the live checkout mid-session can drop the host connection. So Claude never runs
  `npm ci && npm run build` in the live checkout while the session is using it.
- Nothing updates without the person's yes, and uncommitted local changes are never discarded.

Procedure outline:

1. Preflight: read `update.json`, show current vs latest version and release notes; check `git status`
   of the install repo is clean (or stop and report); check `list_agents` for running agents.
2. Prepare in a worktree: `git fetch --tags`, `git worktree add` at the release tag, `npm ci`,
   `npm run build`, `npm test`. Report results; stop on any failure.
3. Migration notes: apply any steps the release's notes list (config keys added or renamed). Each
   release that changes `models.yaml` or agent-config semantics must add a note to UPDATING.md.
4. Swap: the one step that touches the live install. Claude tells the person to exit the session
   and gives the exact commands (checkout the tag, `npm ci && npm run build`), or runs them if the
   person confirms they are between sessions. Then restart with `subagent-mcp`.
5. After restart, `/subagent-mcp` then `i` is the way to review roster changes the release made.

## Distribution and updates of the panel itself

The panel is part of `mod/subagent-strip`, so it updates with the checkout and needs no separate
file install. `plugin.json` version bumps with the panel. SETUP.md gains one line pointing at
`/subagent-mcp`; the status-line `settings.json` step is unchanged.

## Tests and acceptance

- Unit tests for the panel's pure logic: list ordering, key-to-action mapping, confirmation state,
  detail formatting (`claude plugin test` style, as in the plugin examples).
- `claude plugin validate mod/subagent-strip` and `tsc -p mod/subagent-strip` clean.
- Manual acceptance (add to `docs/acceptance.md`): launch via `bin/subagent-mcp`; spawn two
  agents; open `/subagent-mcp`; stop one with confirmation; resolve an approval; inspect a result;
  clean up a leftover worktree; run `i` against a scratch project and check the diff and `.bak`;
  with a fake newer `update.json`, run `u` through steps 1 and 2 only.

## Open questions

1. **Narrow terminals.** Panes seat only above a width threshold (about 110 columns). Fallback when
   the terminal is narrower: nothing (command reports why), or a text menu using question prompts?
2. **Key handling in a pane.** The plugin API exposes key events and buttons, but the exact
   mechanism for per-key shortcuts inside a pane needs confirming against the types before build.
3. **`/subagent-mcp` outside the launcher.** Plain `claude` sessions have no command. Acceptable?
4. **`u` swap step.** Run by Claude after an explicit "I'm between sessions", or always handed to
   the person as commands? The outline above uses the latter by default.
5. **Policy section of `i` before #7 merges.** Skip silently (as drafted), or gate the whole flow
   on #7?
7. **Prompt delivery.** Channel message needs a server change and a user-instruction channel
   event; `$.prompt.submit` needs neither. Confirm the channel route is worth the extra surface.
6. **PR #7 conflicts.** The spec's policy step assumes #7 gets rebased and merged first.
