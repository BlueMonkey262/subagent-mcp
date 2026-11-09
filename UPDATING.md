# Updating subagent-mcp

The procedure Claude follows when the panel's `u` key submits its update prompt, or when someone asks
Claude to "update subagent-mcp". A person can follow it by hand too. `<repo>` is the install checkout
(the directory `bin/subagent-mcp` is linked from).

Two rules hold throughout:

- **Never rebuild `<repo>` while a session is using it.** A rebuild mid-session has dropped the host
  connection before. All building and testing happens in a separate worktree first; the swap is last.
- **Nothing is discarded.** Stop and report if `<repo>` has uncommitted changes. Never run
  `git reset --hard`, `git checkout -- .` or `git clean` here. Nothing updates without the person's yes.

## 1. Preflight

1. Read `<project>/.subagents/memory/update.json` (or call `list_models`, which reports update status).
   Note `latest` and the running version in `<repo>/package.json`. If `latest` is not newer, stop.
2. Read the release notes: `https://github.com/BlueMonkey262/subagent-mcp/releases/tag/v<latest>`.
   Show the person the version change and the notes.
3. `git -C <repo> status --short`. If anything other than untracked files that the release does not
   touch shows up, stop and tell the person. Local edits such as `.subagents/models.yaml` are theirs.
4. `list_agents`. If agents are running, say so: the restart in step 4 ends them. Offer to wait.

## 2. Build and test in a worktree

```sh
git -C <repo> fetch --tags origin
git -C <repo> worktree add ../subagent-mcp-update v<latest>
cd ../subagent-mcp-update
npm ci && npm run build && npm test
```

Report the result. On any failure, stop: the live install is untouched. Remove the worktree with
`git -C <repo> worktree remove ../subagent-mcp-update` when done or abandoned.

## 3. Migration notes

Apply every step the release notes list (config keys added or renamed, behavior changes). Edit the
person's own files only with their yes, show diffs, and keep their comments and hand-written entries.

Releases that change `models.yaml` or agent-config semantics must add a dated note here:

- *(none yet)*

### Moving to launcher-only registration

Older installs registered the server for every Claude Code session:

```sh
claude mcp list            # a user-scope "subagent-mcp" entry means an old install
```

Once the launcher supplies the server itself (see SETUP.md step 3), remove the old entry with
`claude mcp remove -s user subagent-mcp`, with the person's yes. Do this only if the release notes say
the launcher now provides the server; otherwise the entry is still needed.

## 4. Swap (the one step that touches the live install)

Only after step 2 passed and the person confirmed. Claude runs this itself, last:

```sh
git -C <repo> checkout v<latest>
cd <repo> && npm ci && npm run build
```

Then call `restart_host` so the session picks up the new code. If the connection drops anyway, say so;
`/mcp` reconnects. If a step fails after the checkout, return to the previous version:
`git -C <repo> checkout -` and rebuild.

## 5. After restart

- `list_models` should answer and report the new version.
- Run `/subagent-mcp`, then `i`, to review roster changes the release made.
- Remove the update worktree from step 2.
