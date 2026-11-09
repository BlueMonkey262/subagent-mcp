// The /subagent-mcp control panel (docs/specs/control-panel.md). Reads the subagent-mcp server over
// MCP, acts only on keys the person presses, and hands `i` / `u` to Claude as prompts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { PanelAgent, PanelState } from '../types'

const PANE = 'subagent-mcp'
const SERVER = 'subagent-mcp'
const POLL_MS = 2000
const RUNNING = ['starting', 'running', 'needs_approval', 'queued']

const panel = atom(
  { plugin: 'subagent-strip', key: 'panel' } as const,
  {
    agents: [],
    selected: null,
    detail: [],
    detailFor: null,
    confirm: null,
    updateAvailable: null,
    message: 'Connecting to subagent-mcp...',
    at: 0,
  } as PanelState,
  { shape: 'panel-2' },
)

const INIT_PROMPT =
  'Run the subagent-mcp setup interview for this project. Call list_models (live) and list_agent_configs, ' +
  'then use question menus to ask which backends to enable, which models go in the roster, which bundled ' +
  '.subagents/*.md agent configs to copy in, and whether to set disabledBackends / blockModels / ' +
  'blockClaudeModels. If .subagents/models.yaml exists, propose edits as a diff, save models.yaml.bak, ' +
  'and write only after I say yes; keep my hand-written entries and comments. Do not build, change ' +
  '~/.claude, or touch MCP registration.'

const updatePrompt = (latest: string) =>
  `Update subagent-mcp to ${latest}. Follow UPDATING.md in the subagent-mcp install repo step by step. ` +
  'Build and test in a separate worktree first, stop on any failure, and only then swap the live install and call restart_host.'

const str = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''))
const num = (value: unknown) => (typeof value === 'number' ? value : 0)
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}
const isRunning = (a: PanelAgent) => RUNNING.includes(a.state)

type Dollar = Pick<EngineInterface, 'mcp' | 'fs'>
type Call = { isError?: boolean; structuredContent?: unknown; content: { type: string; text?: string }[] }

const body = (result: Call): Record<string, unknown> => {
  const text = result.content.find(c => c.type === 'text')?.text ?? '{}'
  try {
    return (result.structuredContent as Record<string, unknown> | undefined) ?? JSON.parse(text)
  } catch {
    return { text }
  }
}

async function callTool($: Dollar, tool: string, args?: Record<string, unknown>) {
  const result = (await $.mcp.call(SERVER, tool, args)) as Call
  if (result.isError) throw new Error(str(body(result)['text'] ?? result.content.find(c => c.type === 'text')?.text ?? tool + ' failed'))
  return body(result)
}

