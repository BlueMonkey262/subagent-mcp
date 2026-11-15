import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAgentBar } from '../src/agent-bar.js';

test('agent bar includes state and activity without terminal or tmux control sequences', () => {
  assert.equal(formatAgentBar([]), 'subagents: no active agents');
  assert.equal(formatAgentBar([{ name: 'Ada\u001b[31m', state: 'running', current_activity: '#[bold]test\nnext' }]), 'subagents: Ada [31m: running (##[bold]test next)');
  assert.equal(formatAgentBar([{ task_id: 't', status: 'queued' }]), 'subagents: t: queued');
});
