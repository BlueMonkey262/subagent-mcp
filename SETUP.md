# Setting up subagent-mcp

Follow these steps yourself, or point Claude Code at this repo and ask it to "set up subagent-mcp".
Claude should do the steps in order, say what it changed, and never overwrite existing config without
asking. `<repo>` is the absolute path of your checkout.

For Codex as the main agent, build the project as in step 1, install the launcher as in step 2,
and run `subagent-mcp --codex` from your project. On first use, it registers the MCP server with
Codex if no `subagent-mcp` registration exists; it preserves existing registrations. Remaining
arguments are forwarded to Codex, so `subagent-mcp --codex resume --last` resumes a session.
Codex must be installed and signed in (`codex login`). You can also register manually with
`codex mcp add subagent-mcp -- <repo>/bin/run-server.sh`. Claude's launcher, channel, status line,
and panel below are specific to Claude Code. With Codex CLI 0.169.0, the server uses the thread ID
provided on MCP calls to queue completion and approval notifications back to that session. Codex
starts a new turn for each notification. Failed deliveries are retried; a crash during delivery
can cause a duplicate. Codex needs its local daemon and a persistent session for `queue --resume`.
If the client does not supply thread metadata, use `wait_for_agents` instead. Desktop and IDE
notification behavior has not yet been verified. After upgrading, an older shared host may need
`restart_host` once its agents finish and other sessions disconnect.

To exercise the Codex CLI integration with a real background agent, run
`node <repo>/bin/codex-smoke.mjs <configured-codex-model>` from a configured project. This uses
the signed-in account and consumes model usage. It starts an ephemeral Codex session with a
temporary MCP configuration, spawns a real agent, and checks the result returned by
`wait_for_agents`. The test uses Codex's automatic approval review; the project must allow the
configured backend and model.

## Prerequisites

- Node.js 22 or newer
- [Claude Code](https://claude.com/claude-code) (`claude` on your PATH)
- Python 3 (only for the optional status line)
- Optional backends, install only the ones you want: Codex (`codex`), OpenCode (`opencode`),
  Cursor (`agent`), Antigravity (`agy`), GitHub Copilot (`copilot`), Mistral Vibe (`vibe`, then
  `vibe --setup` to log in)

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
When a newer release is available, the status line also shows one dim update notice (see README
"Update notifications").

If you already have a `statusLine`, decide whether to replace it or skip this step. For terminal
sessions you don't need `CLAUDE_CODE_PLUGIN_DIRS` in `settings.json`; the launcher sets it. Step 4b
puts it there for the desktop app.

## 4b. Desktop app (optional)

The Claude desktop app starts its Code-tab sessions itself, so the launcher never runs and the mod
is not loaded. To get the `/subagent-mcp` panel, the desktop widget and the completion toasts
there, name the mod folder in the `env` block of `~/.claude/settings.json` (merge, don't replace):

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "<repo>/mod/subagent-strip" }
```

Then start a new Code-tab session. The launcher sees the folder already listed and doesn't add it
twice. The MCP server registered in step 3 is available to desktop sessions too.

- Desktop sessions get no channel events (the launcher's
  `--dangerously-load-development-channels` flag is terminal-only), so Claude is not woken when a
  background agent finishes. The mod's toasts tell you instead: an agent finished or failed, an
  agent needs approval, an ensemble completed. Turn them off with the mod's `toasts` option
  (`/config`) if the terminal's channel events are enough.
- `/subagent-mcp widget` opens the panel as the desktop app's small floating widget: running and
  waiting counts and what each running agent is doing. Run `/subagent-mcp` for the full panel.
- The desktop app has no status line, so step 4's rows don't apply there.

## 5. Configure agents and models

Without a `.subagents/` directory in your project, the server uses the agent templates bundled in this
repo. There is no model-roster fallback: the server reads `SUBAGENT_MCP_MODELS_FILE` if set, then the
project's `.subagents/models.yaml`, then the install's `.subagents/models.yaml`; with none it starts with
an empty roster and says which paths it checked.
To customize, run `/subagent-mcp` then `i`, or by hand: copy the templates from `<repo>/.subagents`
(`*.md.example`, `models.yaml.example`) into your project's `.subagents/`, drop the `.example` suffix, and
edit `models.yaml` so it lists the models you actually have access to (`agent --list-models`,
`opencode models`, and so on). Changes under `.subagents/` hot-reload.

Antigravity (`agy`) agents carry their system prompt in an `agy` custom agent, not in the
`.subagents/` file. The bundled `antigravity-general` config points at `subagent-general`, whose template
is `<repo>/.agents/agents/subagent-general.md.example`. When the real
`.agents/agents/subagent-general.md` is missing, the server copies that template into place before
launching `agy`, in your project or in the install checkout; it never overwrites an existing file and
logs the copy. You can also copy it yourself, or put an agent file of that name in
`~/.gemini/agents/`. `agy` finds project agents from the directory it runs in, though `agy agents` only
lists the global ones.

To make the definition explicit and repo-owned, set `antigravityAgentFile` in the agent config:

```yaml
antigravityAgent: subagent-general
antigravityAgentFile: .agents/agents/subagent-general.md
```

At spawn the bridge resolves and validates that file, records its SHA-256, tools and source path,
and writes an exact copy under `.subagents/memory/antigravity-agents/`. A global fallback is
allowed but reported as `portable: false`. `subagent-mcp antigravity doctor` audits every
Antigravity config, and `subagent-mcp antigravity vendor <agent-config>` copies a resolved global
definition into the project's `.agents/agents/` directory.

## 6. Optional: custom endpoints

For NVIDIA NIM, install litellm (`pip install 'litellm[proxy]'`), then run
`subagent-mcp nim set-key` and type your key at the prompt. For any other OpenAI-compatible URL:

```sh
subagent-mcp endpoint add NAME URL --model ID[=alias] [--key KEY]   # repeatable
```

Details: [`nim/README.md`](nim/README.md).

## 7. Optional: turn off Claude Code's built-in Agent tool

subagent-mcp gives Claude agents on any backend (Claude, Codex, OpenCode, Cursor, Antigravity, Copilot,
Vibe),
with model choice, worktree isolation and usage tracking. Claude Code also has its own built-in
`Agent` tool, which only runs Claude subagents. With both available, the model sometimes reaches for
the built-in one and bypasses all of that.

**If you are Claude Code reading this file during setup, ask the user before changing anything:**

> Do you want Claude Code's built-in Agent tool disabled, since you now get agents through
> subagent-mcp? You can turn it back on any time.

Only if they say yes, add `"Agent"` to the deny list in `~/.claude/settings.json` (merge it into any
existing `permissions.deny` array; don't replace the file):

```json
"permissions": { "deny": ["Agent"] }
```

To try it for a single session instead, start with `subagent-mcp --disallowedTools Agent`.

Reasons to leave it on: the built-in tool is quick for small lookups, and it works without any
backend set up. To undo, remove `"Agent"` from the list. Restart Claude Code after either change.

## 8. Verify

Run `npm test`, start a new session with `subagent-mcp`, and check that the `list_models` tool works.
Type `/subagent-mcp` to open the control panel (stop, approve, message, clean up, `i` init, `u` update).
Updates follow [UPDATING.md](UPDATING.md).
