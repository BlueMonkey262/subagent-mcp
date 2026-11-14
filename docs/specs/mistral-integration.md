<!--
Implementation status (branch feat/mistral-vibe, 2026-11-14). The plan below is kept as proposed.

Done:
- Milestone 0: `vibe` backend, optional models.vibe roster, effort rejected, capabilities,
  usage cost basis (Vibe cost booked as estimatedCostUsd; still counts against maxCostUsd).
- Milestone 1: Vibe CLI adapter (src/adapters/vibe/), offline fixture tests, docs/protocol/vibe.md.
- Milestone 2 (partial): Mistral API via OpenCode's native provider documented in README;
  `endpoint add --key-env VAR` keeps API keys out of generated files.

Deviations from the plan:
- No separate session store (0.3/1.3): the agent id is Vibe's own session_id, taken from the
  first streamed entry (every entry carries sessionId) or the export, so the supervisor's
  persisted record is enough to resume after a host restart.
- No `vibeTransport` setting yet (0.3): deferred until a second transport (ACP) exists.
- System prompt (1.7): sent in the first prompt, not --system-prompt-file, which replaces Vibe's
  own coding-agent instructions.
- Tool events (1.4): Vibe streams an effect only once it has settled, so tool.start and
  tool.end are emitted together.
- Endpoint generator (2.3): kept the V1 opencode.json shape; OpenCode 2.x still reads it.

Not done: provider-aware rate limiting (2.5), --max-tokens/--max-price wiring,
Milestone 3 (ACP), Milestone 4 (run-server). Live acceptance against an installed Vibe is pending.
-->

# Mistral Integration Implementation Plan
**Project:** BlueMonkey262/subagent-mcp  
**Status:** Proposed implementation  
**Target:** Local multi-backend agent orchestration

## Goals

Integrate Mistral into subagent-mcp with three distinct capabilities:

1. **Milestone 1 — Vibe CLI:** Run Mistral Vibe as a native, resumable subagent using the user's existing local authentication.
2. **Milestone 2 — Mistral API:** Support metered Mistral models through OpenCode, without building another coding-agent harness.
3. **Milestone 3 — Vibe ACP:** Add persistent interactive sessions, structured tool events, and a genuine permission-approval bridge.

An optional fourth milestone investigates Mistral's experimental multi-run server for high-concurrency workloads.

The integration must preserve existing MCP tools and semantics, including `spawn_agent`, `send_message`, `stop_agent`, `list_agents`, `list_models`, `get_agent_events`, `get_agent_result`, worktree isolation, dependency scheduling, structured output validation, and persisted usage accounting.

No special Mistral-only orchestration tools should be necessary.

---

## Milestone 0 — Integration foundation

### Objective

Extend the existing backend infrastructure without introducing Mistral-specific assumptions into the supervisor.

### 0.1. Establish backend identity

Use `vibe` as the new backend identifier rather than `mistral`.

This distinction matters because Vibe can execute models from providers other than Mistral, whereas Mistral API models will execute through OpenCode.

The identities should be:

| Execution path | Backend | Model identity |
|---|---|---|
| Mistral Vibe | `vibe` | Vibe model alias |
| Mistral API | `opencode` | `mistral/<model-id>` |
| Future ACP execution | `vibe` | Vibe model alias |

Do not add a separate `mistral-api` coding backend merely to call chat completions.

### 0.2. Extend shared types

**`src/core/types.ts`**

Add `vibe` to `BACKENDS`.

All backend-keyed maps, model rosters, policies, allowances, and usage snapshots must recognize it.

**`src/config/registry.ts`**

- Support `models.vibe`.
- Allow existing projects to omit this field, defaulting to an empty roster.
- Reject unknown or invalid Vibe model aliases before execution.
- Initially reject `reasoningEffort` for Vibe CLI, because no verified direct CLI mapping is available.
- Preserve model selection on resume.

**`src/execution.ts`**

Update backend capabilities to distinguish supported, unsupported, and transport-dependent features.

The existing static `capabilities(backend)` function is adequate for the CLI milestone, but ACP will eventually require capabilities to be reported by the selected transport.

### 0.3. Add transport configuration

Add an optional Vibe transport setting to agent configuration:

`vibeTransport: cli | acp`

Default to `cli`.

For Milestone 0, only `cli` is valid. Milestone 3 enables `acp`.

Persist the selected transport in the agent record so that an agent cannot silently change transports when its configuration is reloaded.

A resumed CLI session must remain a CLI session unless an explicit, tested migration mechanism is introduced.

