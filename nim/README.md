# Endpoints: NVIDIA NIM and generic OpenAI-compatible APIs

Manage with the launcher: `subagent-mcp nim set-key`, `subagent-mcp endpoint add|list|remove`.
State lives in `~/.config/subagent-mcp/` (`endpoints.json`, mode 600, holds keys; plus generated
`litellm.yaml` and `opencode.json`).

- **Codex and Claude agents** go through a local [litellm](https://github.com/BerriAI/litellm) proxy
  (`pip install 'litellm[proxy]'`), started by `bin/run-server.sh` on port 4131
  (`SUBAGENT_MCP_NIM_PORT` to change). Codex speaks the Responses API and the proxy translates it;
  Claude Code reaches the proxy's Anthropic-compatible `/v1/messages` through the `claude-endpoint`
  agent config (`ANTHROPIC_BASE_URL`). `litellm_nim_hooks.py` strips request fields NIM rejects.
- **OpenCode** uses the generated `opencode.json` (via `OPENCODE_CONFIG`, unless you already set it)
  and talks to the endpoint directly.
- The server adds `<endpoint>/<alias>` models to the claude, codex and opencode rosters from
  `endpoints.json`; Codex entries use the `subagent_proxy` provider, which `endpoint add` registers in
  `~/.codex/config.toml`.
- Cursor and Antigravity cannot be pointed at custom endpoints.

Free NIM keys are rate-limited, and NVIDIA sometimes pulls models from serving.
