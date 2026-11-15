// What the person hears about without opening the panel. Desktop app sessions get no channel
// events from subagent-mcp (the launcher's --dangerously-load-development-channels flag is
// terminal-only), so these toasts are how they learn an agent finished or is waiting.

export type Row = Record<string, unknown>

export type Snapshot = {
  agents: Row[]
  ensembles: Row[]
  agentStates: Map<string, string>
  ensembleStates: Map<string, string>
}

const LIVE = ['starting', 'running', 'needs_approval', 'queued']
const OPEN_ENSEMBLE = ['launching', 'running', 'synthesizing']

export function snapshotOf(agents: Row[], ensembles: Row[]): Snapshot {
  return {
    agents,
    ensembles,
    agentStates: new Map(agents.map(a => [String(a['agent_id']), String(a['state'])])),
    ensembleStates: new Map(ensembles.map(e => [String(e['ensemble_id']), String(e['status'])])),
  }
}

/** One line per change worth a toast between two polls; nothing on the first poll. */
export function transitions(before: Snapshot | undefined, after: Snapshot): string[] {
  if (before === undefined) return []
  const notes: string[] = []
  for (const agent of after.agents) {
    const id = String(agent['agent_id'])
    const was = before.agentStates.get(id)
    const state = String(agent['state'])
    const name = String(agent['name'] ?? id)
    if (state === 'needs_approval' && was !== 'needs_approval') {
      const what = `${String(agent['tool_name'] ?? 'a tool')} ${String(agent['command'] ?? '')}`.trim().slice(0, 80)
      notes.push(`${name} needs approval: ${what} (/subagent-mcp to answer)`)
      continue
    }
    // An ensemble member is reported with its ensemble.
    if (agent['ensemble_id'] !== undefined && agent['ensemble_id'] !== null) continue
    if (was !== undefined && LIVE.includes(was) && !LIVE.includes(state)) {
      notes.push(`${name} ${state === 'completed' ? 'finished' : state} (${String(agent['backend'] ?? '')} ${String(agent['model'] ?? '')})`.replace(' ()', ''))
    }
  }
  for (const ensemble of after.ensembles) {
    const id = String(ensemble['ensemble_id'])
    const was = before.ensembleStates.get(id)
    const status = String(ensemble['status'])
    if (was !== undefined && OPEN_ENSEMBLE.includes(was) && !OPEN_ENSEMBLE.includes(status)) {
      notes.push(`Ensemble ${String(ensemble['name'] ?? id)} ${status}: ${String(ensemble['valid'])}/${String(ensemble['of'])} valid`)
    }
  }
  return notes
}
