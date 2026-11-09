export type PanelAgent = {
  id: string
  name: string
  backend: string
  model: string
  state: string
  updated: string
  tokensIn: number
  tokensOut: number
  /** Set while the agent is waiting on an approval. */
  approval?: { requestId: string; tool: string; command: string }
}

/** What a confirmation is waiting on; null when nothing is. */
export type PanelConfirm =
  | { kind: 'stop'; agent: string }
  | { kind: 'stopAll'; names: string[] }
  | { kind: 'cleanup'; agent: string }
  | { kind: 'update'; latest: string }
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
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-strip': { panel: Shaped<PanelState> }
  }
}