function digest(d: Record<string, unknown>): string[] {
  const lines = [`${str(d['name'])}: ${str(d['state'])}, ${num(d['tool_calls'])} tool calls, ${num(d['errors'])} errors`]
  const recent = Array.isArray(d['recent_tools']) ? (d['recent_tools'] as Record<string, unknown>[]) : []
  for (const t of recent.slice(-4)) lines.push(`  ${str(t['tool'])} ${str(t['target']).slice(0, 70)}`)
  const msg = str(d['latest_message']).replace(/\s+/g, ' ').trim()
  if (msg) lines.push('> ' + msg.slice(-160))
  return lines
}

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
    const opened = await $.ui.open({ id: PANE, title: 'Subagents', focus: true, closeOnEscape: true, rows: 16 })

    const refresh = async () => {
      try {
        const listed = await callTool($, 'list_agents', { limit: 30 })
        const agents = ((listed['agents'] as Record<string, unknown>[] | undefined) ?? []).map(a => {
          const usage = (a['cumulative_usage'] ?? {}) as Record<string, unknown>
          return {
            id: str(a['agent_id']),
            name: str(a['name']),
            backend: str(a['backend']),
            model: str(a['model']),
            state: str(a['state']),
            updated: str(a['updated_at']),
            tokensIn: num(usage['inputTokens']),
            tokensOut: num(usage['outputTokens']),
            ...(a['request_id'] === undefined || a['request_id'] === null
              ? {}
              : { approval: { requestId: str(a['request_id']), tool: str(a['tool_name']), command: str(a['command'] ?? JSON.stringify(a['input'] ?? '')).slice(0, 200) } }),
          }
        })
        let latest: string | null = null
        try {
          const cache = JSON.parse(await $.fs.read('.subagents/memory/update.json')) as { available?: boolean; latest?: string | null }
          latest = cache.available === true && typeof cache.latest === 'string' ? cache.latest : null
        } catch {
          latest = null
        }
        const before = await read($, panel)
        const selected = agents.some(a => a.id === before.selected) ? before.selected : (agents[0]?.id ?? null)
        let detail = before.detailFor === selected ? before.detail : []
        if (selected !== null) {
          try {
            detail = digest(await callTool($, 'get_agent_events', { agent: selected, summary: true }))
          } catch {
            // keep the previous digest
          }
        }
        await update($, panel, s => ({
          ...s,
          agents,
          selected,
          detail,
          detailFor: selected,
          updateAvailable: latest,
          message: s.message.startsWith('Connecting') || s.message.startsWith('subagent-mcp is not') ? '' : s.message,
          at: Date.now(),
        }))
      } catch (error) {
        await update($, panel, s => ({ ...s, message: `subagent-mcp is not answering: ${str((error as Error).message).slice(0, 80)}`, at: Date.now() }))
      }
    }

    timer?.cancel()
    timer = $.clock.every(POLL_MS, refresh)
    // Running the command again while the pane is open reclaims the keys: the open above asks for focus,
    // and the ring is put on the selected row once the list is drawn. A refusal (text in the prompt, a
    // dialog up) is fine: the pane then shows its hint.
    void refresh().then(async () => {
      const state = await read($, panel)
      if (state.selected !== null) await $.ui.focus({ requestId: PANE, key: `agent-${state.selected}` }).catch(() => undefined)
    })

    return {
      text: opened.isPlaced ? 'Subagent panel opened.' : `Subagent panel is waiting: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const state = await read($, panel)
    const selected = state.agents.find(a => a.id === state.selected)
    const running = state.agents.filter(isRunning)
    const say = (message: string) => update($, panel, s => ({ ...s, message, confirm: null, at: Date.now() }))
    const ask = (confirm: PanelState['confirm']) => update($, panel, s => ({ ...s, confirm }))

    const run = async (label: string, tool: string, args: Record<string, unknown>) => {
      try {
        await callTool($, tool, args)
        await say(`${label}: done`)
      } catch (error) {
        await say(`${label} failed: ${str((error as Error).message).slice(0, 100)}`)
      }
    }

    const c = state.confirm
    if (c !== null && c.kind === 'message') {
      const agent = c.agent
      return (
        <Box flexDirection="column">
          <Text bold>Message {agent}</Text>
          <Input
            key="message"
            autoFocus
            placeholder="Resume with... (Enter sends, Esc cancels typing)"
            submitLabel="send"
            onSubmit={async text => {
              if (text.trim() === '') return
              await run(`Message ${agent}`, 'send_message', { agent, prompt: text, run_in_background: true })
            }}
          />
          <Button key="cancel" hotkey="n" plain onPress={() => say('Cancelled.')}>cancel</Button>
        </Box>
      )
    }
    if (c !== null) {
      const question =
        c.kind === 'stop' ? `Stop ${c.agent}?`
        : c.kind === 'stopAll' ? `Stop ${c.names.length} running agent(s): ${c.names.join(', ')}?`
        : c.kind === 'cleanup' ? `Remove ${c.agent}'s worktree? Its branch is kept, but uncommitted changes in it are lost.`
        : `Update to ${c.latest}? Claude will build it in a worktree, test it, then swap the live install and restart the host.`
      const yes = async () => {
        if (c.kind === 'stop') return run(`Stop ${c.agent}`, 'stop_agent', { agent: c.agent })
        if (c.kind === 'stopAll') return run('Stop all', 'stop_agents', { agents: c.names })
        if (c.kind === 'cleanup') return run(`Clean up ${c.agent}`, 'cleanup_worktree', { agent: c.agent })
        await say('Update prompt sent to Claude.')
        await $.prompt.submit({ text: updatePrompt(c.latest) })
      }
      return (
        <Box flexDirection="column">
          <Text bold>{question}</Text>
          <Box>
            <Button key="yes" hotkey="y" plain onPress={yes}>yes</Button>
            <Text>  </Text>
            <Button key="no" hotkey="n" plain onPress={() => say('Cancelled.')}>no</Button>
          </Box>
        </Box>
      )
    }

    const wide = e.props.placement === 'dock' && e.props.bodyColumns >= 90
    const select = (id: string) => update($, panel, s => ({ ...s, selected: id, detail: [], detailFor: id }))
    const at = state.agents.findIndex(a => a.id === state.selected)
    const move = (by: number) => {
      const next = state.agents[Math.min(state.agents.length - 1, Math.max(0, at + by))]
      return next === undefined ? undefined : select(next.id)
    }
    const pending = selected?.approval
    const detailLines =
      selected === undefined ? [] : pending === undefined ? state.detail : [`Waiting for approval: ${pending.tool} ${pending.command}`, ...state.detail]
    const decide = async (decision: 'allow' | 'allow_for_session' | 'deny') => {
      if (selected === undefined || pending === undefined) return
      const label = decision === 'deny' ? 'Denied' : decision === 'allow' ? 'Allowed' : 'Allowed for session'
      try {
        await callTool($, 'resolve_approval', { request_id: pending.requestId, decision })
        await say(`${label}: ${selected.name} ${pending.tool}`)
      } catch (error) {
        await say(`${label} failed: ${str((error as Error).message).slice(0, 100)}`)
      }
    }
    const row = (a: PanelAgent) => (
      <Button key={`agent-${a.id}`} onPress={() => select(a.id)}>
        {state.selected === a.id ? '> ' : '  '}
        {a.name} <Text dimColor>{a.backend} {a.model} {a.state} {k(a.tokensIn)}in/{k(a.tokensOut)}out {ago(a.updated)}</Text>
      </Button>
    )
    // Inline, the pane shows a window over the tree, so the key bar and message come first and the selected
    // row's digest opens right under it; docked, the digest has its own column.
    const list = (
      <Box flexDirection="column">
        {state.agents.length === 0 && <Text dimColor>No agents.</Text>}
        {state.agents.map(a => (
          <Box key={`g-${a.id}`} flexDirection="column">
            {row(a)}
            {!wide && state.selected === a.id && detailLines.map((line, i) => <Text key={`d${i}`} dimColor>{'    ' + line}</Text>)}
          </Box>
        ))}
      </Box>
    )
    const detail = (
      <Box flexDirection="column">
        {selected === undefined ? <Text dimColor>Select an agent.</Text> : detailLines.map((line, i) => <Text key={`d${i}`} dimColor={i > 0}>{line}</Text>)}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {!e.props.isFocused && (
          <Text color="yellow">Keys go to the chat. Click here, or run /subagent-mcp again, to use the panel.</Text>
        )}
        <Box>
          {pending !== undefined && <Button key="allow" hotkey="a" plain onPress={() => decide('allow')}>allow</Button>}
          {pending !== undefined && <Text>  </Text>}
          {pending !== undefined && <Button key="allow-session" hotkey="r" plain onPress={() => decide('allow_for_session')}>allow for session</Button>}
          {pending !== undefined && <Text>  </Text>}
          {pending !== undefined && <Button key="deny" hotkey="d" plain onPress={() => decide('deny')}>deny</Button>}
          {pending !== undefined && <Text>  </Text>}
          {selected !== undefined && isRunning(selected) && (
            <Button key="stop" hotkey="s" plain onPress={() => ask({ kind: 'stop', agent: selected.name })}>stop</Button>
          )}
          {selected !== undefined && isRunning(selected) && <Text>  </Text>}
          {running.length > 0 && (
            <Button key="stop-all" hotkey="x" plain onPress={() => ask({ kind: 'stopAll', names: running.map(a => a.name) })}>stop all</Button>
          )}
          {running.length > 0 && <Text>  </Text>}
          {selected !== undefined && !isRunning(selected) && (
            <Button key="cleanup" hotkey="w" plain onPress={() => ask({ kind: 'cleanup', agent: selected.name })}>clean worktree</Button>
          )}
          {selected !== undefined && !isRunning(selected) && <Text>  </Text>}
          {selected !== undefined && <Button key="message" hotkey="m" plain onPress={() => ask({ kind: 'message', agent: selected.name })}>message</Button>}
          {selected !== undefined && <Text>  </Text>}
          <Button
            key="init"
            hotkey="i"
            plain
            onPress={async () => {
              await say('Setup prompt sent to Claude.')
              await $.prompt.submit({ text: INIT_PROMPT })
            }}
          >
            init
          </Button>
          {state.updateAvailable !== null && <Text>  </Text>}
          {state.updateAvailable !== null && (
            <Button key="update" hotkey="u" plain onPress={() => ask({ kind: 'update', latest: state.updateAvailable ?? '' })}>
              update to {state.updateAvailable}
            </Button>
          )}
          <Text>  </Text>
          <Button key="down" hotkey="j" plain onPress={() => move(1)}>next</Button>
          <Text>  </Text>
          <Button key="up" hotkey="k" plain onPress={() => move(-1)}>prev</Button>
        </Box>
        {state.message !== '' && <Text dimColor>{state.message}</Text>}
        {wide ? (
          <Box>
            <Box flexDirection="column" width={Math.floor(e.props.bodyColumns / 2)}>{list}</Box>
            <Box flexDirection="column">{detail}</Box>
          </Box>
        ) : (
          list
        )}
      </Box>
    )
  })
}
