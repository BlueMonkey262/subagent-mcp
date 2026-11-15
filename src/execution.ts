import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, copyFile, lstat, mkdir, readlink, rm } from 'node:fs/promises';
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
  /** Set when part of the worktree can't be diffed (a sparse checkout). */
  readonly warning?: string;
}

/**
 * Everything the agent changed in its worktree, committed or not, untracked files included, against
 * the commit it started from. A throwaway index stages the whole tree, so the worktree's own index
 * and files are never touched.
 *
 * The agent can't hide a change from it: assume-unchanged and skip-worktree flags copied from its
 * index are cleared, and untracked files are filtered by the tree's .gitignore files only, never by
 * the shared repository's info/exclude or core.excludesFile, which sit outside the worktree. A new
 * .gitignore is always included, so a rule that hides files (or itself) shows up in the diff.
 *
 * Nothing the agent configured runs here: files are hashed with `hash-object --no-filters` and
 * written to the index directly instead of through `git add`, so no clean or process filter runs
 * (the worktree's config and attributes are the agent's to edit), and the diff is taken with
 * --no-textconv --no-ext-diff and fsmonitor off. Content is staged byte for byte, without eol or
 * other attribute conversions.
 */
export async function diffWorktree(tree: Worktree, maxChars: number): Promise<WorktreeDiff> {
  const against = tree.snapshot_commit ?? tree.base_commit;
  const index = join(tmpdir(), `subagent-diff-${randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const big = 64 * 1024 * 1024;
  try {
    // Start from a copy of the worktree's own index: it keeps files the agent force-added past
    // .gitignore (and the stat cache); HEAD is the fallback when there is no index yet.
    try {
      const realIndex = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: tree.path })).stdout.trim();
      await copyFile(realIndex, index);
    } catch { await exec('git', ['read-tree', 'HEAD'], { cwd: tree.path, env }); }
    const safe = await inertGitConfig(tree.path);
    const git = (args: readonly string[]) => exec('git', [...safe, ...args], { cwd: tree.path, env, maxBuffer: big });
    const sparse = (await git(['config', '--bool', 'core.sparseCheckout']).catch(() => ({ stdout: '' }))).stdout.trim() === 'true';
    await clearIndexFlags(tree.path, env, big, sparse, safe);
    const list = async (args: readonly string[]) => (await git(args)).stdout.split('\0').filter(Boolean);
    // Tracked files whose stat differs from the index (deletions included); ignore rules never apply to them.
    const changed = await list(['diff-files', '-z', '--name-only', '--', '.']);
    const untracked = await list(['ls-files', '-z', '--others', '--exclude-per-directory=.gitignore', '--', '.']);
    const ignoreFiles = await list(['ls-files', '-z', '--others', '--', ':(glob)**/.gitignore']);
    await stageRaw(tree.path, env, safe, [...new Set([...changed, ...untracked, ...ignoreFiles])]);
    const diffArgs = ['diff', '--cached', '--no-renames', '--no-textconv', '--no-ext-diff'];
    const numstat = (await git([...diffArgs, '--numstat', '-z', against])).stdout;
    const files = numstat.split('\0').filter(Boolean).map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
    });
    // Read no more of the patch than the cap needs, so a huge diff is cut instead of failing.
    const { text, more } = await readCapped('git', [...safe, ...diffArgs, '--no-color', against], { cwd: tree.path, env }, maxChars + 1);
    const truncated = more || text.length > maxChars;
    // Cut at a line end so the patch stays parseable up to its last whole hunk line.
    const lineEnd = text.lastIndexOf('\n', maxChars - 1);
    // A first line longer than the cap has no line end to cut at: keep the cap's worth of it instead of nothing.
    const cut = !truncated ? text : lineEnd >= 0 ? text.slice(0, lineEnd + 1) : text.slice(0, maxChars);
    return {
      path: tree.path, branch: tree.branch, against, files,
      insertions: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
      patch: cut, truncated,
      ...(sparse ? { warning: 'Sparse checkout is on: files outside the sparse set are not diffed.' } : {}),
    };
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

/** Clears assume-unchanged (and, outside a sparse checkout, skip-worktree) on the throwaway index. */
async function clearIndexFlags(cwd: string, env: NodeJS.ProcessEnv, maxBuffer: number, sparse: boolean, safe: readonly string[]): Promise<void> {
  const listed = (await exec('git', [...safe, 'ls-files', '-z', '-v'], { cwd, env, maxBuffer })).stdout.split('\0').filter(Boolean);
  // `-v` tags assume-unchanged entries with a lowercase letter and skip-worktree ones with S (s: both).
  const tagged = listed.map((entry) => ({ tag: entry[0] ?? 'H', path: entry.slice(2) }));
  const assumed = tagged.filter(({ tag }) => tag !== tag.toUpperCase()).map(({ path }) => path);
  const skipped = sparse ? [] : tagged.filter(({ tag }) => tag.toUpperCase() === 'S').map(({ path }) => path);
  // One flag per call: update-index applies only the last of several mark options.
  for (const [flag, paths] of [['--no-assume-unchanged', assumed], ['--no-skip-worktree', skipped]] as const) {
    for (let start = 0; start < paths.length; start += 500) {
      await exec('git', [...safe, 'update-index', flag, '--', ...paths.slice(start, start + 500)], { cwd, env, maxBuffer });
    }
  }
}

/**
 * `-c` options that keep git from running anything the worktree's config names while it diffs:
 * fsmonitor off, and every filter driver defined anywhere in its config emptied. Staging never
 * filters anyway (stageRaw); this covers the content check `diff-files` makes on racily clean entries.
 */
async function inertGitConfig(cwd: string): Promise<string[]> {
  const names = (await exec('git', ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], { cwd }).catch(() => ({ stdout: '' }))).stdout
    .split('\0').filter(Boolean);
  const drivers = new Set(names.map((name) => name.slice('filter.'.length, name.lastIndexOf('.'))).filter((driver) => driver !== ''));
  const args = ['-c', 'core.fsmonitor=false'];
  for (const driver of drivers) {
    for (const key of ['clean', 'smudge', 'process']) args.push('-c', `filter.${driver}.${key}=`);
    args.push('-c', `filter.${driver}.required=false`);
  }
  return args;
}

/**
 * Stage `paths` into the throwaway index as their raw bytes: hash-object --no-filters, then
 * update-index --index-info. A missing path is removed; a symlink is stored as a link; a directory
 * (a nested repository, or a file replaced by one) keeps whatever the index has.
 */
async function stageRaw(cwd: string, env: NodeJS.ProcessEnv, safe: readonly string[], paths: readonly string[]): Promise<void> {
  const records: string[] = [];
  const files: { readonly path: string; readonly mode: string }[] = [];
  for (const path of paths) {
    const full = join(cwd, path);
    const stat = await lstat(full).catch(() => undefined);
    if (stat === undefined) { records.push(`0 ${'0'.repeat(40)}\t${path}`); continue; }
    if (stat.isSymbolicLink()) {
      const sha = (await gitInput(cwd, env, [...safe, 'hash-object', '-w', '--no-filters', '--stdin'], await readlink(full))).trim();
      records.push(`120000 ${sha}\t${path}`);
      continue;
    }
    if (stat.isFile()) files.push({ path, mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644' });
  }
  // --stdin-paths reads one path per line, so a name with a newline is hashed on its own.
  const batch = files.filter((file) => !file.path.includes('\n'));
  const shas = batch.length === 0 ? []
    : (await gitInput(cwd, env, [...safe, 'hash-object', '-w', '--no-filters', '--stdin-paths'], batch.map((file) => file.path).join('\n') + '\n')).trim().split('\n');
  batch.forEach((file, index) => records.push(`${file.mode} ${shas[index]}\t${file.path}`));
  for (const file of files.filter((candidate) => candidate.path.includes('\n'))) {
    const sha = (await exec('git', [...safe, 'hash-object', '-w', '--no-filters', '--', file.path], { cwd, env })).stdout.trim();
    records.push(`${file.mode} ${sha}\t${file.path}`);
  }
  if (records.length > 0) await gitInput(cwd, env, [...safe, 'update-index', '-z', '--index-info'], records.map((record) => `${record}\0`).join(''));
}

/** Runs git with `input` on stdin and returns its stdout. */
function gitInput(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 4_000) stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) ?? ''} exited ${String(code)}: ${stderr.trim()}`)));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** Runs a command and keeps the first `limit` characters of its output, stopping it once it has them. */
function readCapped(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }, limit: number): Promise<{ text: string; more: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let more = false;
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (more) return;
      text += chunk;
      if (text.length > limit) {
        text = text.slice(0, limit);
        more = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 4_000) stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (more || code === 0) resolve({ text, more });
      else reject(new Error(`${command} ${args[0] ?? ''} exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}
