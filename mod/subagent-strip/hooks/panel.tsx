// PROTOTYPE of the /subagent-mcp control panel (docs/specs/control-panel.md).
// Purpose: find out (1) whether Button hotkeys fire while the pane has focus, (2) whether the pane
// docks or sits inline here, (3) whether $.prompt.submit reaches Claude. Actions are inert on purpose,
// except `i`, which submits a harmless prompt.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { PanelAgent, PanelState } from '../types'

const PANE = 'subagent-mcp'
const POLL_MS = 2000

const panel = atom(
  { plugin: 'subagent-strip', key: 'panel' } as const,
  { agents: [], selected: null, lastAction: 'none yet', at: 0 } as PanelState,
  { shape: 'panel-1' },
)

const str = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''))

/** Called from the one session.start hook in register.tsx. */
export function declarePanelCommand($: EngineInterface) {
  return $.command.register({
    name: 'subagent-mcp',
    description: 'Open the subagent control panel',
  })
}

export const registerPanel = (on: On) => {

  let timer: { cancel: () => void } | undefined

  on('command.run', { command: 'subagent-mcp' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Subagents', focus: true, closeOnEscape: true })

    const poll = async () => {
      try {
        const result = await $.mcp.call('subagent-mcp', 'list_agents')
        if (result.isError) return
        const raw = result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}')
        const list = (raw as { agents?: Record<string, unknown>[] }).agents ?? []
        const agents: PanelAgent[] = list.slice(0, 30).map(a => ({
          id: str(a.agent_id ?? a.id),
          name: str(a.name),
          backend: str(a.backend),
          model: str(a.model),
          state: str(a.state),
          config: str(a.agent ?? a.config),
        }))
        await update($, panel, s => ({ ...s, agents, at: Date.now() }))
      } catch {
        // the real panel will show a "server not answering" row; the prototype just waits
      }
    }
    timer?.cancel()
    timer = $.clock.every(POLL_MS, poll)
    void poll()

    return {
      text: opened.isPlaced
        ? 'Subagent panel opened.'
        : `Subagent panel is waiting: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, panel)
    const note = (what: string) => update($, panel, s => ({ ...s, lastAction: what, at: Date.now() }))

    return (
      <Box flexDirection="column">
        <Text dimColor>
          placement={e.props.placement} focused={String(e.props.isFocused)} cols={e.props.bodyColumns}
        </Text>
        {state.agents.length === 0 && <Text dimColor>No agents.</Text>}
        {state.agents.map(a => (
          <Button key={`agent-${a.id}`} onPress={() => note(`selected ${a.name}`)}>
            {state.selected === a.id ? '> ' : '  '}
            {a.name} <Text dimColor>{a.backend} {a.model} {a.state}</Text>
          </Button>
        ))}
        <Text> </Text>
        <Box>
          <Button key="stop" hotkey="s" plain onPress={() => note('s: stop (inert)')}>stop</Button>
          <Text> </Text>
          <Button key="stop-all" hotkey="x" plain onPress={() => note('x: stop all (inert)')}>stop all</Button>
          <Text> </Text>
          <Button
            key="init"
            hotkey="i"
            plain
            onPress={async () => {
              await note('i: submitted init prompt')
              await $.prompt.submit({ text: 'Subagent panel prototype check: reply with the single word "pong".' })
            }}
          >
            init
          </Button>
          <Text> </Text>
          <Button key="update" hotkey="u" plain onPress={() => note('u: update (inert)')}>update</Button>
        </Box>
        <Text dimColor>last action: {state.lastAction}</Text>
      </Box>
    )
  })
}