### 0.4. Extend usage provenance

The current usage system tracks token counts and `costUsd`, but Vibe's reported cost may be an estimate rather than a billable charge, particularly for subscription usage.

Add optional metadata distinguishing:

- Billing channel: `plan`, `api`, or `unknown`
- Cost basis: `estimated`, `reported`, or `unknown`
- Provider identity: `mistral` or another actual provider

Keep the existing numeric usage fields backward compatible.

Do not interpret missing costs as proof that execution was free. Do not combine estimated plan consumption and API billing into an authoritative monetary total.

### 0.5. Foundation tests

Extend:

- `test/config.test.ts`
- `test/model-policy.test.ts`
- `test/usage.test.ts` if introduced, otherwise the existing usage test coverage
- `test/host.test.ts`

Verify that legacy models.yaml files load unchanged and that Vibe models participate correctly in backend blocking, model selection, allowances, and persisted usage.

### Acceptance criteria

- Existing backend tests still pass.
- Old configurations remain valid.
- Vibe models appear in the model roster.
- Unsupported effort values are rejected explicitly.
- No changes to the external MCP tool surface are necessary for a basic Vibe spawn.

---

## Milestone 1 — Native Mistral Vibe CLI adapter

**Priority: P0**

### Objective

Make Mistral Vibe behave like the existing Cursor or Antigravity agents: locally launched, observable, cancellable, and resumable.

### 1.1. Implement the adapter

Create:

- `src/adapters/vibe/adapter.ts`
- `src/adapters/vibe/arguments.ts`
- `src/adapters/vibe/parser.ts`
- `src/adapters/vibe/session-store.ts`
- `src/adapters/vibe/index.ts`

Implement the existing `BackendAdapter` interface:

- `spawn(request)`
- `resume(request)`
- `interrupt(agentId)`
- `events(agentId, options)`
- `approve(agentId, resolution)`
- `providerInfo(signal)`, where supported

Follow the one-process-per-turn architecture of `CursorAdapter`.

Each agent turn launches a new Vibe process. Conversation history persists in Vibe's own session store.

### 1.2. Process invocation

Use the documented programmatic interface:

`vibe -p --output streaming --output-dir <dir> --model <alias> --max-turns <n> --time-limit <seconds>`

Use `--resume <session-id>` on subsequent turns.

The precise argument set should be built from the resolved agent configuration, not from user-supplied command strings.

Implementation requirements:

- Use Node's `spawn()` with `shell: false`.
- Pass the prompt through stdin using `-p` without an inline argument, rather than exposing potentially large prompts in the command-line argument list.
- Set `cwd` to the supervisor-selected repository or managed worktree.
- Preserve the child environment needed for local Vibe authentication.
- Pass `SUBAGENT_MCP_DEPTH`.
- Use `detached: true` and the repository's existing process-group termination utility.
- Avoid calling `--continue`, which can select another session.
- Do not invoke Vibe's own `--worktree` when subagent-mcp has already allocated a worktree.

Add `VibeAdapterOptions` for executable path, startup timeout, termination grace period, environment overrides, and fixture injection.

### 1.3. Session identity and persistence

This is the most important lifecycle difference from Cursor.

Vibe's headless export contains the native `session_id`, but that export is written at the end of a run. The adapter cannot depend on receiving that ID before returning its initial spawn receipt.

Generate a stable subagent-mcp agent ID at launch.

Persist a mapping such as:

`agentId → vibeSessionId`

under:

`.subagents/memory/vibe/`

Store the mapping separately from Vibe's native session journal.

Suggested record:

- Stable subagent-mcp agent ID
- Native Vibe session ID, nullable until established
- Model alias
- Transport
- Working directory
- Current turn ID
- Output-directory location
- Last completed turn
- Last known lifecycle status
- Vibe version
- Timestamp of the last successful export

Persist records atomically using temporary files and rename.

On process completion, read `export.json` and commit the native session ID before publishing the final terminal event.

On host restart, rebuild the adapter's session mapping from disk.

If a run was killed before producing a recoverable native session ID, mark the turn interrupted and explicitly report that resume is unavailable. Never guess a Vibe session ID or resume the most recent unrelated session.

### 1.4. Normalize Vibe output

Vibe's `streaming` output consists of completed message entries, not necessarily individual model-token deltas.

Create a parser that converts verified Vibe message and tool-entry structures into subagent-mcp's existing event schema.

