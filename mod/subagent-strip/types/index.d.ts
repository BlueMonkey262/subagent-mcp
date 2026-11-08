export type PanelAgent = {
  id: string
  name: string
  backend: string
  model: string
  state: string
  config: string
}

export type PanelState = {
  agents: PanelAgent[]
  selected: string | null
  /** Last key or button the prototype saw, so a test run can confirm hotkeys work. */
  lastAction: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-strip': { panel: Shaped<PanelState> }
  }
}
