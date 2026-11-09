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
- Dormant when no subagent-mcp server answers `list_agents` three polls in a row; it then probes once a minute.

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
| `i` | ask Claude to run the setup interview for `.subagents/` |
| `u` | when an update is available, ask Claude to follow `UPDATING.md` (asks first) |

Tests: `claude plugin test mod/subagent-strip` (mocked server). Design: `docs/specs/control-panel.md`.