| Vibe information | Normalized event |
|---|---|
| Initial adapter receipt | `thread.started` |
| Completed assistant message text | `message.delta` |
| Tool execution begins | `tool.start`, when observable |
| Tool execution settles | `tool.end` |
| Run usage becomes available | `usage.updated` or final usage |
| Run finishes | `turn.completed` |
| Fatal execution problem | `error` |

Do not assume that `--output streaming` provides token-by-token streaming.

The parser should be designed against captured output fixtures from the supported Vibe version, including incomplete and malformed records.

Use the final export as the authoritative source for termination, usage, and session ID.

### 1.5. Terminal outcome mapping

Use `export.json`'s `outcome` field rather than treating process exit code 0 alone as proof of success.

| Vibe outcome | Supervisor outcome |
|---|---|
| `finished` | completed |
| `terminated` | interrupted |
| `deadline` | failed with timeout reason |
| `turn_limit` | failed with limit reason |
| `token_limit` | failed with limit reason |
| `price_limit` | failed with limit reason |
| `refusal` | failed, retaining available response |
| `usage_error` / `config_error` | failed |
| `infrastructure_failure` | failed |
| `aborted` | failed or interrupted according to verified cancellation origin |

Retain partial output even when a run fails.

A missing, invalid, or inconsistent export is an infrastructure failure, not an automatic success.

Emit exactly one terminal event per turn.

### 1.6. Permissions

Headless Vibe cannot ask subagent-mcp to approve individual tool calls. Its documented behavior is to deny tool calls that require interactive approval.

Implement two explicit execution profiles initially:

**Restricted profile**

- Default for review, analysis, and exploration.
- Select only the read-oriented Vibe tools verified to exist in the installed version.
- Do not enable shell execution or file-writing tools.
- Do not enable automatic approval.
- Reject requested permission rules that cannot be enforced rather than silently ignoring them.

**Trusted execution profile**

- Selected explicitly through `permission.default: allow`.
- Enable execution with `--auto-approve` only when the local Vibe configuration permits it.
- Strongly recommend a disposable worktree, container, or equivalent isolation.
- Clearly disclose that a Git worktree separates source changes but is not a security sandbox.

Do not claim to enforce arbitrary per-command allow/deny patterns through the CLI unless they can be mapped to verified Vibe tool permissions.

The adapter's `approve()` method must report that inline approval is unsupported. Set `relaysDenyMessage: false`.

Milestone 3 will provide actual approval bridging.

### 1.7. System prompts

Support `AgentConfig.systemPrompt`.

Vibe provides `--system-prompt-file`, but this option replaces Vibe's ordinary system instructions. Test both the explicit system-prompt-file route and an agent-instruction section in the submitted prompt.

Use the approach that preserves Vibe's coding-agent functionality while honoring the configured instructions. Do not silently discard either the project context or subagent instructions.

Treat the generated system-prompt file as trusted configuration, and never substitute repository-controlled content into it without operator approval.

### 1.8. Usage and budgets

Read the final Vibe export fields:

- `usage.input_tokens`
- `usage.output_tokens`
- `usage.cached_input_tokens`
- `cost_usd`
- `steps`
- `warnings`

Calculate uncached input as `input_tokens - cached_input_tokens` when the values are valid.

Use `--max-turns`, `--max-tokens`, and `--time-limit` when configured.

Expose `--max-price` only as an approximate budget mechanism. Mistral notes that the model-pricing data backing this limit may be missing or outdated.

Do not claim that `--max-price` is a hard billing safeguard.

### 1.9. Host integration

Update:

- `src/host.ts`: create, register, and shut down the Vibe adapter.
- `src/server.ts`: include Vibe in tool descriptions and accepted backend enums.
- `src/config/registry.ts`: resolve Vibe model aliases and transport settings.
- `src/execution.ts`: expose CLI capabilities.
- `.subagents/models.yaml`: include an empty or explicitly configured Vibe roster.
- `.subagents/vibe-general.md`: add a sample agent configuration.
- `README.md`: document setup and execution.
- `docs/protocol/vibe.md`: document the verified protocol.

### 1.10. Testing

Create:

- `test/vibe-fixture.mjs`
- `test/vibe-adapter.test.ts`

Cover:

- Launch and completion
- Native session ID capture
- Resume after process exit
- Resume after MCP reconnect
- Resume after host restart
- Malformed JSON
- Partial output
- Missing export
- CLI startup failure
- Timeout and SIGTERM
- Child-process cleanup
- No duplicate terminal event
- Concurrent independent sessions
- Usage extraction
- Budget stop outcomes
- Strict permission behavior
- Worktree execution
- Missing Vibe installation
- Invalid model alias

