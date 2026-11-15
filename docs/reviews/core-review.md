# Adversarial core review

Re-reviewed after the core owner’s compile and protected-path fixes. This report covers the current core library only: every current `src/**/*.ts`, `test/**/*.ts`, `package.json`, and `tsconfig.json`, checked against the full brief and `docs/acceptance.md`.

The MCP transport, supervisor/tool handlers, real backend adapters, routing curation, and final public-output assembly are intentionally later-phase work. Their absence is not counted as a core defect here. Findings below are load-bearing issues in the existing contracts and components that should be fixed before those layers depend on them.

## Findings

### CR-01 — Critical — Ambiguous shell effects still fail open under an `allow` default

**Locations:** `src/approval/policy.ts:68-95,170-194`; `test/policy.test.ts:30-41`

The heuristic recognizes only a narrow command vocabulary and only checks absolute paths extracted from write-like shell commands. Current examples `rm -r -f target`, `echo x > ../outside`, `cp x ../outside`, and `gh api ...` all return no danger. With `permission.default: allow`, they are approved even though P2-02 requires recursive forced deletion, outside-cwd writes, network egress, and unsafe parse ambiguity to escalate. Lexical `resolve()` also cannot detect a symlink inside cwd that resolves outside it.

**Suggested fix:** conservatively parse commands into compounds/argv/redirections. Escalate any write/network-capable command whose effects cannot be completely classified, recognize separated and mixed destructive flags plus shell wrappers, canonicalize relative targets, and use `realpath` on existing ancestors to detect symlink escapes. Add the full adversarial P2-02 corpus under all three permission defaults.

### CR-02 — High — Static glob matching over-grants because `*` and `**` are identical

**Locations:** `src/approval/policy.ts:102-138`; `test/policy.test.ts:24-28`

Both `*` and `**` compile to `.*`, so `Write(src/*)` matches `src/deep/secret.ts`. The configuration format calls these values globs and uses `**` explicitly for recursive matching; treating a single star as recursive silently broadens allow rules. Because static allow runs before heuristics, an overmatch can bypass mandatory escalation checks.

**Suggested fix:** define and document one glob dialect, make `*` exclude path separators while `**` crosses them for path candidates, and keep command matching semantics separate if commands intentionally use flat-string wildcards. Reject malformed patterns at config load and test separator, argument-boundary, escaping, and allow/deny conflict cases.

### CR-03 — High — The approval watchdog is disabled while a backend resolution is in flight

**Locations:** `src/approval/coordinator.ts:111-149`

`resolve()` clears the timer before awaiting `adapter.approve()`. If that promise hangs—one of the documented Codex/OpenCode failure modes—the request stays `resolving` forever and the MCP caller and child remain parked. This misses P2-06’s required “timeout while resolving” coverage.

**Suggested fix:** preserve a single absolute deadline across `pending` and `resolving`, race the backend reply against it, and reconcile late replies without issuing a second decision. Expiry must release the public waiter and produce exactly one stable terminal state.

### CR-04 — High — Watchdog expiry becomes terminal before the deny is acknowledged

**Locations:** `src/approval/coordinator.ts:182-200`

`#expire()` sets `expired` before sending the deny. If the adapter rejects, the state remains terminal, cannot be retried through the coordinator, and the backend tool may still be parked; only an optional callback reports the discrepancy. P2-06/P4-07 require successful reply or authoritative reconciliation before considering a permission resolved.

**Suggested fix:** add an `expiring` transition, send a bounded deny, then interrupt/reconcile on failure. Publish `expired` only once the child is known unblocked, or publish a distinct backend-lost terminal state that drives cleanup.

### CR-05 — High — Approval replies are not idempotent and concurrent auto-routing can reply twice

**Locations:** `src/approval/coordinator.ts:69-90,93-107,111-117,170-179`; `test/approval-coordinator.test.ts:62-68`

P2-04 requires a duplicate identical resolution to return the stored result without a second wire reply. The current test instead codifies rejection after resolution. In addition, the auto-allow/deny path does not reserve the request ID before awaiting `adapter.approve()`, so two concurrent `route()` calls can both reply; duplicate detection exists only in `park()`.

