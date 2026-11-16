import assert from 'node:assert/strict';
import test from 'node:test';
import { callCodexHost, codexSpawnDefaults } from '../src/codex-defaults.js';

test('Codex spawn defaults to background but preserves explicit foreground', () => {
  assert.deepEqual(codexSpawnDefaults('codex-mcp-client', 'spawn_agent', { agent: 'a' }), { agent: 'a', run_in_background: true });
  assert.deepEqual(codexSpawnDefaults('codex-mcp-client', 'spawn_agent', { run_in_background: false }), { run_in_background: false });
  assert.deepEqual(codexSpawnDefaults('claude-code', 'spawn_agent', {}), {});
  assert.deepEqual(codexSpawnDefaults('codex-mcp-client', 'send_message', {}), {});
});

test('old host fallback preserves background arguments and warns without retrying other errors', async () => {
  const methods: string[] = [];
  const input = { agent: 'a', run_in_background: true };
  const result = await callCodexHost(async (method, args) => {
    methods.push(method);
    if (method.startsWith('codex_')) throw new Error('Unknown host method codex_spawn_agent');
    assert.deepEqual(args, input);
    return { status: 'running' };
  }, 'spawn_agent', input, 'thread') as Record<string, unknown>;
  assert.deepEqual(methods, ['codex_spawn_agent', 'spawn_agent']);
  assert.equal(result.status, 'running');
  assert.match(String(result.notification_warning), /too old/);
  let calls = 0;
  await assert.rejects(callCodexHost(async () => { calls++; throw new Error('connection lost'); }, 'spawn_agent', input, 'thread'), /connection lost/);
  assert.equal(calls, 1);
});
