import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Ajv } from 'ajv';
import type { Backend } from './core/types.js';
import type { PermissionConfig } from './config/schema.js';
const exec = promisify(execFile);
export const validator = new Ajv({ allErrors: true, strict: true });
export interface Worktree { path: string; branch: string; base_commit: string; repository: string }
export async function createWorktree(cwd: string): Promise<Worktree> {
  const repository = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
  const base_commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
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
  return { effort_values: backend === 'opencode' || backend === 'cursor' ? [] : backend === 'antigravity' ? ['low','medium','high'] : ['low','medium','high','xhigh','max'],
    effort_alternative: backend === 'cursor' ? 'Select a model ID that includes effort' : backend === 'opencode' ? 'Use a provider/model variant; no verified effort mapping is available' : null,
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
