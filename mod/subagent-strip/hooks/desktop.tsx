// The control panel as the desktop app draws it: tinted surfaces instead of outlines, backend avatars and
// status pills drawn as SVG, native type sizes. panel.tsx owns the state and every action; this file only
// lays them out. Keys and hotkeys match the terminal layout, so the same keys press the same things.
import type { ElementTable } from 'claude-code'

import type { PanelAgent, PanelEnsemble, PanelState } from '../types'

type El = ElementTable<'desktop'>

export type DesktopView = {
  state: PanelState
  visible: PanelAgent[]
  hidden: number
  selected: PanelAgent | undefined
  running: PanelAgent[]
  wide: boolean
  backends: readonly string[]
  isRunning: (a: PanelAgent) => boolean
  activityOf: (a: PanelAgent) => string
  statusOf: (state: string) => { glyph: string; color: string; label: string }
  k: (n: number) => string
  ago: (iso: string) => string
  act: {
    select: (id: string) => unknown
    move: (by: number) => unknown
    decide: (d: 'allow' | 'allow_for_session' | 'deny') => unknown
    stop: (a: PanelAgent) => unknown
    stopAll: () => unknown
    message: (a: PanelAgent) => unknown
    diff: (a: PanelAgent) => unknown
    cleanup: (a: PanelAgent) => unknown
    init: () => unknown
    update: () => unknown
    toggleAll: () => unknown
    backend: (b: string) => unknown
  }
}

// SVG takes no theme keys, so the drawings carry raw colors that read on light and dark panels alike.
const HEX: Record<string, string> = {
  claude: '#D97757',
  permission: '#4C8DF6',
  success: '#2FA36B',
  error: '#E5534B',
  warning: '#D4A72C',
  inactive: '#8C8C8C',
}
const BACKEND_HEX: Record<string, string> = {
  claude: '#D97757',
  codex: '#8B5CF6',
  opencode: '#0EA5B7',
  antigravity: '#4285F4',
  cursor: '#5B6472',
  copilot: '#24A148',
  vibe: '#E8559A',
}
const hexOf = (key: string) => HEX[key] ?? HEX['inactive'] ?? '#8C8C8C'
const backendHex = (b: string) => BACKEND_HEX[b] ?? '#7A7F87'

// Translucent fills (8-digit hex) so one value tints both the light and the dark panel.
const SURFACE = '#8080800F'
const HOVER = '#80808017'
const SELECTED = '#D977571F'
const CLEAR = '#00000000'
const tint = (hex: string, alpha = '1F') => hex + alpha

const FONT = 'font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A rounded square in the backend's color with the agent's initials. */
export function avatar(name: string, backend: string, size = 28): string {
  const initials = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).replace(/^./, c => c.toUpperCase()) || '?'
  const r = Math.round(size * 0.28)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${r}" fill="${backendHex(backend)}"/>` +
    `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" ${FONT} font-size="${Math.round(size * 0.4)}" font-weight="600" fill="#fff">${esc(initials)}</text>` +
    `</svg>`
  )
}

