# Setting up subagent-mcp (instructions for Claude Code)

You are setting this repo up for the user. Do the steps in order, tell the user what you changed, and
never overwrite existing user config without asking. `<repo>` is the absolute path of this checkout.

## 1. Build

Requires Node >= 22. Run `npm install && npm run build` in `<repo>`. If it fails, stop and report.

## 2. Install the launcher

`mkdir -p ~/.local/bin && ln -sf <repo>/bin/subagent-mcp ~/.local/bin/subagent-mcp`

Check `~/.local/bin` is on PATH; if not, tell the user how to add it to their shell rc (don't edit it
without asking). The launcher runs `claude --dangerously-load-development-channels
server:subagent-mcp "$@"` and loads the status-line mod, so users never type that flag.

## 3. Register the MCP server (user scope)

`claude mcp add -s user subagent-mcp -- <repo>/bin/run-server.sh`

If a `subagent-mcp` server already exists, show it and ask before replacing.

## 4. Status-line mod

The mod itself (`<repo>/mod/subagent-strip`) is loaded by the launcher. The status line needs one
setting in `~/.claude/settings.json`. Back the file up first, then merge (don't replace the file):

```json
"statusLine": { "type": "command", "command": "python3 <repo>/mod/subagent-statusline.py", "refreshInterval": 1 }
```

If the user already has a `statusLine`, do not overwrite it; ask whether to replace it or skip. Do
not set `CLAUDE_CODE_PLUGIN_DIRS` in settings.json (the launcher does it).

## 5. Optional: orchestrator prompt

Ask whether they want the orchestrator as a global agent. If yes, copy
`<repo>/.claude/agents/orchestrator.md` to `~/.claude/agents/` (skip if one exists). Used via
`subagent-mcp --agent orchestrator`.

## 6. Optional: backends and endpoints

Ask which of these they use, and only set those up: Codex (`codex`), OpenCode (`opencode`), Cursor
(`agent`), Antigravity (`agy`). Check each is on PATH. In a project, they can copy `<repo>/.subagents`
as a starting point and edit `models.yaml`; without one the bundled examples are used.

For NVIDIA NIM: `pip install 'litellm[proxy]'` then have the user run `subagent-mcp nim set-key`
(they should type the key; don't ask them to paste it into chat). For any other OpenAI-compatible
URL: `subagent-mcp endpoint add NAME URL --model ID[=alias] [--key KEY]` (repeatable).
Details: `nim/README.md`.

## 7. Verify

Run `npm test`, and tell the user to start a new session with `subagent-mcp` and check that
`list_models` works. Config changes under `.subagents/` hot-reload.