**Suggested fix:** reserve every request ID before any async action, serialize transitions per ID, retain the chosen decision/result, return it for identical replays, and reject only contradictory replays. Add delayed-adapter tests for concurrent route/resolve/expiry/interrupt races.

### CR-06 — High — Approval records and synthetic session state are unbounded

**Locations:** `src/approval/coordinator.ts:44-45,83-90,137-148,152-168,182-200`

Resolved, cancelled, and expired entries are never evicted. `clearSession()` removes only fingerprints and provides no way to cancel all pending approvals/timers for an interrupted or lost agent. A long-lived server therefore grows with every permission request and can leave orphaned parked requests, contrary to P2-06 and P5-06.

**Suggested fix:** index approvals by agent, add an agent teardown operation that fails closed and clears timers/session rules, and bound terminal tombstones with TTL/LRU while retaining enough state for late-reply idempotency.

### CR-07 — High — Global event sequences produce false per-agent retention gaps

**Locations:** `src/events/buffer.ts:14-18,26-50`; `test/fake-buffer.test.ts:47-55`

The sequence counter is global but retention and reads are per agent. If agent A emits three events and agent B then emits its first event at sequence 4, `read("b", 0)` reports `truncatedBefore: 4`, falsely claiming B lost three events. P5-02 requires truthful per-agent cursor/gap semantics.

**Suggested fix:** maintain per-agent sequence/high-water/retention bounds, or expose a genuinely global log rather than per-agent arrays. Add interleaved-agent tests proving gaps appear only after that agent’s own events are evicted.

### CR-08 — High — Future cursors can wait forever and subscriptions leak abort listeners

**Locations:** `src/events/buffer.ts:40-65,73-101`

Any safe future cursor is accepted and returned unchanged; `subscribe()` can then wait indefinitely for a sequence that may never exist. P5-02 explicitly requires defined invalid/future-cursor behavior. Also, each wait adds an abort listener that is removed only if abort fires, not when an event wakes the waiter, so a long-lived subscription accumulates listeners and memory.

**Suggested fix:** validate cursors against the agent high-water mark and return a documented resync/error for future values. Retain the abort callback in the waiter and remove it on every wake path. Add repeated wake, abort, clear, rollover, and soak tests.

### CR-09 — High — The event/adapter contract cannot safely separate resumed or overlapping turns

**Locations:** `src/events/schema.ts:4-30`; `src/adapters/adapter.ts:17-30,41-48`

Message, tool, approval, and error events do not consistently carry `turnId`; deltas also lack stable message/content identifiers. Since streams are keyed only by agent, a late previous-turn event can be mixed into a resumed turn, and the core cannot express stable deduplication keys needed for Codex interleaving or OpenCode replay reconciliation. `ResumeRequest` also accepts caller-supplied `cwd` and `model`, leaving identity preservation as an external convention rather than an adapter invariant (P6-01/P6-03).

**Suggested fix:** require turn correlation on every turn-scoped event and stable backend-neutral entity IDs/revisions where replay is possible. Keep immutable backend/model/cwd/session identity in adapter-owned state; either remove those fields from resume or require explicit mismatch rejection. Define one-active-turn serialization in the contract.

### CR-10 — High — The fake adapter masks exactly the races the shared contract must prove

**Locations:** `src/adapters/fake.ts:18-28,40-77,93-119`; `test/fake-buffer.test.ts:14-55`

Repeated `interrupt()` emits duplicate terminal events. Resume clears one shared `interrupted` flag, so a delayed script from the previous turn can resume emitting after a new turn begins. Approval completion aliases `requestId` to `toolCallId`, hiding the required distinction between transport, permission, turn, and tool/item IDs. The fake does not expose received requests for mapping assertions, and the contract tests emit only three of the seven normalized event types required by P1-01.

**Suggested fix:** make the fake a strict per-agent/per-turn state machine, enforce one active turn and one terminal event, keep IDs distinct, capture requests, and convert script failures into normalized error/terminal events. Drive every adapter operation and all seven event types in a shared contract suite.

### CR-11 — High — Config loading lacks scope precedence and silently accepts policy/schema mistakes

**Locations:** `src/config/registry.ts:18-21,29-41,85-107,109-142,180-197,238-253`

