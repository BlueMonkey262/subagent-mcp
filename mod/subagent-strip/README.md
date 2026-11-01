# subagent-strip

Shows the active subagent-mcp agents in the status line under the prompt, one colored row each:

    Harness - model - Agent type - Mathematician   12s

- `hooks/register.tsx` polls the subagent-mcp server's `list_agents` every 2 seconds and writes the live
  agents to `live/<session_id>.json` in this folder. It draws nothing itself.
- `../subagent-statusline.py` (the `statusLine` command in `~/.claude/settings.json`, refreshed every second)
  reads that file and prints the rows, keeping only agents whose spawn directory matches the session's
  project, and ignoring the file if it is more than 10 seconds old.
- Colors: Codex purple, OpenCode cyan, Claude orange; approvals in blue.
- Dormant when no subagent-mcp server answers `list_agents` three polls in a row; it then probes once a minute.

The `subagent-mcp` launcher loads this mod automatically (`CLAUDE_CODE_PLUGIN_DIRS`). The status line
command is the one setting that must live in `settings.json`; see SETUP.md.