/** A status pill: tinted capsule, colored dot (pulsing while live), colored label. */
export function pill(text: string, color: string, live: boolean): { source: string; width: number; height: number } {
  const fill = hexOf(color)
  const h = 18
  const w = Math.round(text.length * 6.1 + 26)
  const pulse = live
    ? `<circle cx="10" cy="9" r="3" fill="${fill}" opacity="0.4"><animate attributeName="r" values="3;5.5;3" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.5;0;0.5" dur="1.6s" repeatCount="indefinite"/></circle>`
    : ''
  return {
    width: w,
    height: h,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect width="${w}" height="${h}" rx="9" fill="${fill}" fill-opacity="0.14"/>${pulse}` +
      `<circle cx="10" cy="9" r="3" fill="${fill}"/>` +
      `<text x="18" y="12.5" ${FONT} font-size="10.5" font-weight="600" fill="${fill}">${esc(text)}</text>` +
      `</svg>`,
  }
}

/** One bar split by share of agents in each state: the header's at-a-glance picture. */
export function stateBar(parts: { n: number; color: string }[], width = 240): string {
  const total = parts.reduce((s, p) => s + p.n, 0)
  const h = 6
  if (total === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}"><rect width="${width}" height="${h}" rx="3" fill="#808080" fill-opacity="0.18"/></svg>`
  let x = 0
  const segs = parts
    .filter(p => p.n > 0)
    .map(p => {
      const w = (p.n / total) * width
      const seg = `<rect x="${x.toFixed(2)}" width="${Math.max(0, w - 2).toFixed(2)}" height="${h}" fill="${hexOf(p.color)}"/>`
      x += w
      return seg
    })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}"><clipPath id="c"><rect width="${width}" height="${h}" rx="3"/></clipPath><g clip-path="url(#c)">${segs.join('')}</g></svg>`
}

function digest(lines: string[]) {
  return {
    stats: lines[0]?.replace(/^[^:]*:\s*[^,]*,\s*/, '') ?? '',
    tools: lines.slice(1).filter(l => l.startsWith('  ')).map(l => l.trim()),
    said: lines.find(l => l.startsWith('> '))?.slice(2) ?? '',
  }
}

export function desktopPane(el: El, v: DesktopView) {
  const { Box, Text, Button, Svg, Markdown, Progress } = el
  const { state, act } = v
  const status = (s: string) => v.statusOf(s)
  const live = (s: string) => ['starting', 'running', 'queued'].includes(s)
  const Pill = (s: string) => {
    const p = pill(status(s).label, status(s).color, live(s))
    return <Svg source={p.source} alt={status(s).label} width={p.width} height={p.height} />
  }
  const Avatar = (a: PanelAgent, size = 28) => <Svg source={avatar(a.name, a.backend, size)} alt={`${a.name}, ${a.backend}`} width={size} height={size} />
  const label = (text: string) => (
    <Text size="caption" weight="semibold" dimColor>
      {text}
    </Text>
  )
  // A tinted, rounded surface: the one container style the pane uses, so it reads as one piece.
  const surface = { borderStyle: 'round', borderColor: CLEAR, backgroundColor: SURFACE } as const

  const waiting = state.agents.filter(a => a.state === 'needs_approval').length
  const done = state.agents.filter(a => a.state === 'completed').length
  const failed = state.agents.filter(a => a.state === 'failed').length
  const other = state.agents.length - v.running.length - done - failed
  const counts = [
    { n: v.running.length - waiting, text: 'running', color: 'claude' },
    { n: waiting, text: 'waiting', color: 'permission' },
    { n: done, text: 'done', color: 'success' },
    { n: failed, text: 'failed', color: 'error' },
    { n: other, text: 'stopped', color: 'inactive' },
  ]
  const problem = state.message.startsWith('subagent-mcp is not') || / failed|Could not/.test(state.message)

  const header = (
    <Box flexDirection="column" gap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" flexWrap="wrap" gap="md">
        <Box flexDirection="row" alignItems="flex-end" gap="sm">
          <Text size="title" weight="semibold" tabular>{String(v.running.length)}</Text>
          <Text size="footnote" dimColor>{v.running.length === 1 ? 'agent active' : 'agents active'}</Text>
        </Box>
        {state.updateAvailable !== null && (
          <Button key="update" hotkey="u" variant="primary" onPress={act.update}>
            {`Update to ${state.updateAvailable}`}
          </Button>
        )}
      </Box>
      <Svg source={stateBar(counts)} alt="Share of agents in each state" width={240} height={6} />
      <Box flexDirection="row" gap="md" flexWrap="wrap">
        {counts
          .filter(c => c.n > 0 || c.text === 'running')
          .map(c => (
            <Text key={`count-${c.text}`} size="caption">
              <Text color={hexOf(c.color)}>● </Text>
              <Text weight="semibold" tabular>{String(c.n)}</Text>
              <Text dimColor>{` ${c.text}`}</Text>
            </Text>
          ))}
      </Box>
    </Box>
  )

  const row = (a: PanelAgent) => {
    const on = state.selected === a.id
    return (
      <Box
        key={`row-${a.id}`}
        flexDirection="row"
        alignItems="center"
        gap="sm"
        paddingX="sm"
        paddingY="xs"
        borderStyle="round"
        borderColor={on ? tint(HEX['claude'] ?? '#D97757', '55') : CLEAR}
        backgroundColor={on ? SELECTED : CLEAR}
        hover={{ backgroundColor: on ? SELECTED : HOVER }}
      >
        {Avatar(a)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box flexDirection="row" gap="xs" alignItems="center">
            <Button key={`agent-${a.id}`} plain onPress={() => act.select(a.id)}>
              <Text weight="semibold">{a.name}</Text>
            </Button>
            {a.ensemble !== undefined && <Text size="caption" dimColor>{`· ${a.ensemble}`}</Text>}
          </Box>
          <Text size="caption" wrap="truncate" {...(a.state === 'needs_approval' ? { color: 'permission' } : { dimColor: true })}>
            {v.isRunning(a) ? v.activityOf(a) : `${a.model} · ${v.ago(a.updated)} ago`}
          </Text>
        </Box>
        {Pill(a.state)}
      </Box>
    )
  }

  const card = (a: PanelAgent) => {
    const d = digest(state.detail)
    const pending = a.approval
    const calls = /(\d+) tool calls/.exec(d.stats)?.[1]
    const errors = /(\d+) errors/.exec(d.stats)?.[1]
    const stats = [
      { n: v.k(a.tokensIn), text: 'Tokens in' },
      { n: v.k(a.tokensOut), text: 'Tokens out' },
      ...(calls === undefined ? [] : [{ n: calls, text: 'Tool calls' }]),
      ...(errors === undefined || errors === '0' ? [] : [{ n: errors, text: 'Errors', color: 'error' }]),
    ]
    return (
      <Box key={`card-${a.id}`} flexDirection="column" gap="md" padding="md" {...surface}>
        <Box flexDirection="row" gap="sm" alignItems="center">
          {Avatar(a, 40)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text size="heading" weight="semibold">{a.name}</Text>
            <Text size="caption" dimColor wrap="truncate">
              {[a.backend, a.model, a.worktree === true ? 'worktree' : ''].filter(Boolean).join(' · ')}
            </Text>
          </Box>
          {Pill(a.state)}
        </Box>
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          {stats.map(s => (
            <Box key={`stat-${s.text}`} flexDirection="column" paddingX="sm" paddingY="xs" borderStyle="round" borderColor={CLEAR} backgroundColor={SURFACE} minWidth={72}>
              <Text weight="semibold" tabular {...('color' in s && s.color !== undefined ? { color: s.color } : {})}>{s.n}</Text>
              <Text size="caption" dimColor>{s.text}</Text>
            </Box>
          ))}
        </Box>
        {pending !== undefined && (
          <Box flexDirection="column" gap="sm" padding="sm" borderStyle="round" borderColor={tint(HEX['permission'] ?? '#4C8DF6', '55')} backgroundColor={tint(HEX['permission'] ?? '#4C8DF6', '14')}>
            <Text color="permission" weight="semibold">{`Waiting for approval: ${pending.tool}`}</Text>
            {pending.command !== '' && <Text mono size="footnote" wrap="wrap">{pending.command}</Text>}
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              <Button key="allow" hotkey="a" variant="primary" onPress={() => act.decide('allow')}>Allow</Button>
              <Button key="allow-session" hotkey="r" variant="secondary" onPress={() => act.decide('allow_for_session')}>Allow for session</Button>
              <Button key="deny" hotkey="d" variant="secondary" onPress={() => act.decide('deny')}>Deny</Button>
            </Box>
          </Box>
        )}
        {d.said !== '' && (
          <Box flexDirection="column" gap="xs">
            {label('Latest message')}
            <Markdown key={`said-${a.id}`} text={d.said} />
          </Box>
        )}
        {d.tools.length > 0 && (
          <Box flexDirection="column" gap="xs">
            {label('Recent tools')}
            {d.tools.map((t, i) => {
              const [tool, ...rest] = t.split(' ')
              return (
                <Text key={`t${i}`} size="footnote" wrap="truncate">
                  <Text mono weight="semibold">{tool ?? ''}</Text>
                  <Text mono dimColor>{rest.length > 0 ? ` ${rest.join(' ')}` : ''}</Text>
                </Text>
              )
            })}
          </Box>
        )}
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          {v.isRunning(a) && <Button key="stop" hotkey="s" variant="secondary" onPress={() => act.stop(a)}>Stop</Button>}
          <Button key="message" hotkey="m" variant="secondary" onPress={() => act.message(a)}>Message</Button>
          {a.worktree === true && <Button key="diff" hotkey="v" variant="secondary" onPress={() => act.diff(a)}>View diff</Button>}
          {!v.isRunning(a) && <Button key="cleanup" hotkey="w" plain dimColor onPress={() => act.cleanup(a)}>Clean worktree</Button>}
        </Box>
      </Box>
    )
  }

  const section = (title: string, agents: PanelAgent[]) =>
    agents.length === 0 ? null : (
      <Box key={`sec-${title}`} flexDirection="column" gap="xs">
        {label(title)}
        {agents.map(a => (
          <Box key={`g-${a.id}`} flexDirection="column" gap="xs">
            {row(a)}
            {!v.wide && state.selected === a.id && card(a)}
          </Box>
        ))}
      </Box>
    )

  const list = (
    <Box flexDirection="column" gap="md">
      {state.agents.length === 0 && (
        <Box flexDirection="column" gap="xs" padding="md" alignItems="center" {...surface}>
          <Text weight="semibold">No agents yet</Text>
          <Text size="caption" dimColor>Agents Claude spawns through subagent-mcp show up here.</Text>
        </Box>
      )}
      {section('Running', v.visible.filter(v.isRunning))}
      {section('Recent', v.visible.filter(a => !v.isRunning(a)))}
      {(v.hidden > 0 || state.showAll) && (
        <Box paddingX="sm">
          <Button key="all" hotkey="l" plain dimColor onPress={act.toggleAll}>
            {state.showAll ? 'Show recent only' : `Show ${v.hidden} older`}
          </Button>
        </Box>
      )}
    </Box>
  )

  const ensemble = (x: PanelEnsemble) => {
    const settled = x.members.filter(m => !['starting', 'running', 'needs_approval', 'queued', 'pending'].includes(m.state)).length
    return (
      <Box key={`ens-${x.id}`} flexDirection="column" gap="sm" padding="sm" {...surface}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Text weight="semibold">{x.name}</Text>
          <Text size="caption" dimColor>{`${x.status} · ${x.valid}/${x.of} valid`}</Text>
        </Box>
        <Progress label={`${x.name} members settled`} value={settled} max={Math.max(1, x.members.length)} valueText={`${settled} of ${x.members.length} settled`} color={HEX['claude'] ?? '#D97757'} />
        {x.members.map((m, i) => (
          <Box key={`m${i}`} flexDirection="row" alignItems="center" justifyContent="space-between" gap="sm">
            <Text size="footnote">
              <Text>{`${m.role}${m.name === undefined ? '' : ` (${m.name})`}`}</Text>
              {m.valid === true && <Text color="success">{' ✓'}</Text>}
              {m.valid === false && <Text color="error">{' ✗'}</Text>}
            </Text>
            {Pill(m.state)}
          </Box>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap="lg" padding="sm">
      {header}
      {state.message !== '' && (
        <Box paddingX="sm" paddingY="xs" borderStyle="round" borderColor={CLEAR} backgroundColor={problem ? tint(HEX['error'] ?? '#E5534B', '14') : SURFACE}>
          <Text size="footnote" wrap="wrap" {...(problem ? { color: 'error' } : { dimColor: true })}>{state.message}</Text>
        </Box>
      )}
      {v.wide ? (
        <Box flexDirection="row" gap="lg">
          <Box flexDirection="column" width="42%">{list}</Box>
          <Box flexDirection="column" flexGrow={1}>
            {v.selected === undefined ? <Text dimColor>Select an agent.</Text> : card(v.selected)}
          </Box>
        </Box>
      ) : (
        list
      )}
      {state.ensembles.length > 0 && (
        <Box flexDirection="column" gap="xs">
          {label('Ensembles')}
          {state.ensembles.map(ensemble)}
        </Box>
      )}
      <Box flexDirection="column" gap="xs">
        {label('Backends')}
        <Box flexDirection="row" columnGap="md" rowGap="xs" flexWrap="wrap">
          {v.backends.map((b, i) => {
            const off = state.disabled.includes(b)
            return (
              <Button key={`backend-${b}`} hotkey={String(i + 1)} plain dimColor={off} onPress={() => act.backend(b)}>
                <Text color={off ? hexOf('inactive') : backendHex(b)}>{off ? '○ ' : '● '}</Text>
                <Text size="footnote" strikethrough={off}>{b}</Text>
                {off && state.locked.includes(b) && <Text size="caption" dimColor> env</Text>}
              </Button>
            )
          })}
        </Box>
      </Box>
      <Box flexDirection="row" columnGap="md" flexWrap="wrap">
        <Button key="up" hotkey="k" plain dimColor onPress={() => act.move(-1)}>Previous</Button>
        <Button key="down" hotkey="j" plain dimColor onPress={() => act.move(1)}>Next</Button>
        {v.running.length > 0 && <Button key="stop-all" hotkey="x" plain dimColor onPress={act.stopAll}>Stop all</Button>}
        <Button key="init" hotkey="i" plain dimColor onPress={act.init}>Set up project</Button>
      </Box>
    </Box>
  )
}
