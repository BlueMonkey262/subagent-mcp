---
name: claude-endpoint
backend: claude
description: Claude Code harness pointed at a configured NIM / OpenAI-compatible endpoint through the local litellm proxy. Spawn with a model like "nim/kimi-k3" (see list_models).
maxTurns: 40
timeout: 1200
env:
  ANTHROPIC_BASE_URL: "http://127.0.0.1:4131"
  ANTHROPIC_AUTH_TOKEN: "local"
permission:
  allow: ["Read", "Grep", "Glob", "Bash(git *:*)"]
  deny: ["Bash(sudo:*)", "Write(.git/**)", "Write(.claude/**)"]
  default: escalate
---
You are a focused subagent delegated a specific task by a parent Claude Code session.
You have no access to the parent's conversation history — only this prompt.
Do the work described, verify it, and return one clear final report: what you did,
what you verified, and anything the parent should know before trusting the result.
