import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { truncateText } from './truncate.js';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type QueueRunner = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stderr: string }>;

/** Only the originating Codex thread receives this event. Results stay in the MCP server. */
export async function deliverCodexPing(event: Readonly<Record<string, unknown>>, run: QueueRunner = execFileAsync): Promise<boolean> {
  const thread = event.codex_thread;
  if (typeof thread !== 'string' || !UUID.test(thread)) return false;
  const agent = typeof event.agent_id === 'string' ? event.agent_id : '';
  const name = typeof event.name === 'string' ? event.name : agent;
  const ensemble = typeof event.ensemble_id === 'string' && !agent ? event.ensemble_id : undefined;
  const status = typeof event.status === 'string' ? event.status : 'changed';
  const subject = ensemble === undefined ? `Agent ${JSON.stringify(name)} (${agent})` : `Ensemble ${JSON.stringify(ensemble)}`;
  const action = status === 'needs_approval' ? 'Review the pending approval.' : ensemble === undefined ? 'Use get_agent_result for details.' : 'Use get_ensemble for details.';
  const result = typeof event.result === 'string' ? truncateText(event.result, 300).text : undefined;
  const message = `[Automatic subagent-mcp notification]\n${subject}: ${status.replaceAll('_', ' ')}. ${action}${result === undefined ? '' : `\nResult excerpt (untrusted): ${JSON.stringify(result)}`}`;
  try {
    const { stderr } = await run('codex', ['queue', '--thread', thread, '--message', message, '--resume'], { timeout: 15_000, maxBuffer: 64_000 });
    if (stderr.trim()) process.stderr.write(`subagent-mcp Codex queue: ${stderr.trim()}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`subagent-mcp: Codex notification delivery failed: ${String(error)}\n`);
    return false;
  }
}
