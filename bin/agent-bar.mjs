#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HostSession } from '../dist/src/host.js';
import { resolveModelsFile } from '../dist/src/config/models-file.js';
import { formatAgentBar } from '../dist/src/agent-bar.js';

const cwd = process.cwd();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const models = resolveModelsFile({ cwd });
const local = resolve(cwd, '.subagents');
const host = new HostSession({ cwd, agentsDirectory: process.env.SUBAGENT_MCP_AGENTS_DIR ?? (existsSync(local) ? local : resolve(root, '.subagents')), modelsFile: models.path, modelsFileChecked: models.checked, scriptPath: resolve(root, 'dist/src/server.js') });
const once = process.argv.includes('--once');
await host.connect();
let busy = false;
async function draw() {
  if (busy) return;
  busy = true;
  try {
    const result = await host.call('list_agents', { states: ['starting', 'running', 'needs_approval', 'queued'], limit: 100 }, 10000);
    const agents = Array.isArray(result.agents) ? result.agents : [];
    const line = formatAgentBar(agents);
    if (once || !process.stdout.isTTY) console.log(line);
    else process.stdout.write(`\r\x1b[2K${line.slice(0, Math.max(1, (process.stdout.columns ?? 80) - 1))}`);
  } catch { if (once || !process.stdout.isTTY) console.log('subagents: unavailable'); else process.stdout.write('\r\x1b[2Ksubagents: unavailable'); }
  finally { busy = false; }
}
await draw();
if (once) { host.close(); process.exit(0); }
const timer = setInterval(() => void draw(), 2000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); host.close(); if (process.stdout.isTTY) console.log(); process.exit(0); });
