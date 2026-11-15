/** A terminal/tmux-safe single-line summary of live agents. */
export function formatAgentBar(agents: readonly Readonly<Record<string, unknown>>[]): string {
  const clean = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f\x1b]/g, ' ').replace(/#\[/g, '##[');
  const label = agents.length ? agents.map(a => `${clean(a.name ?? a.agent_id ?? a.task_id)}: ${clean(a.state ?? a.status)}${a.current_activity ? ` (${clean(a.current_activity)})` : ''}`).join('  ·  ') : 'no active agents';
  return `subagents: ${label}`;
}
