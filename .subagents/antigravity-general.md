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
