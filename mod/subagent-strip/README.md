# subagent-strip

Shows the active subagent-mcp agents in the status line under the prompt, one colored row each:

    Harness - model - Agent type - Mathematician   12s · 7.3k new · 11.3k cached · 210 out

- `hooks/register.tsx` polls the subagent-mcp server's `list_agents` every 2 seconds and writes the live
  agents to `live/<session_id>.json` in this folder. It draws nothing itself.
- `../subagent-statusline.py` (the `statusLine` command in `~/.claude/settings.json`, refreshed every second)
  reads that file and prints the rows, keeping only agents whose spawn directory matches the session's
  project, and ignoring the file if it is more than 10 seconds old.
- Tokens are the agent's `cumulative_usage` from `list_agents`: finished turns plus the turn in
  progress. Input is split into `new` (processed fresh, cache writes included) and `cached` (cache
  reads) for Claude, Codex, OpenCode and Cursor. Antigravity's split is unverified, so it shows a
  single `in`, as do turns recorded before the split existed. Claude, Codex and OpenCode 2.x update
  mid-turn; Cursor and Antigravity update when a turn ends.
- Colors: Codex purple, OpenCode cyan, Claude orange; approvals in blue.
- If `<project>/.subagents/memory/update.json` reports an available release, one dim update row is printed after the agent rows.
- Dormant when no subagent-mcp server answers three polls in a row; it then probes once a minute.
- The poller reads `get_dashboard` (one call, and only a revision while nothing changed), falling back to
  `list_agents` on a server that predates it (and tries `get_dashboard` again every 5 minutes, since a `/mcp`
  reconnect can bring a newer server).
- Toasts (the `toasts` option, on by default): an agent finished or failed, an agent needs approval, an
  ensemble completed. Ensemble members are reported once, with their ensemble. These matter most in the
  desktop app, which gets no channel events (SETUP.md step 4b).

The `subagent-mcp` launcher loads this mod automatically (`CLAUDE_CODE_PLUGIN_DIRS`). The status line
command is the one setting that must live in `settings.json`; see SETUP.md.

## Control panel: `/subagent-mcp`

Type `/subagent-mcp` to open a panel with the agent list (`hooks/panel.tsx`). In Claude Code's
main-screen layout, which is tmux's default, it sits above the prompt; in the fullscreen layout from
110 columns it docks beside the transcript. Keys act on the selected agent and fire only while the pane
has focus:

| Key | Does |
|---|---|
| `j` / `k` | next / previous agent; the selected agent's digest opens under its row |
| `s` / `x` | stop the selected agent / stop all running agents (each asks first) |
| `a` / `r` / `d` | allow / allow for session / deny a pending approval |
| `m` | message or resume the selected agent (an input row; Enter sends) |
| `w` | remove the selected agent's managed worktree (asks first; the branch is kept) |
| `i` | close the pane and ask Claude to run the setup interview for `.subagents/` |
| `1`-`7` | turn a backend off or on (edits only the `disabledBackends` line of the `models.yaml` the server loaded, which is the bundled one for a project without its own; a copy goes to `models.yaml.bak`) |
| `l` | show or hide older finished agents (the list keeps running agents and the 5 most recent) |
| `v` | show the selected agent's worktree diff (`get_agent_diff`), one file at a time: `j` / `k` next / previous file, `b` back |
| `u` | when an update is available, close the pane and ask Claude to follow `UPDATING.md` (asks first) |

Running agents show what they are doing: the open tool call, or between calls `thinking, last ran <tool>`.
Ensemble members carry their role, and an Ensembles section under the list shows each recent ensemble's
status and its members' states.

In the desktop app, `/subagent-mcp widget` opens the panel as the small floating widget: a glance with
the running and waiting counts and each running agent's activity, without keys (clicks may not reach a
widget). A minimized full panel draws the same glance.

Tests: `claude plugin test mod/subagent-strip` (mocked server). Design: `docs/specs/control-panel.md`.
