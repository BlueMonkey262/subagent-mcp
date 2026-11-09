export type PanelAgent = {
  id: string
  name: string
  backend: string
  model: string
  state: string
  updated: string
  tokensIn: number
  tokensOut: number
  /** What the agent is doing right now (list_agents current_activity), while it runs. */
  activity?: string
  /** Set while the agent is waiting on an approval. */
  approval?: { requestId: string; tool: string; command: string }
}

/** What a confirmation is waiting on; null when nothing is. */
export type PanelConfirm =
  | { kind: 'stop'; agent: string }
  | { kind: 'stopAll'; names: string[] }
  | { kind: 'cleanup'; agent: string }
  | { kind: 'update'; latest: string }
  | { kind: 'message'; agent: string }
  | null

export type PanelState = {
  agents: PanelAgent[]
  selected: string | null
  /** Digest lines for the selected agent, from get_agent_events summary. */
  detail: string[]
  detailFor: string | null
  confirm: PanelConfirm
  /** Newer release from .subagents/memory/update.json, if any. */
  updateAvailable: string | null
  /** Result of the last action, or why the server is not answering. */
  message: string
  at: number
  /** Show every agent instead of the running ones and the most recent finished. */
  showAll: boolean
  /** Backends the server refuses, and which of them come from the environment (not editable here). */
  disabled: string[]
  locked: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-strip': { panel: Shaped<PanelState> }
  }
}
