---
name: antigravity-general
backend: antigravity
antigravityAgent: subagent-general
description: General-purpose Antigravity (agy) subagent. The system prompt lives in the agy custom agent .agents/agents/subagent-general.md; tool permissions are agy's own (headless runs have no approval protocol).
maxTurns: 40
timeout: 1200
permission:
  allow: []
  deny: ["Bash(sudo:*)"]
  default: escalate
---
This config selects the Antigravity custom agent named by `antigravityAgent`; its Markdown body in
`.agents/agents/subagent-general.md` is the system prompt (the bridge does not lower this body into
a message). Edit that file to change the agent's instructions.

That agent file must list `tools`, or agy gives it only a small read-only set. Headless runs cannot
ask for approval, so actions also need allow rules under `permissions.allow` in
`~/.gemini/antigravity-cli/settings.json` (for example `command(git)`, `write_file(/path/to/repo)`).
For `isolation: worktree` in a project that does not commit `.agents/`, put the agent in
`~/.gemini/antigravity-cli/agents/<name>/agent.md` instead, since a worktree only has committed files.
