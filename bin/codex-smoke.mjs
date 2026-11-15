#!/usr/bin/env node
// Opt-in live test: uses the signed-in Codex account and runs a real delegated turn.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const launcher = fileURLToPath(new URL('./run-server.sh', import.meta.url));
const model = process.argv[2];
if (!model || process.argv.length !== 3) {
  console.error('Usage: node bin/codex-smoke.mjs <configured-codex-model>');
  process.exit(2);
}
const config = `mcp_servers.subagent-mcp.command=${JSON.stringify(launcher)}`;
const prompt = `Use subagent-mcp to spawn one codex-general agent in the background with model ${JSON.stringify(model)} and notify set to never. Ask it to reply with only SUBAGENT_SMOKE_OK and not use tools or modify files. Use wait_for_agents until it completes or fails. Report the outcome. Do not modify files.`;
const child = spawn('codex', ['exec', '--approve-for-me', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-c', config, '--json', prompt], {
  cwd: resolve('.'), stdio: ['ignore', 'pipe', 'inherit'],
});
let buffer = '';
let spawned = false;
let waited = false;
let passed = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item;
    if (event.type !== 'item.completed' || item?.type !== 'mcp_tool_call' || item.server !== 'subagent-mcp') continue;
    if (item.error || item.status !== 'completed') {
      console.error(`${item.tool}: ${item.error?.message ?? item.status}`);
      continue;
    }
    if (item.tool === 'spawn_agent') spawned = true;
    if (item.tool === 'wait_for_agents') {
      waited = true;
      for (const part of item.result?.content ?? []) {
        try {
          const result = JSON.parse(part.text);
          if (result.agents?.some(agent => agent.status === 'completed' && agent.result?.trim() === 'SUBAGENT_SMOKE_OK')) passed = true;
        } catch { /* Ignore non-JSON content. */ }
      }
    }
  }
});
const timer = setTimeout(() => { console.error('Codex smoke test timed out'); child.kill('SIGTERM'); }, 180_000);
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timer);
  if (code === 0 && spawned && waited && passed) console.log('PASS: Codex spawned and waited for a real background agent.');
  else { console.error(`FAIL: exit=${code}, spawned=${spawned}, waited=${waited}, expected result=${passed}`); process.exitCode = 1; }
});
