# Setting up subagent-mcp

Follow these steps yourself, or point Claude Code at this repo and ask it to "set up subagent-mcp".
Claude should do the steps in order, say what it changed, and never overwrite existing config without
asking. `<repo>` is the absolute path of your checkout.

## Prerequisites

- Node.js 22 or newer
- [Claude Code](https://claude.com/claude-code) (`claude` on your PATH)
- Python 3 (only for the optional status line)
- Optional backends, install only the ones you want: Codex (`codex`), OpenCode (`opencode`),
  Cursor (`agent`), Antigravity (`agy`)

## 1. Build

```sh
cd <repo>
npm install && npm run build
```

## 2. Install the launcher

```sh
mkdir -p ~/.local/bin && ln -sf <repo>/bin/subagent-mcp ~/.local/bin/subagent-mcp
```

Make sure `~/.local/bin` is on your PATH. The launcher runs
`claude --dangerously-load-development-channels server:subagent-mcp "$@"` and loads the status-line
mod, so you never type that flag yourself. Start Claude Code with `subagent-mcp` instead of `claude`.

## 3. Register the MCP server

```sh
claude mcp add -s user subagent-mcp -- <repo>/bin/run-server.sh
```

If a `subagent-mcp` server is already registered, remove or replace it first.

## 4. Status line (optional)

The mod in `<repo>/mod/subagent-strip` is loaded by the launcher. The status line needs one setting
in `~/.claude/settings.json`. Back the file up, then merge this in (don't replace the file):

```json
"statusLine": { "type": "command", "command": "python3 <repo>/mod/subagent-statusline.py", "refreshInterval": 1 }
```

Each active agent gets one row: backend, model, agent config, name, elapsed time, and tokens so far,
for example `Codex - gpt-5.6-luna - General - Euler 1m15s · 7.4k new · 29.7k cached · 10 out`. Input
is split into new and cached where the backend allows it; otherwise the row shows a single `in`.

If you already have a `statusLine`, decide whether to replace it or skip this step. Don't set
`CLAUDE_CODE_PLUGIN_DIRS` in `settings.json`; the launcher does it.

## 5. Configure agents and models

Without a `.subagents/` directory in your project, the server uses the examples bundled in this repo.
To customize, copy `<repo>/.subagents` into your project and edit `models.yaml` so it lists the models
you actually have access to (`agent --list-models`, `opencode models`, and so on). Changes under
`.subagents/` hot-reload.

## 6. Optional: custom endpoints

For NVIDIA NIM, install litellm (`pip install 'litellm[proxy]'`), then run
`subagent-mcp nim set-key` and type your key at the prompt. For any other OpenAI-compatible URL:

```sh
subagent-mcp endpoint add NAME URL --model ID[=alias] [--key KEY]   # repeatable
```

Details: [`nim/README.md`](nim/README.md).

## 7. Verify

Run `npm test`, start a new session with `subagent-mcp`, and check that the `list_models` tool works.