Integration tests must use a fake executable and run offline. Add an opt-in live acceptance test against the installed Vibe CLI.

### Milestone 1 acceptance criteria

A user can spawn a Vibe agent, inspect its events, retrieve its result, stop it, reconnect subagent-mcp, and resume the same Vibe conversation.

The agent appears in all normal supervisor views and works with dependency scheduling, structured result validation, and worktree isolation.

**Deliverable:** A fully usable first-class Vibe backend without ACP.

---

## Milestone 2 — Mistral API via OpenCode

**Priority: P1**

### Objective

Make Mistral API models available for metered coding-agent delegation without duplicating OpenCode's existing tools, session management, and provider support.

### 2.1. Prefer OpenCode's native provider

OpenCode already supports a provider catalog and user-managed credentials.

Use its native `mistral` provider where available.

Expected workflow:

1. The user connects Mistral in OpenCode through `/connect`.
2. The user discovers actual available models through `opencode models`.
3. The user adds selected `mistral/<model-id>` values to the `opencode` section of `.subagents/models.yaml`.
4. subagent-mcp launches those models through its existing OpenCode adapter.

The existing shared OpenCode server remains responsible for tool execution, session continuation, and model requests.

Do not introduce a standalone Mistral chat-completions adapter that would need to rebuild OpenCode's coding harness.

### 2.2. Add Mistral model discovery

Extend `list_models` with useful Mistral-specific metadata extracted from OpenCode's provider information:

- Available model ID
- Context and output limits, if reported
- Input/output price metadata, if reported
- Tool-use support, if reported
- Availability or authentication errors
- Backend routing
- Billing channel

Do not hardcode a permanent recommended model list.

Mistral model aliases, availability, and prices can change. Discovery must remain authoritative.

### 2.3. Improve custom endpoint support

Review and update `bin/endpoints.mjs`.

The current generator emits an older OpenCode configuration shape (`provider`, `npm`, `options`), while current OpenCode documentation uses `providers`, `package`, `env`, and `settings`.

Implement version-aware generation or adopt a documented minimum supported OpenCode version. Validate the generated file using the actual installed OpenCode executable.

If native provider support is unavailable, permit an explicitly configured Mistral-compatible endpoint using:

`https://api.mistral.ai/v1`

Avoid enabling Claude or Codex routes automatically for that endpoint. The existing endpoint manager adds compatible endpoints to several backend rosters, but protocol compatibility must be verified per backend.

In particular, an OpenAI-compatible chat-completions endpoint does not necessarily implement the Responses API expected by a Codex provider.

### 2.4. Credentials

Prefer OpenCode's existing credential store and provider authentication.

For explicitly configured endpoints, support environment-variable references such as `MISTRAL_API_KEY` instead of requiring literal secrets in `endpoints.json`.

Never store the same API key unnecessarily in multiple generated files.

Do not use a Vibe-plan key as an implicit fallback for API requests. The user should intentionally configure a credential appropriate to API automation.

### 2.5. Provider-aware rate limiting

Mistral API limits cover requests per second and model-specific token throughput, with organization-wide consumption ceilings.

The existing global `maxConcurrent` setting limits agent processes, not necessarily provider requests.

Add optional provider-aware concurrency settings, initially:

- Maximum active agents using the Mistral API
- Cooldown after recognized provider throttling
- Retry policy with jitter and bounded attempts
- Separate visibility for authentication failures, rate limits, and exhausted budgets

Keep this separate from the Vibe plan's limits.

Do not automatically replay a complete agent turn after a transport failure if that turn may already have executed filesystem-changing tools.

Retrying individual requests through the existing OpenCode transport is preferable to replaying entire agent executions.

### 2.6. Usage accounting

Aggregate Mistral API usage by actual model and provider within the existing OpenCode backend.

Expose both backend and provider grouping in usage views.

Avoid conflating:

- Vibe plan usage
- Mistral pay-as-you-go API usage
- Other providers executed through OpenCode

Keep estimated API cost separate from authoritative invoiced cost.

### 2.7. Tests

Extend:

- `test/opencode-adapter.test.ts`
- `test/live-config.test.ts`
- `test/config.test.ts`
- `test/model-policy.test.ts`
- Existing usage and endpoint tests

Test:

- Native provider discovery
- Invalid or unavailable model
- Missing authentication
- API rate limit
- Retry behavior
- Per-provider concurrency
- Model blocking by real upstream ID
- Session resume
- Accurate model attribution
- Endpoint generator output
- No accidental Codex/Claude registration of incompatible endpoints
- No credential leakage in logs or generated diagnostics

