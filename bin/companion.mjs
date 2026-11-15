#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { fileURLToPath } from 'node:url';
import { HostSession } from '../dist/src/host.js';
import { resolveModelsFile } from '../dist/src/config/models-file.js';

const cwd = process.cwd();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const models = resolveModelsFile({ cwd });
const localAgents = resolve(cwd, '.subagents');
const host = new HostSession({ cwd, agentsDirectory: process.env.SUBAGENT_MCP_AGENTS_DIR ?? (existsSync(localAgents) ? localAgents : resolve(root, '.subagents')), modelsFile: models.path, modelsFileChecked: models.checked, scriptPath: resolve(root, 'dist/src/server.js') });
const rl = createInterface({ input: stdin, output: stdout });
await host.connect();
let dashboardUnavailable = false;
async function dashboard(since) {
  try {
    if (dashboardUnavailable) return await host.call('list_agents', {}, 10000);
    return await host.call('get_dashboard', since ? { since } : {}, 10000);
  }
  catch (error) {
    if (!/unknown|not found/i.test(error.message)) throw error;
    dashboardUnavailable = true;
    console.log('Older host: showing agents without dashboard details.');
    return host.call('list_agents', {}, 10000);
  }
}
function display(result) {
  if (!Array.isArray(result.agents)) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`Agents (${result.agents.length}):`);
  for (const agent of result.agents) {
    const usage = agent.cumulative_usage ?? {};
    const tokens = typeof usage.inputTokens === 'number' ? ` | ${usage.inputTokens} in / ${usage.outputTokens ?? '?'} out` : '';
    console.log(`  ${agent.name ?? agent.agent_id} | ${agent.state ?? agent.status} | ${agent.backend ?? ''} ${agent.model ?? ''} | ${agent.current_activity ?? ''}${tokens}`);
  }
  if (Array.isArray(result.ensembles) && result.ensembles.length) {
    console.log('Ensembles:');
    for (const ensemble of result.ensembles) {
      console.log(`  ${ensemble.name ?? ensemble.ensemble_id} | ${ensemble.status}`);
      for (const member of ensemble.members ?? []) console.log(`    ${member.role}: ${member.name ?? member.agent_id ?? ''} | ${member.state}`);
    }
  }
  if (Array.isArray(result.approvals)) for (const approval of result.approvals) console.log(`  Approval ${approval.request_id}: ${approval.name ?? approval.agent_id} ${approval.tool_name ?? ''}`);
  if (host.warning()) console.log(`Host: ${host.warning()}`);
}
console.log('subagent-mcp companion. Type help for commands.');
try {
  while (true) {
    const line = (await rl.question('subagents> ')).trim();
    const [cmd, arg, ...rest] = line.split(/\s+/);
    if (cmd === 'quit' || cmd === 'q') break;
    if (!cmd) continue;
    if (cmd === 'help') { console.log('list | watch | show AGENT | digest AGENT | diff AGENT | message AGENT TEXT | stop AGENT | stop-all | cleanup AGENT | approve REQUEST allow|allow_for_session|deny | backend NAME | ensembles | setup | update | quit'); continue; }
    if (cmd === 'watch') {
      let running = true, pending = false, revision;
      const refresh = async () => {
        if (pending || !running) return;
        pending = true;
        try { const result = await dashboard(revision); revision = result.revision; if (running && !result.unchanged) { console.log('\n--- live agents ---'); display(result); } }
        catch (error) { if (running) console.error(error.message); }
        finally { pending = false; }
      };
      await refresh();
      const timer = setInterval(() => void refresh(), 2000);
      try { await rl.question('Watching; press Enter to return.\n'); }
      finally { running = false; clearInterval(timer); }
      continue;
    }
    if (cmd === 'setup') { console.log(`Ask your main agent to follow ${resolve(root, 'SETUP.md')} and help configure this project.`); continue; }
    if (cmd === 'update') { console.log(`Ask your main agent to follow ${resolve(root, 'UPDATING.md')}.`); continue; }
    if (cmd === 'stop-all') {
      try {
        const board = await dashboard();
        const agents = (board.agents ?? []).filter(a => ['starting', 'running', 'queued', 'needs_approval'].includes(String(a.state ?? a.status))).map(a => a.agent_id).filter(Boolean);
        if (!agents.length) { console.log('No active agents.'); continue; }
        if ((await rl.question(`Stop ${agents.length} active agents? [y/N] `)).trim().toLowerCase() !== 'y') continue;
        console.log(JSON.stringify(await host.call('stop_agents', { agents }, 10000), null, 2));
      } catch (error) { console.error(error.message); }
      continue;
    }
    if (cmd === 'backend' && arg) {
      if (!['claude', 'codex', 'opencode', 'antigravity', 'cursor', 'copilot', 'vibe'].includes(arg)) { console.error('Unknown backend.'); continue; }
      try {
        const roster = await host.call('list_models', { live: false }, 10000);
        const path = roster.models_file;
        if (typeof path !== 'string') throw new Error('The host did not report a models file.');
        const source = await readFile(path, 'utf8');
        const doc = parseDocument(source);
        if (doc.errors.length) throw new Error('models.yaml is invalid; edit it manually.');
        const active = /^disabledBackends:[ \t]*(.*?)[ \t]*(?:#.*)?$/m;
        const match = active.exec(source);
        if (match && !/^\[.*\]$/.test(match[1].trim())) throw new Error('disabledBackends must be a one-line list; edit it manually.');
        const existing = doc.get('disabledBackends');
        const disabled = existing === undefined ? [] : existing.toJSON();
        if (!Array.isArray(disabled) || disabled.some(item => typeof item !== 'string')) throw new Error('disabledBackends must be a list of names.');
        const next = disabled.includes(arg) ? disabled.filter(item => item !== arg) : [...disabled, arg];
        if ((await rl.question(`${next.includes(arg) ? 'Disable' : 'Enable'} ${arg} in ${path}? [y/N] `)).trim().toLowerCase() !== 'y') continue;
        if (await readFile(path, 'utf8') !== source) throw new Error('The file changed; retry after reviewing it.');
        await copyFile(path, `${path}.bak`);
        const line = `disabledBackends: [${next.join(', ')}]`;
        const modelsLine = /^models:/m.exec(source);
        if (!match && !modelsLine) throw new Error('models.yaml has no models section.');
        const updated = match ? source.replace(active, line) : `${source.slice(0, modelsLine.index)}${line}\n\n${source.slice(modelsLine.index)}`;
        await writeFile(path, updated);
        console.log(`Updated ${path}; backup saved to ${path}.bak`);
      } catch (error) { console.error(error.message); }
      continue;
    }
    let method, input = {};
    if (cmd === 'list') method = 'get_dashboard';
    else if (cmd === 'ensembles') method = 'get_dashboard';
    else if (cmd === 'show' && arg) { method = 'get_agent_result'; input = { agent: arg }; }
    else if (cmd === 'digest' && arg) { method = 'get_agent_events'; input = { agent: arg, summary: true }; }
    else if (cmd === 'diff' && arg) { method = 'get_agent_diff'; input = { agent: arg }; }
    else if (cmd === 'message' && arg && rest.length) { method = 'send_message'; input = { agent: arg, prompt: rest.join(' '), run_in_background: true }; }
    else if ((cmd === 'stop' || cmd === 'cleanup') && arg) {
      if ((await rl.question(`${cmd} ${arg}? [y/N] `)).trim().toLowerCase() !== 'y') continue;
      method = cmd === 'stop' ? 'stop_agent' : 'cleanup_worktree'; input = { agent: arg };
    } else if (cmd === 'approve' && arg && ['allow', 'allow_for_session', 'deny'].includes(rest[0])) { method = 'resolve_approval'; input = { request_id: arg, decision: rest[0] }; }
    else { console.log('Unknown or incomplete command; type help.'); continue; }
    try {
      const result = method === 'get_dashboard' ? await dashboard() : await host.call(method, input, 10000);
      if (method === 'get_dashboard') display(result);
      else console.log(JSON.stringify(result, null, 2));
    } catch (error) { console.error(error.message); }
  }
} catch (error) { if (error.code !== 'ERR_USE_AFTER_CLOSE') console.error(error.message); }
finally { rl.close(); host.close(); }
