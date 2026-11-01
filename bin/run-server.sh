#!/usr/bin/env bash
# Starts the subagent-mcp MCP server (this is what `claude mcp add` points at).
#
# - Falls back to the bundled .subagents config when the current project has none.
# - If endpoints are configured (see nim/README.md), starts the local litellm proxy for them.
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/subagent-mcp"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/subagent-mcp"

if [[ ! -f "$ROOT/dist/src/server.js" ]]; then
    echo "subagent-mcp: not built; run 'npm install && npm run build' in $ROOT" >&2
    exit 1
fi

if [[ -z "${SUBAGENT_MCP_MODELS_FILE:-}" && ! -f "$PWD/.subagents/models.yaml" ]]; then
    export SUBAGENT_MCP_MODELS_FILE="$ROOT/.subagents/models.yaml"
fi
if [[ -z "${SUBAGENT_MCP_AGENTS_DIR:-}" && ! -d "$PWD/.subagents" ]]; then
    export SUBAGENT_MCP_AGENTS_DIR="$ROOT/.subagents"
fi

# Endpoints (NIM / generic OpenAI-compatible) are managed by `subagent-mcp endpoint ...`, which writes
# litellm.yaml and opencode.json here. Codex and Claude agents reach them through a local litellm proxy;
# OpenCode talks to them directly.
export SUBAGENT_MCP_PROXY_KEY="${SUBAGENT_MCP_PROXY_KEY:-local}"
if [[ -z "${OPENCODE_CONFIG:-}" && -f "$CONFIG_DIR/opencode.json" ]]; then
    export OPENCODE_CONFIG="$CONFIG_DIR/opencode.json"
fi

PROXY_PORT="${SUBAGENT_MCP_NIM_PORT:-4131}"
if [[ -f "$CONFIG_DIR/litellm.yaml" ]] && grep -q 'model_name' "$CONFIG_DIR/litellm.yaml" && command -v litellm >/dev/null \
    && ! curl -s -o /dev/null "http://127.0.0.1:${PROXY_PORT}/health/liveliness"; then
    mkdir -p "$STATE_DIR"
    PYTHONPATH="$ROOT/nim${PYTHONPATH:+:$PYTHONPATH}" \
        nohup litellm --config "$CONFIG_DIR/litellm.yaml" --port "$PROXY_PORT" \
        >"$STATE_DIR/proxy.log" 2>&1 &
    disown
    for _ in $(seq 1 30); do
        curl -s -o /dev/null "http://127.0.0.1:${PROXY_PORT}/health/liveliness" && break
        sleep 0.5
    done
fi

exec node "$ROOT/dist/src/server.js" "$@"