### Milestone 2 acceptance criteria

A user can select a Mistral API model in the normal subagent-mcp roster, launch it through OpenCode, resume it, inspect usage, and distinguish that API consumption from Vibe-plan consumption.

Existing OpenCode Go and other provider functionality remains unchanged.

**Deliverable:** Reliable, economically metered Mistral inference through the existing coding harness.

---

## Milestone 3 — Native Vibe ACP integration

**Priority: P2**

### Objective

Add an interactive transport that supports actual tool approvals, structured agent progress, persistent sessions, and richer model capabilities.

Vibe includes `vibe-acp`, an implementation of the Agent Client Protocol. Its source supports session loading, session updates, configurable models, cancellation, and permission requests.

This milestone should preserve the original CLI adapter as a fallback.

### 3.1. Implement ACP transport

Create:

- `src/adapters/vibe/acp-client.ts`
- `src/adapters/vibe/acp-adapter.ts`
- `src/adapters/vibe/acp-events.ts`
- `src/adapters/vibe/acp-permissions.ts`

Use the official ACP protocol and its maintained schemas rather than ad hoc JSON parsing wherever possible.

Launch `vibe-acp` as a child process.

Implement the required protocol operations:

- Initialization and capability negotiation
- New session
- Prompt submission
- Session notifications
- Session loading
- Session cancellation
- Model configuration
- Permission-request handling

Preserve native ACP session IDs in the same stable identity model established by Milestone 1.

Do not automatically switch an existing CLI session into ACP. Treat transport identity as immutable for the initial implementation.

### 3.2. Bridge tool approvals

This is the key feature.

Vibe ACP exposes permission requests to its client, unlike non-interactive CLI mode.

Map ACP permission requests into the existing subagent-mcp approval coordinator.

Flow:

1. Vibe requests approval for a tool execution.
2. The adapter normalizes the tool name, arguments, affected files, and available choices.
3. subagent-mcp emits `approval.requested`.
4. The orchestrator calls `resolve_approval`.
5. The adapter maps the decision to the appropriate ACP permission-option ID.
6. Vibe resumes or rejects the tool call.

Support one-time, session-wide, and denial decisions only when the relevant ACP options are advertised.

If a decision cannot be represented safely, fail closed.

Do not claim that denial messages are delivered to the model until verified by tests.

Ensure that pending approvals survive long enough for normal MCP reconnection without being silently approved.

### 3.3. Native progress events

Use ACP session notifications to provide:

- Assistant message updates
- Tool calls
- Tool completion
- Planning progress where available
- Usage updates
- Interruption and completion

ACP should improve observability compared with headless Vibe's completed-message stream.

Preserve event ordering and avoid duplicating messages when restoring a session.

### 3.4. Model and reasoning selection

Query the ACP model/configuration capabilities.

Allow the model setting to be selected when creating an agent session.

If the model advertises thinking levels, expose only supported values through subagent-mcp's capability discovery.

Do not globally assume that all Vibe models accept `low`, `medium`, or `high`.

Reject unsupported levels before launching a turn.

### 3.5. Session lifecycle

Implement a durable ACP session lifecycle:

- Initialize the transport.
- Create a session in the requested working directory.
- Record its native ID.
- Submit prompts.
- Receive notifications.
- Handle approval requests.
- Cancel when required.
- Load the same session following a restart.

A disconnected ACP process should not imply that its previous work completed successfully.

After reconnect, reconcile session state before accepting another turn.

### 3.6. Shared Vibe facade

Avoid permanently maintaining two unrelated Vibe adapters.

Provide a transport-selecting facade:

`VibeAdapter → CLI transport | ACP transport`

The facade implements the existing `BackendAdapter` interface.

The underlying transport implements the same normalized session, event, and cancellation contracts.

Shared code should include model validation, output normalization, session persistence, usage mapping, timeout semantics, and error handling wherever appropriate.

### 3.7. Tests

Create:

- `test/vibe-acp-fixture.mjs`
- `test/vibe-acp-adapter.test.ts`
- `test/vibe-acp-permissions.test.ts`

Test:

- ACP handshake and capability negotiation
- Creation and load of sessions
- Prompt and completion
- Progress notifications
- Approval request/response
- Session-wide approval
- Denial
- Approval cancellation
- Mid-turn interruption
- Transport crash
- Restart and restore
- Unsupported model selection
- Unsupported reasoning level
- Multiple concurrent sessions
- CLI/ACP coexistence
- Worktree and filesystem access boundaries
- Schema-validated results

