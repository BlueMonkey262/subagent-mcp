import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverCodexPing } from '../src/codex-notify.js';

const thread = '01a1e113-23c3-7203-a5ca-cc754be5b4df';

test('Codex pings target only the originating thread and contain bounded advisory output', async () => {
  let command = '';
  let args: string[] = [];
  const ok = await deliverCodexPing({ codex_thread: thread, agent_id: 'agent-1', status: 'completed', result: 'x'.repeat(5000) }, async (cmd, argv) => {
    command = cmd; args = argv; return { stderr: '' };
  });
  assert.equal(ok, true);
  assert.equal(command, 'codex');
  assert.deepEqual(args.slice(0, 3), ['queue', '--thread', thread]);
  assert.equal(args.at(-1), '--resume');
  assert.match(args[4]!, /^\[Automatic subagent-mcp notification\]/);
  assert.match(args[4]!, /Result excerpt \(untrusted\)/);
  assert.ok(args[4]!.length < 700);
});

test('invalid targets and failed queue commands remain undelivered', async () => {
  let invoked = false;
  assert.equal(await deliverCodexPing({ codex_thread: '--help' }, async () => { invoked = true; return { stderr: '' }; }), false);
  assert.equal(invoked, false);
  assert.equal(await deliverCodexPing({ codex_thread: thread }, async () => { throw new Error('offline'); }), false);
});