The registry accepts only one agent directory, so it cannot merge user/project scopes or implement the P1-02 duplicate-name precedence rule. Unknown frontmatter/roster keys are ignored, malformed permission patterns are retained as ineffective strings, and default-model-like keys can sit unnoticed in the roster. `systemPrompt: body.trim()` also changes the authored prompt rather than preserving the body.

**Suggested fix:** load ordered user/project scopes with explicit precedence; reject unknown keys recursively, including any model-default aliases; compile permission patterns during load; and preserve the prompt body according to a documented delimiter-newline rule. Expand tests to the full P1-02/P1-03 matrix, including model environment variables proving no fallback.

### CR-12 — High — Config env can reset the protected recursion-depth variable

**Locations:** `src/config/registry.ts:128-140,238-245`; `src/adapters/adapter.ts:10-14`; `src/core/limits.ts:24-32`

Agent `env` accepts `SUBAGENT_MCP_DEPTH`, while `SpawnRequest.env` is undifferentiated and the adapter contract does not require the server-computed depth to win merge order. A nested config can therefore reset depth and evade the cap once the supervisor composes these values.

**Suggested fix:** reserve/reject bridge-owned env names in config, compute depth before adapter invocation, and pass it as protected metadata or merge it after every user/config source. Test override attempts and rejection before process creation at depths 0–3.

### CR-13 — High — JSONL crash recovery and multi-writer behavior do not meet the storage contract

**Locations:** `src/storage/jsonl.ts:9-24,27-49`; `src/storage/routing.ts:82-106`

Writes are serialized only per store instance/process. Independent store instances (for example, the server and advisory hook) have no coordination, and a crash-truncated final line makes `readAll()` reject the entire file, hiding all prior valid records. This conflicts with P7-01/P7-02’s append concurrency and partial-tail recovery requirements. `readAll()` also scales memory with the complete lifetime log.

**Suggested fix:** use a single writer/lock or verified safe framing strategy, tolerate/report only a malformed final crash tail without rewriting valid history, fail distinctly on interior corruption, and stream reads. Test independent instances/processes, long records, and injected partial tails.

### CR-14 — Medium — Routing storage does not enforce referential or scope integrity at runtime

**Locations:** `src/storage/routing.ts:20-65,82-106,124-136`

Runtime validation covers only model strings, prompt length, and score. Duplicate delegation/outcome records, outcomes referencing no delegation or another scope, and records whose declared scope disagrees with the store path are accepted. `pendingOutcomeIds()` is unbounded. Later MCP input validation can check shapes, but idempotency and linkage belong in the storage boundary to remain true for hooks/jobs too.

**Suggested fix:** bind each store to a scope, validate every record variant, enforce unique delegation IDs and idempotent outcomes with explicit conflict behavior, validate references, and expose a bounded recent-pending query for result reminders.

### CR-15 — Medium — Output scanner coverage is too narrow for the acceptance corpus

**Locations:** `src/safety/output.ts:1-14`; `test/limits-safety.test.ts:25-32`

The helper handles exact hyphenated tags and ASCII role prefixes, but the test suite does not cover split/chunk assembly, whitespace/case variants, mixed Unicode lookalikes, ordinary prose, or full idempotency as required by P7-06. Wiring the scanner into every public/storage boundary is correctly later-phase supervisor work; the immediate core issue is that the primitive’s accepted grammar is not specified or adversarially proven.

**Suggested fix:** define the exact control-looking grammar to neutralize, add a table-driven adversarial corpus and idempotency/property tests, and expose an assembly-boundary API so later layers cannot accidentally scan chunks independently or omit buffered terminal text.

## Verification and scope notes

- `npm run check`: **PASS**.
- `npm test`: **PASS**, 6/6 test files. The test command rebuilt `dist` before running.
- Review runtime: Node `v20.20.2`, below the acceptance baseline of Node `>=22`; this is diagnostic evidence, not release sign-off.
- The earlier type errors and relative `.git`/`.claude` protected-path bug are resolved and removed from the findings.
- No direct default-model constant or parent/model environment fallback was found in the current core. End-to-end proof still belongs to the later MCP/supervisor and real-adapter tests.
- Intentionally later-phase omissions—not counted above—are the nine MCP tool registrations, blocking/background supervisor, real Claude/Codex/OpenCode adapters, public progress throttling, output-sanitization wiring, routing digest/curation, and orchestrator package.
