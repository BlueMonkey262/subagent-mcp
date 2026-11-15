import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Ajv } from 'ajv';
import type { Backend } from './core/types.js';
import type { PermissionConfig } from './config/schema.js';
const exec = promisify(execFile);
export const validator = new Ajv({ allErrors: true, strict: true });
export interface Worktree {
  path: string; branch: string; base_commit: string; repository: string;
  /** Snapshot isolation: the commit holding the user's uncommitted changes the worktree started from. */
  snapshot_commit?: string;
}
export async function createWorktree(cwd: string, base?: string): Promise<Worktree> {
  const repository = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
  const base_commit = base ?? (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const id = randomUUID();
  const path = join(dirname(repository), '.subagent-worktrees', id);
  const branch = `subagent/${id}`;
  await mkdir(dirname(path), { recursive: true });
  try { await exec('git', ['worktree', 'add', '-b', branch, path, base_commit], { cwd: repository }); }
  catch (error) { await exec('git', ['branch', '-d', branch], { cwd: repository }).catch(() => {}); throw error; }
  return { path, branch, base_commit, repository };
}
/** Only for resources owned by a spawn that failed before returning a backend receipt. */
export async function discardWorktree(tree: Worktree): Promise<void> {
  await exec('git', ['worktree', 'remove', '--force', tree.path], { cwd: tree.repository });
  await exec('git', ['branch', '-D', tree.branch], { cwd: tree.repository });
}
export async function removeWorktree(tree: Worktree): Promise<void> {
  const dirty = (await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: tree.path })).stdout;
  if (dirty.trim()) throw new Error('Refusing to remove a dirty worktree');
  await exec('git', ['worktree', 'remove', tree.path], { cwd: tree.repository });
  // Keep the branch: it can contain completed work even when the worktree is clean.
}
export function capabilities(backend: Backend) {
  return { effort_values: backend === 'opencode' || backend === 'cursor' || backend === 'vibe' ? [] : backend === 'antigravity' ? ['low','medium','high'] : ['low','medium','high','xhigh','max'],
    effort_alternative: backend === 'cursor' ? 'Select a model ID that includes effort' : backend === 'opencode' ? 'Use a provider/model variant; no verified effort mapping is available'
      : backend === 'vibe' ? 'Select a Vibe model alias whose config.toml entry sets the thinking level' : null,
    permission_restrictions: backend === 'claude', structured_output: 'validated_json', filesystem_boundary_enforced: false, usage: 'when_reported' };
}
export function restrictPermission(base: PermissionConfig, restriction?: PermissionConfig): PermissionConfig {
  if (!restriction) return base;
  if (restriction.mode !== undefined && restriction.mode !== 'manual') throw new Error('Spawn permission mode must be manual');
  const rank = { allow: 0, escalate: 1, deny: 2 };
  if (rank[restriction.default] < rank[base.default] || restriction.allow.some(rule => !base.allow.includes(rule))) throw new Error('Spawn permissions may only narrow configuration');
  return { allow: base.allow.filter(rule => restriction.allow.includes(rule)), deny: [...new Set([...base.deny, ...restriction.deny])], default: restriction.default, mode: 'manual' };
}

/** Intersection on resume: newly tightened config cannot be widened by a saved override. */
export function intersectPermission(base: PermissionConfig, saved?: PermissionConfig): PermissionConfig {
  if (!saved) return base;
  const rank = { allow: 0, escalate: 1, deny: 2 };
  return { allow: base.allow.filter(rule => saved.allow.includes(rule)), deny: [...new Set([...base.deny, ...saved.deny])],
    default: rank[base.default] >= rank[saved.default] ? base.default : saved.default, mode: 'manual' };
}

export async function setupWorktree(tree: Worktree, commands: readonly string[]): Promise<void> {
  for (const command of commands) await exec('/bin/sh', ['-c', command], { cwd: tree.path, timeout: 300_000, maxBuffer: 1024 * 1024 });
}

/** A commit holding the working tree as it is now (tracked changes and non-ignored new files), on top of HEAD. */
export interface WorkingTreeSnapshot {
  readonly commit: string; readonly base: string; readonly dirty: boolean;
  /** The repository has submodules: their contents are not captured and snapshot worktrees leave them empty. */
  readonly submodules?: boolean;
}

/**
 * Captures the working tree without touching the user's index, HEAD or files: `git add -A` runs
 * against a throwaway copy of the index, and the resulting tree becomes a parentless-to-the-user
 * commit object on top of HEAD that only the snapshot worktrees reference.
 */
