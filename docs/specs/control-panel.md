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
auto-updating anything.

## Where it lives

The `mod/subagent-strip` plugin, which `bin/subagent-mcp` already loads through
`CLAUDE_CODE_PLUGIN_DIRS`. The panel and the `/subagent-mcp` command exist only in sessions started
with the launcher. The MCP server stays registered at user scope (SETUP.md step 3), so a plain
`claude` session can still call its tools but has no panel.

Decided: the earlier requirement that plain `claude` have no server either is dropped. It would need
the launcher to supply the server, and that was tried: a server passed with `--mcp-config` connects,
but `--dangerously-load-development-channels server:<name>` reports "no MCP server configured with
that name", so completion events would never arrive. The `statusLine` entry in `settings.json` is
global; with no mod running it finds no live file and prints nothing, which is acceptable. The poller
that feeds the status line also feeds the panel (one `list_agents` poll, shared), so the panel adds no
extra server load.

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

Decided: `$.prompt.submit({ text })`. The mod submits a fixed setup prompt as a turn once the session
is idle, with the plugin as its origin, and Claude does the work. No server change and no new
channel event. A channel message was considered and rejected: it needs a new server tool and an
event that reads as the person's instruction, for no gain. If the model should read the prompt as
the person's own words, pass `asUser: true`.

`u` shows a confirmation in the panel first ("Update to vX.Y.Z? Claude will build it and
restart the host."); only a yes submits the prompt. `i` submits immediately, since Claude's own
question menus gate every write.

## Layout: list + detail split

- Left column: agents, running first, then recent. Each row: backend, model, config, name,
  elapsed, state. A badge marks a pending approval. Worktrees appear in their own section below
  the agents (the managed worktrees of listed agents; `cleanup_worktree` removes only an agent's own worktree and keeps its branch).
- Right column: detail for the selected row. For an agent: the `summary: true` digest from
  `get_agent_events` (tool counts, last tool calls, message tail), then its result once finished.
  For a worktree: path, branch, whether it has unmerged commits or uncommitted changes.
- Bottom key bar: `s` stop, `x` stop all, `a` approve/deny, `m` message/resume, `w` clean up
  worktree, `i` init, `u` update, `Esc` close. Keys act on the selected row. Hotkeys are single lowercase letters or digits and fire only while the pane has focus, so there is no shifted `S`.
- Narrow terminals: no fallback needed. `/subagent-mcp` is a command the person typed, and a pane
  opened that way is placed at any width: docked beside the transcript in the fullscreen layout from
  110 columns, otherwise inline above the prompt. The render hook reads whether it was seated
  `dock` or `inline` and uses the split layout when docked, and a single column (agent list, with
  Enter expanding the selected agent's digest in place) when inline. Never open the pane unasked
  (a timer or `session.start`), because unasked panes wait undrawn below 144 columns.
- Update row: when `.subagents/memory/update.json` reports a newer release, a dim notice shows at
  the top of the list and `u` is highlighted.

## Actions

| Key | Does | Confirmation |
|---|---|---|
| `s` | `stop_agent` on the selected running agent | yes |
| `x` | `stop_agents` for every running agent | yes, shows the count |
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
4. Swap: the one step that touches the live install. Decided: Claude runs it, after the panel's
   confirmation (before the prompt is sent) and after step 2 passes. Claude checks out the tag in
   the install repo, runs `npm ci && npm run build`, then calls `restart_host` so the session picks
   up the new code. A rebuild can still drop the host connection; if it does, Claude says so and
   `/mcp` reconnects. The step is last so a failure earlier leaves the old install untouched.
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

Resolved: narrow terminals (above), outside-launcher behavior (above), swap step (above), prompt
delivery (above), PR #7 ordering (#7 is rebased and merged first, so `i` always offers the policy
section and may assume the running server supports it).

1. **Per-key shortcuts in a pane.** The plugin API has key events (`onKey` on a client, `key` on a
   mounted drawing) and Buttons, but how a pane receives keys while the prompt box has focus is
   unconfirmed. Resolve with a throwaway prototype pane before building the real one; fall back to
   Buttons/Select inside the pane if bare letters collide with typing.
2. **Launcher-supplied MCP server.** Verify `--mcp-config` plus the development-channels flag works
   as described under "Where it lives", and that plain `claude` then sees nothing.
3. **`restart_host` after a rebuild.** Confirm it reconnects cleanly to the freshly built code in
   the same session; if not, `u` ends by telling the person to restart the session.
