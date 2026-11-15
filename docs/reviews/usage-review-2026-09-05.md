# subagent-mcp — findings from use

Server lives at `/home/eli/Projects/subagent-mcp` (Node/TypeScript, registered
in `~/.claude.json`, not in this repo). This is a **usage** review, written
2026-09-05 after driving it hard for a full night — spawning codex agents,
parking on approvals, and recovering when it went sideways. It is not a code
review; nobody has read the server source yet.

Ordered by how much time each one cost.

## 1. `resolve_approval` with `deny` kills the child

Denying does **not** relay the `message` to the agent as a correction. The codex
child reads it as a hard stop: it reports the permission was declined, leaves
its work uncommitted in the tree, and exits `completed`.

Observed on `agent-loop-split`. A deny carrying two specific defects to fix
produced a stop, not a fix. Recovery is `send_message` to the same name, which
preserves history — but the run is already dead by then, and if you were not
watching you would conclude the agent had finished.

**Suggested:** either relay `message` into the child's context and let it
continue, or rename the decision so it does not read as "here is feedback".
Today the safest pattern is `allow` plus a follow-up `send_message`, which means
committing something you did not want committed.

## 2. `allow_for_session` does not persist

Approving with `allow_for_session` still re-prompted on the very next commit in
the same agent, same session. Either the scope is narrower than the name
suggests, or it is not being recorded. As it stands there is no way to say "stop
asking me about `git add`", which is most of what a long refactor asks for.

## 3. `get_agent_events` is effectively unusable on a real run

It returned **1.4 MB / 34,034 lines** for one agent. There is no way to ask for
the tail: `since` is a sequence number, and nothing reports the *current*
sequence number, so finding the end means bisecting by trial and error —
`since: 100000` returns empty with `nextSequence` echoing your own input, while
`since: 400` overflows the token limit.

The harness does save oversized results to a file, which makes it survivable
(grep that file rather than reading it), but the tool cannot be used as
documented.

**Suggested:** a `limit`/`tail` parameter, and return the current max sequence
in every response — including empty ones — so a caller can seek to the end in
one call.

## 4. A pending approval's details are only in that 1.4 MB blob

`list_agents` says `needs_approval` but not *what* is being approved. Getting the
command, the cwd and the reason means calling `get_agent_events` and grepping
for `requestedAt`. The approval payload is small and structured; it should come
back from `list_agents`, or from a dedicated call.

## 5. A busy agent cannot be messaged

`send_message` to a running agent fails with "already has an active turn". There
is no queue. In practice this means you cannot warn an agent about something
that changed underneath it — I landed two commits in files an agent's brief
covered and simply could not tell it until it finished.

**Suggested:** queue the message for delivery at the next turn boundary. Even a
best-effort "will be delivered when the current turn ends" would be better than
a hard error.

## What works well, and is worth not regressing

- **The approval channel itself is the reason to use this over raw `codex
  exec`.** A child that hits a command outside its allowlist parks and asks,
  rather than failing silently or working around it. That is a real
  improvement, and it is what makes unattended dispatch safe enough to do.
- `run_in_background` plus `list_agents` polling is a sound shape; state
  transitions were accurate every time.
- `send_message` resuming a *completed* agent with full history intact is
  genuinely useful and got me out of finding #1 twice.

## Not yet examined

Nobody has read the server source. Worth a real review at some point:
concurrency around the approval store, whether `agent_id` is guessable or
authenticated, what happens to a child if the server dies mid-turn, and whether
child stdout is bounded anywhere before it reaches that 1.4 MB event log.