export async function snapshotWorkingTree(cwd: string): Promise<WorkingTreeSnapshot> {
  const repository = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
  const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  const index = join(tmpdir(), `subagent-snapshot-${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    // Starting from a copy of the real index keeps its stat cache, so unchanged files are not rehashed.
    try {
      const realIndex = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: repository })).stdout.trim();
      await copyFile(realIndex, index);
    } catch { await exec('git', ['read-tree', 'HEAD'], { cwd: repository, env }); }
    await exec('git', ['add', '-A', '--', '.'], { cwd: repository, env, maxBuffer: 16 * 1024 * 1024 });
    const tree = (await exec('git', ['write-tree'], { cwd: repository, env })).stdout.trim();
    const headTree = (await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository })).stdout.trim();
    const submodules = await access(join(repository, '.gitmodules')).then(() => true, () => false);
    const extra = submodules ? { submodules: true } : {};
    if (tree === headTree) return { commit: base, base, dirty: false, ...extra };
    const identity = { GIT_AUTHOR_NAME: 'subagent-mcp', GIT_AUTHOR_EMAIL: 'subagent-mcp@localhost', GIT_COMMITTER_NAME: 'subagent-mcp', GIT_COMMITTER_EMAIL: 'subagent-mcp@localhost' };
    const commit = (await exec('git', ['commit-tree', tree, '-p', base, '-m', 'subagent-mcp working tree snapshot'], { cwd: repository, env: { ...process.env, ...identity } })).stdout.trim();
    return { commit, base, dirty: true, ...extra };
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

/**
 * Makes a worktree created at the snapshot's base hold the snapshot's files as uncommitted changes,
 * so `git diff` and `git status` there show what the user had uncommitted.
 */
export async function applySnapshot(tree: Worktree, snapshot: WorkingTreeSnapshot): Promise<void> {
  if (!snapshot.dirty || snapshot.commit === tree.base_commit) return;
  await exec('git', ['checkout', snapshot.commit, '--', '.'], { cwd: tree.path, maxBuffer: 16 * 1024 * 1024 });
  const deleted = (await exec('git', ['diff', '--name-only', '--diff-filter=D', '-z', snapshot.base, snapshot.commit], { cwd: tree.path, maxBuffer: 16 * 1024 * 1024 })).stdout
    .split('\0').filter(Boolean);
  for (const file of deleted) {
    // A deleted file the user replaced with a directory: the checkout above already wrote the snapshot's files under it.
    const target = join(tree.path, file);
    if ((await lstat(target).catch(() => undefined))?.isDirectory()) continue;
    await rm(target, { force: true });
  }
  await exec('git', ['reset', '-q'], { cwd: tree.path });
}

export interface WorktreeDiff {
  readonly path: string;
  readonly branch: string;
  /** What the diff is taken against: the snapshot commit for snapshot worktrees, else the base commit. */
  readonly against: string;
  readonly files: readonly { readonly path: string; readonly added: number | null; readonly deleted: number | null }[];
  readonly insertions: number;
  readonly deletions: number;
  readonly patch: string;
  readonly truncated: boolean;
}

/**
 * Everything the agent changed in its worktree, committed or not, untracked files included, against
 * the commit it started from. A throwaway index stages the whole tree, so the worktree's own index
 * and files are never touched.
 */
export async function diffWorktree(tree: Worktree, maxChars: number): Promise<WorktreeDiff> {
  const against = tree.snapshot_commit ?? tree.base_commit;
  const index = join(tmpdir(), `subagent-diff-${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const big = 64 * 1024 * 1024;
  try {
    await exec('git', ['read-tree', 'HEAD'], { cwd: tree.path, env });
    await exec('git', ['add', '-A', '--', '.'], { cwd: tree.path, env, maxBuffer: big });
    const numstat = (await exec('git', ['diff', '--cached', '--numstat', '-z', '--no-renames', against], { cwd: tree.path, env, maxBuffer: big })).stdout;
    const files = numstat.split('\0').filter(Boolean).map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
    });
    const full = (await exec('git', ['diff', '--cached', '--no-color', '--no-renames', against], { cwd: tree.path, env, maxBuffer: big })).stdout;
    const truncated = full.length > maxChars;
    // Cut at a line end so the patch stays parseable up to its last whole hunk line.
    const cut = truncated ? full.slice(0, Math.max(0, full.lastIndexOf('\n', maxChars) + 1)) : full;
    return {
      path: tree.path, branch: tree.branch, against, files,
      insertions: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
      patch: cut, truncated,
    };
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}
