import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function fixture(registered: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-launcher-'));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'codex'), `#!/bin/bash\nprintf '<%s>' "$@" >> "$LAUNCH_TEST_LOG"; printf '\\n' >> "$LAUNCH_TEST_LOG"\nif [[ "\${1:-}" == mcp && "\${2:-}" == get ]]; then [[ -f "$LAUNCH_TEST_REGISTERED" ]]; exit; fi\nif [[ "\${1:-}" == mcp && "\${2:-}" == add ]]; then touch "$LAUNCH_TEST_REGISTERED"; fi\n`, { mode: 0o755 });
  const marker = join(dir, 'registered');
  if (registered) writeFileSync(marker, '');
  return { log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LAUNCH_TEST_LOG: log, LAUNCH_TEST_REGISTERED: marker } };
}

test('Codex launcher registers once and forwards arguments without splitting', () => {
  const f = fixture(false);
  execFileSync(resolve('bin/subagent-mcp'), ['--codex', '--model', 'model with spaces'], { env: f.env });
  const calls = readFileSync(f.log, 'utf8').trim().split('\n');
  assert.equal(calls[0], '<mcp><get><subagent-mcp>');
  assert.equal(calls[1], '<mcp><list>');
  assert.match(calls[2]!, /^<mcp><add><subagent-mcp><--><.*\/bin\/run-server\.sh>$/);
  assert.equal(calls[3], '<mcp><get><subagent-mcp>');
  assert.equal(calls[4], '<--model><model with spaces>');
  execFileSync(resolve('bin/subagent-mcp'), ['--codex', 'resume', '--last'], { env: f.env });
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').filter(line => line.startsWith('<mcp><add>')).length, 1);
});