### Milestone 3 acceptance criteria

A Vibe agent can request an operation that requires approval, have that request surface through subagent-mcp, receive a user's decision, and continue correctly.

Its conversation remains resumable across local MCP and host restarts.

**Deliverable:** A full-featured Vibe integration with interactive approvals and richer native agent observability.

---

## Optional Milestone 4 — Vibe multi-run optimization

Mistral also maintains experimental `vibe run-server` support.

This provides concurrent runs through a shared process and a JSON-RPC interface, potentially reducing process-startup and resource overhead.

However, the documented implementation requires an agent socket that supplies a sandbox, and is currently experimental.

Do not make this a dependency of the first three milestones.

Investigate it only after stable Vibe execution and ACP support are established.

### Evaluation work

- Measure CLI per-turn startup overhead.
- Compare warm ACP sessions.
- Measure run-server throughput.
- Test shared-process failure isolation.
- Verify native cancellation and cleanup.
- Assess sandbox provisioning requirements.
- Measure memory use at increasing agent counts.
- Ensure model and session accounting remains correct.
- Confirm that host restarts do not duplicate work.

If successful, add `run-server` as another optional Vibe transport, feature-gated and disabled by default.

**Acceptance criterion:** Demonstrated performance improvement under representative parallel workloads, with no regression in safety or recovery.

---

## Recommended PR sequence

| PR | Scope | Dependency |
|---|---|---|
| 1 | Core types, model roster, capabilities, and test foundation | None |
| 2 | Vibe CLI process execution and argument builder | PR 1 |
| 3 | Session store, output parser, resume, cancellation | PR 2 |
| 4 | Host integration, usage, docs, CLI acceptance tests | PR 3 |
| 5 | Native Mistral OpenCode provider documentation and discovery | Independent of PRs 2–4 |
| 6 | Endpoint generator modernization and provider-aware limits | PR 5 |
| 7 | ACP transport and session management | PR 4 |
| 8 | ACP approval bridge, event handling, recovery | PR 7 |
| 9 | Optional experimental multi-run evaluation | PR 8 |

Each PR should be independently reviewable and leave the existing five backends functional.

## Cross-milestone quality gates

All three primary milestones must satisfy these requirements.

**Compatibility:** Existing MCP tools, persisted records, and model configurations continue functioning.

**Isolation:** Worktree semantics remain intact. No transport is falsely advertised as sandboxed.

**Cancellation:** Every active turn can be interrupted. Child processes and subprocess groups are cleaned up.

**Recovery:** Interrupted or crashed work is never silently reported as successful.

**Authorization:** No permission request is silently approved. Unsupported permission restrictions fail closed.

**Observability:** Agents produce normalized progress, terminal status, model identity, and usage information whenever the provider exposes it.

**Accounting:** Token usage is not double-counted on resume. Estimated costs are not presented as authoritative bills.

**Configuration:** Unknown models, unsupported effort settings, incompatible transport settings, and invalid configuration edits are rejected explicitly.

**Regression:** Existing Claude, Codex, OpenCode, Antigravity, and Cursor adapter test suites remain green.

## Final architecture

The supervisor continues to own agent lifecycle, concurrency, dependencies, worktrees, and result persistence.

Vibe adds a provider-specific implementation behind the existing adapter interface.

Mistral API models continue through OpenCode.

ACP upgrades Vibe's native capabilities without requiring changes to the public MCP orchestration workflow.

This makes Vibe a normal participant in a future ensemble manager: an ensemble can choose a Vibe subscription agent, a Mistral API model, or any other configured backend without knowing their execution protocols.

## Reference sources

- [subagent-mcp source](https://github.com/BlueMonkey262/subagent-mcp)
- [Mistral Vibe programmatic-mode specification](https://github.com/mistralai/mistral-vibe/blob/main/docs/programmatic-mode.md)
- [Mistral Vibe ACP integration](https://github.com/mistralai/mistral-vibe/tree/main/vibe/acp)
- [Mistral CLI documentation](https://docs.mistral.ai/vibe/code/cli/work-with-cli)
- [Mistral permission behavior](https://docs.mistral.ai/vibe/code/safety-approvals-permissions)
- [OpenCode provider documentation](https://opencode.ai/docs/providers)
- [Mistral API rate limits](https://docs.mistral.ai/admin/billing-usage/usage-limits)