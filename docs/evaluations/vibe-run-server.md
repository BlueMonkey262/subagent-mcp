# Evaluation: `vibe run-server` as a third Vibe transport (Milestone 4)

Date: 2026-11-14, against mistral-vibe 3.1.2 on macOS, model alias `zai-glm-5-3-flash`.
**Recommendation: do not add a run-server transport now.** Revisit once subagent-mcp has a real
sandbox (for example a container) to offer, because run-server cannot run without one.

## What run-server is

`vibe run-server [--max-runs N] [--runs-per-app-server K]` (hidden, experimental) serves many
headless runs over JSON-RPC on stdio: `initialize`, then `run/start {runId, prompt, agentSocket,
outputDir, resumeSessionId?, agent?, autoApprove?, enabledTools?, disabledTools?, maxTurns?,
maxTokens?, maxPrice?, timeLimit?, config?, credentials?}`, `run/stop {runId}`, and a
`run/ended` notification carrying the same outcome and export as `vibe -p`. Up to 16 runs share
one Python app-server process by default.

Each run needs an **agent socket**: a Unix socket the caller serves (mode 0600 in a 0700
directory, path under the 104-byte `AF_UNIX` limit). Vibe calls `agent/initialize`, then
`sandbox/execute {command, cwd, timeout}` and `sandbox/readFile {path, maxBytes}` for every
file and shell tool, plus optional caller tools (`tools/call`).

## What was verified live

- The JSON-RPC handshake and `run/start` work as above.
- An agent socket that answers `agent/initialize` with `workspace: null, python: null` (tools on
  the host) is refused: `run/ended` with `outcome: usage_error`, "The agent socket at agent.sock
  serves no sandbox; vibe run-server runs every session in one". `vibe -p --agent-socket` allows
  a sandbox-less socket, `run-server` does not.
- A long socket path fails as `infrastructure_failure` ("AF_UNIX path too long").

## Measured cost of the current transports

Medians of 3 runs, trivial prompt, same machine:

| Transport | Session ready | Turn end to end |
| --- | --- | --- |
| CLI (`vibe -p`, process per turn) | 1.7 s | 4.1 s |
| ACP, cold (new `vibe-acp` process) | 1.4 s | 2.7 s |
| ACP, warm (process reused) | — | 0.85 s |

A warm `vibe-acp` agent holds about 180 MB resident (one Python process tree per agent), so 12
concurrent agents use about 2.2 GB until the 10-minute idle close.

## Assessment

What run-server would buy: per-turn startup is already gone with warm ACP (0.85 s vs 4.1 s on
the CLI), so the remaining gain is memory, roughly 180 MB per agent shared across up to 16 runs
per app-server.

What it would cost:

1. **subagent-mcp would have to be the sandbox.** Every shell command and file read goes through
   `sandbox/execute` / `sandbox/readFile`, which subagent-mcp would serve. Serving them on the
   host would advertise a sandbox that does not exist, which the integration's quality gates
   forbid ("No transport is falsely advertised as sandboxed"). A real one needs container or VM
   provisioning per run, a workspace sync for the agent's worktree, and a Python inside it.
2. **No approval bridge.** run-server runs are headless like `vibe -p`: a call needing approval
   is denied or auto-approved (`autoApprove`), so it gives up what Milestone 3 added.
3. **Only user-level config loads** (the project lives in the sandbox), so project `.vibe/`
   settings and `AGENTS.md` do not apply unless the sandbox side supplies `instructions`.
4. **Credentials are passed per run** by environment-variable name. Whether a Vibe plan login
   (browser auth, keychain) works there was not established; it likely needs an API key.
5. **Stability.** The flag is hidden and documented in source as "may change or go away without
   notice".

## If it is revisited

Build it as an opt-in `vibeTransport: run-server`, disabled by default, only on top of a sandbox
provider that subagent-mcp actually controls. Reuse the CLI transport's export parsing (run/ended
carries the same outcome and export), keep one run-server per host, and measure failure isolation
(one app-server crash ending up to 16 runs) before enabling it by default.
