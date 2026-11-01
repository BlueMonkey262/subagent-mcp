import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Supervisor } from '../src/supervisor.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { AdapterRegistry } from '../src/adapters/adapter.js';
import { ConfigRegistry } from '../src/config/registry.js';
import { createWorktree, discardWorktree, removeWorktree, restrictPermission } from '../src/execution.js';
const exec = promisify(execFile);
function fixture() {
  const adapter = new FakeAdapter('claude');
  const registry = new ConfigRegistry([{ name: 'general', backend: 'claude', model: 'fake', description: 'test', systemPrompt: '', env: {}, sourcePath: '/configs/general.md', permission: { allow: [], deny: [], default: 'escalate' } }], { claude: [{ name: 'fake' }], codex: [], opencode: [], cursor: [], antigravity: [] });
  const supervisor = new Supervisor({ registry, adapters: new AdapterRegistry([adapter]), cwd: '/tmp', maxConcurrent: 3 });
  return { adapter, supervisor, registry };
}
const spawn = { agent: 'general', prompt: 'hello', description: 'test', run_in_background: true };
async function tick() { await new Promise(resolve => setTimeout(resolve, 15)); }

test('waits are event driven, support all/any and timeouts do not cancel', async () => {
  const { supervisor: s, adapter: a } = fixture();
  a.queueScript([]); a.queueScript([]);
  const x = String((await s.spawnAgent(spawn)).agent_id); const y = String((await s.spawnAgent(spawn)).agent_id);
  assert.equal((await s.waitForAgents([x,y], 'all', 0)).timed_out, true);
  const wait = s.waitForAgents([x,y], 'any', 1);
  a.emit(x, 'turn.completed', { turnId: 'one', status: 'completed', finalText: 'done' });
  assert.equal((await wait).timed_out, false);
  assert.equal((await s.waitForAgents([x,y], 'all', 0)).timed_out, true);
  a.emit(y, 'turn.completed', { turnId: 'two', status: 'completed' });
  assert.equal((await s.waitForAgents([x,y], 'all', 1)).timed_out, false);
});

test('config discovery, bounded listing, progress and durable successive structured results', async () => {
  const { supervisor: s, adapter: a } = fixture();
  const path = join(await mkdtemp(join(tmpdir(), 'orchestration-')), 'sessions.json');
  s.enablePersistence(path);
  a.queueScript([]);
  const id = String((await s.spawnAgent({ ...spawn, result_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })).agent_id);
  assert.equal(s.listAgentConfigs().configs[0]?.name, 'general');
  a.emit(id, 'tool.start', { toolCallId: 't', toolName: 'Running tests', input: {} }); await tick();
  assert.equal(s.listAgents()[0]?.current_activity, 'Running tests');
  a.emit(id, 'turn.completed', { turnId: 'first', status: 'completed', finalText: '{"ok":true}', usage: { costUsd: 1 } });
  await s.waitForAgents([id]);
  a.queueScript([]); await s.sendMessage({ agent: id, prompt: 'again', run_in_background: true });
  a.emit(id, 'turn.completed', { turnId: 'second', status: 'completed', finalText: '{"ok":"bad"}', usage: { costUsd: 2 } });
  await s.waitForAgents([id]);
  const result = s.getAgentResult(id) as Record<string, unknown>;
  assert.equal((result.turns as unknown[]).length, 2);
  assert.ok(result.validation_errors);
  assert.equal((result.cumulative_usage as Record<string, unknown>).costUsd, 3);
  assert.equal((await readFile(path + '.results.jsonl', 'utf8')).trim().split('\n').length, 2);
  const restored = fixture().supervisor; restored.restore(s.exportSnapshot());
  assert.equal(((restored.getAgentResult(id) as Record<string, unknown>).turns as unknown[]).length, 2);
  assert.equal((s.sessionView({ limit: 1 }).agents as unknown[]).length, 1);
});

test('dependency success launches, failures block, groups cancel queued work', async () => {
  const { supervisor: s, adapter: a } = fixture();
  a.queueScript([]);
  const id = String((await s.spawnAgent(spawn)).agent_id);
  const task = await s.spawnAgent({ ...spawn, depends_on: [id], group_id: 'batch' });
  assert.equal(a.spawnRequests.length, 1);
  a.queueScript([]);
  a.emit(id, 'turn.completed', { turnId: 'first', status: 'completed', finalText: 'source data' });
  await tick();
  assert.equal(a.spawnRequests.length, 2);
  assert.match(a.spawnRequests[1]!.prompt, /source data/);
  await s.stopAgents(undefined, 'batch');
  const taskResult = s.getAgentResult(String(task.task_id)) as Record<string, unknown>;
  assert.equal(taskResult.status, 'interrupted');
  a.queueScript([]); const bad = String((await s.spawnAgent(spawn)).agent_id);
  const blocked = await s.spawnAgent({ ...spawn, depends_on: [bad] });
  a.emit(bad, 'turn.completed', { turnId: 'failed', status: 'failed' }); await tick();
  assert.equal((s.getAgentResult(String(blocked.task_id)) as { state: string }).state, 'blocked');
});

