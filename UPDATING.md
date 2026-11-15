# Updating subagent-mcp

The procedure Claude follows when the panel's `u` key submits its update prompt, or when someone asks
Claude to "update subagent-mcp". A person can follow it by hand too. `<repo>` is the install checkout
(the directory `bin/subagent-mcp` is linked from).

Two rules hold throughout:

- **Never rebuild `<repo>` while a session is using it.** A rebuild mid-session has dropped the host
  connection before. All building and testing happens in a separate worktree first; the swap is last.
- **Nothing is discarded.** Never run
  `git reset --hard`, `git checkout -- .` or `git clean` here. Nothing updates without the person's yes.

## 1. Preflight

1. Read `<project>/.subagents/memory/update.json` (or call `list_models`, which reports update status).
   Note `latest` and the running version in `<repo>/package.json`. If `latest` is not newer, stop.
2. Read the release notes: `https://github.com/BlueMonkey262/subagent-mcp/releases/tag/v<latest>`.
   Show the person the version change and the notes.
3. `git -C <repo> status --short`. Local edits are normal (for example `.subagents/models.yaml`), so they are
   not a blocker by themselves. Find the overlap with the release:
   `git -C <repo> diff --name-only HEAD v<latest>` against the modified tracked files. No overlap: the
   checkout in step 4 carries the edits over untouched. An overlap (the release changes a file the person
   edited): stop, show both diffs, and ask how to merge; never overwrite the person's version. Untracked
   files are left alone.
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

- *2026-11-14, `.subagents/` and `.agents/` are no longer tracked.* The repo now ships only templates
  (`.subagents/<name>.md.example`, `.subagents/models.yaml.example`,
  `.agents/agents/<name>.md.example`), and the rest of `.subagents/` and `.agents/` is gitignored. This
  release deletes the tracked files those templates replace, so the `merge --ff-only` in step 4 refuses
  while any of them has local edits: `git -C <repo> status --short` lists them as modified. For each one,
  move it aside first (`mv <file> <file>.mine`), run the merge, then move it back (`mv <file>.mine
  <file>`). From then on they are ignored files that no update touches. If an unedited tracked
  `models.yaml` is removed, copy the example and keep the models you have:
  `cp .subagents/models.yaml.example .subagents/models.yaml`, then edit it. There is no live roster
  fallback: with no `models.yaml` the server starts with an empty roster, and `list_models` /
  `spawn_agent` report the paths checked and that same instruction. Agent configs without a real
  `<name>.md` still fall back to the bundled `<name>.md.example`.
  `.agents/agents/subagent-general.md` moved the same way, to `subagent-general.md.example`. The server
  copies the template into place without the `.example` suffix before launching `agy` when the real file
  is missing, and never overwrites an existing file; no manual copy is needed.

## 4. Swap (the one step that touches the live install)

Only after step 2 passed and the person confirmed. Claude runs this itself, last. On a branch (normally
`main`), move the branch forward to the release; never leave the install on a detached HEAD:

```sh
git -C <repo> merge --ff-only v<latest>   # on a branch; carries the person's local edits along
cd <repo> && npm ci && npm run build
```

If the merge refuses (the branch has commits of its own, or edits clash), stop and ask. Only when
`<repo>` is already on a detached HEAD at a tag, use `git -C <repo> checkout v<latest>`.

Then call `restart_host` so the session picks up the new code. If the connection drops anyway, say so;
`/mcp` reconnects. If a step fails after the merge, go back with `git -C <repo> reset --keep <previous
commit>` (never `--hard`) and rebuild.

## 5. After restart

- `list_models` should answer and report the new version.
- Run `/subagent-mcp`, then `i`, to review roster changes the release made.
- Remove the update worktree from step 2.
