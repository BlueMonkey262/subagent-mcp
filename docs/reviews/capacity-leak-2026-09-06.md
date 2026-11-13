# Capacity-slot leak — completed background agents never freed their slot

## Symptom

After ~20 delegations the pool wedged: every `spawn_agent` returned
`Concurrent agent limit of 20 reached`, and `stop_agent` on a finished agent
did nothing. Restarting the server was the only recovery.

## Root cause

`Supervisor.#pump()` runs `for await (const event of adapter.events(id, {since}))`.
`adapter.events()` → `EventBuffer.subscribe()`, whose loop is `while (!signal?.aborted)`
— and `#pump` passes **no signal**. The subscription is intentionally long-lived so
a later `sendMessage` resume can push more events onto the same iterator, so the
`for await` loop **never terminates** for an agent that completes normally.

Capacity was released only in the loop's `finally` block. Since the loop never
exits, `record.release()` was never called for any agent whose turn reached
`turn.completed`. Each finished background agent leaked one slot permanently.
(`stop_agent` early-returns for terminal agents, so it couldn't recover a slot
either.)

## Fix (`src/supervisor.ts`)

- Call `record.release()` the moment the agent reaches a terminal state, inside
  `#pump`'s `turn.completed` branch and the fatal-`error` branch — not only in
  the (unreachable) `finally`. `release` is idempotent, so the `finally` stays as
  a harmless backstop and the stream-error path is unchanged.
- `sendMessage()` resuming a terminal agent now re-acquires a slot
  (`record.release = this.#acquireCapacity()`), since a resumed agent is active
  work again; it releases again on the next `turn.completed`. A resume while the
  pool is genuinely full now fails with a `CapacityError` instead of silently
  running uncounted.

## Regression tests (`test/supervisor.test.ts`)

- "a completed background agent frees its capacity slot" — spawns 25 completing
  background agents; fails at #21 without the fix.
- "resuming a completed agent re-counts it against capacity and releases again" —
  25 resume/complete cycles on one agent then a fresh spawn still fits.

Both fail with the fix removed, pass with it in. Full suite: 44/44.