test('managed worktrees retain branches and refuse dirty cleanup', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'worktree-test-'));
  await exec('git', ['init', repository]);
  await exec('git', ['-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','initial'], { cwd: repository });
  const tree = await createWorktree(repository);
  await writeFile(join(tree.path,'work.txt'), 'keep');
  await assert.rejects(removeWorktree(tree), /dirty/);
  await exec('git', ['add','work.txt'], { cwd: tree.path });
  await exec('git', ['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','work'], { cwd: tree.path });
  await removeWorktree(tree);
  assert.match((await exec('git', ['branch','--list',tree.branch], { cwd: repository })).stdout, /subagent/);
  const failed = await createWorktree(repository);
  await writeFile(join(failed.path, 'setup-output'), 'partial setup');
  await discardWorktree(failed);
  assert.equal((await exec('git', ['branch','--list',failed.branch], { cwd: repository })).stdout.trim(), '');
});

test('permissions cannot widen configuration', () => {
  assert.throws(() => restrictPermission({ allow: [], deny: ['Bash'], default: 'deny' }, { allow: ['Bash'], deny: [], default: 'allow' }), /narrow/);
  const p = restrictPermission({ allow: ['Read'], deny: ['Bash'], default: 'allow' }, { allow: [], deny: ['Write'], default: 'deny' });
  assert.deepEqual(p.deny, ['Bash','Write']); assert.equal(p.mode, 'manual');
});

test('approval wakes all-wait and filters/pagination remain bounded', async () => {
  const { supervisor: s, adapter: a } = fixture();
  a.queueScript([]); a.queueScript([]);
  const id = String((await s.spawnAgent(spawn)).agent_id);
  const second = String((await s.spawnAgent(spawn)).agent_id);
  const waiting = s.waitForAgents([id, second]);
  a.emit(id, 'approval.requested', { requestId: 'approval-test', requestedAt: new Date().toISOString(), agentId: id, backend: 'claude', toolName: 'Bash', command: 'curl https://example.com', input: {}, cwd: '/tmp' });
  assert.equal((await waiting).timed_out, false);
  const page = s.sessionView({ limit: 1 });
  assert.ok(page.next_cursor);
  const next = s.sessionView({ limit: 1, cursor: String(page.next_cursor) });
  assert.notEqual((page.agents as Record<string, unknown>[])[0]!.agent_id, (next.agents as Record<string, unknown>[])[0]!.agent_id);
  assert.equal((s.sessionView({ states: ['needs_approval'] }).agents as unknown[]).length, 1);
  await s.stopAgents([id, second]);
});

test('queued chains pin results, resume does not replace prerequisite outcomes', async () => {
  const { supervisor: s, adapter: a } = fixture();
  a.queueScript([]); const id = String((await s.spawnAgent(spawn)).agent_id);
  const b = await s.spawnAgent({ ...spawn, depends_on: [id] });
  const c = await s.spawnAgent({ ...spawn, depends_on: [String(b.task_id)] });
  a.queueScript([]);
  a.emit(id, 'turn.completed', { turnId: 'a', status: 'completed', finalText: 'original' });
  await tick();
  const bResult = s.getAgentResult(String(b.task_id)) as Record<string, unknown>;
  a.queueScript([]);
  a.emit(String(bResult.agent_id), 'turn.completed', { turnId: 'b', status: 'completed', finalText: 'derived' });
  await tick();
  assert.equal(a.spawnRequests.length, 3);
  assert.match(a.spawnRequests[2]!.prompt, /derived/);
  await s.stopAgents([String(c.task_id)]);
});

test('restart marks live prerequisite interrupted and blocks recovered queued dependents', async () => {
  const first = fixture();
  const path = join(await mkdtemp(join(tmpdir(), 'restart-')), 'sessions.json');
  first.supervisor.enablePersistence(path); first.adapter.queueScript([]);
  const id = String((await first.supervisor.spawnAgent(spawn)).agent_id);
  const queued = await first.supervisor.spawnAgent({ ...spawn, depends_on: [id] });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const restarted = fixture(); restarted.supervisor.restore(saved.agents);
  restarted.supervisor.enablePersistence(path);
  await restarted.supervisor.recoverResults();
  restarted.supervisor.restorePending(saved.pending);
  await tick();
  assert.equal((restarted.supervisor.getAgentResult(String(queued.task_id)) as { state: string }).state, 'blocked');
});

test('journal replay repairs crash tails and recovers completion before snapshot commit', async () => {
  const { supervisor: s, adapter: a } = fixture();
  a.queueScript([]); const id = String((await s.spawnAgent(spawn)).agent_id);
  const path = join(await mkdtemp(join(tmpdir(), 'journal-replay-')), 'sessions.json');
  const restored = fixture().supervisor; restored.restore(s.exportSnapshot()); restored.enablePersistence(path);
  await writeFile(path + '.results.jsonl', JSON.stringify({ agent_id: id, turn: 1, status: 'completed', result: 'recovered' }) + '\n{"torn":');
  await restored.recoverResults();
  assert.equal((restored.getAgentResult(id) as Record<string, unknown>).result, 'recovered');
  assert.ok((await readFile(path + '.results.jsonl', 'utf8')).endsWith('\n'));
});
