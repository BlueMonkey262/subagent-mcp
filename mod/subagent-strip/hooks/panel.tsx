// The /subagent-mcp control panel (see mod/subagent-strip/README.md). Reads the subagent-mcp server over
// MCP, acts only on keys the person presses, and hands `i` / `u` to Claude as prompts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { PanelAgent, PanelDiff, PanelEnsemble, PanelState } from '../types'
import { desktopPane } from './desktop'
import { BACKENDS, readDisabled, writeDisabled } from './policy'

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
    showAll: false,
    disabled: [],
    locked: [],
    ensembles: [],
    diff: null,
  } as PanelState,
  { shape: 'panel-4' },
)

const INIT_PROMPT =
  'Run the subagent-mcp setup interview for this project. Call list_models (live) and list_agent_configs, ' +
  'then use question menus to ask which backends to enable, which models go in the roster, which bundled ' +
  'agent configs to copy in, and whether to set disabledBackends / blockModels / blockClaudeModels. ' +
  'The subagent-mcp install (the checkout `subagent-mcp` on PATH links into) ships only templates: ' +
  '.subagents/*.md.example, .subagents/models.yaml.example and .agents/agents/*.md.example. ' +
  'Build this project\'s own .subagents/<name>.md, .subagents/models.yaml and, for Antigravity, ' +
  '.agents/agents/<name>.md from them (drop the .example suffix). ' +
  'If .subagents/models.yaml exists, propose edits as a diff, save models.yaml.bak, ' +
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
const RECENT = 5
const isRunning = (a: PanelAgent) => RUNNING.includes(a.state)
const OPEN_ENSEMBLE = ['launching', 'running', 'synthesizing']
// A server that predates get_dashboard answers with a protocol error naming the tool.
const DASHBOARD_RETRY_MS = 5 * 60_000
const MISSING_TOOL = /no connected MCP tool "get_dashboard"|get_dashboard.*(not found|unknown)|(not found|unknown).*get_dashboard/i

/** What a running agent is doing, in a few words: its open tool call, else what it last ran. */
export function activityOf(a: PanelAgent): string {
  if (a.state === 'needs_approval') return 'waiting for approval'
  if (a.activity !== undefined) return a.activity
  if (a.phase === 'thinking') return a.lastTool === undefined ? 'thinking' : `thinking, last ran ${a.lastTool}`
  return 'working'
}

// One glyph and theme color per state, so a row reads at a glance in every surface.
const STATUS: Record<string, { glyph: string; color: string; label: string }> = {
  running: { glyph: '●', color: 'claude', label: 'running' },
  starting: { glyph: '◌', color: 'claude', label: 'starting' },
  queued: { glyph: '◌', color: 'inactive', label: 'queued' },
  pending: { glyph: '◌', color: 'inactive', label: 'pending' },
  needs_approval: { glyph: '◆', color: 'permission', label: 'needs approval' },
  completed: { glyph: '✓', color: 'success', label: 'completed' },
  failed: { glyph: '✗', color: 'error', label: 'failed' },
  interrupted: { glyph: '■', color: 'warning', label: 'interrupted' },
}
export const statusOf = (state: string) => STATUS[state] ?? { glyph: '·', color: 'inactive', label: state.replace(/_/g, ' ') }

/** Splits a unified diff into one section per file (`diff --git` headers). */
export function splitDiff(patch: string): { path: string; patch: string }[] {
  const parts = patch.split(/^(?=diff --git )/m).filter(part => part.trim() !== '')
  return parts.map(part => ({ path: diffPath(part.slice(0, part.indexOf('\n') < 0 ? part.length : part.indexOf('\n'))) ?? '(diff)', patch: part }))
}

/** The b/ path of a `diff --git` header, unquoting the C-style quotes git puts on unusual names. */
function diffPath(header: string): string | undefined {
  const rest = header.startsWith('diff --git ') ? header.slice('diff --git '.length) : undefined
  if (rest === undefined) return undefined
  if (!rest.startsWith('"')) {
    const plain = /^a\/(.+?) b\/(.+)$/.exec(rest)
    return plain?.[2] ?? plain?.[1]
  }
  const first = unquote(rest, 0)
  if (first === undefined) return undefined
  const second = rest[first.end + 1] === '"' ? unquote(rest, first.end + 1)?.text : rest.slice(first.end + 1)
  const path = second ?? first.text
  return path.replace(/^[ab]\//, '')
}

/** Git's C-style quoted path starting at `start`: escapes, and octal bytes decoded as UTF-8. */
function unquote(text: string, start: number): { text: string; end: number } | undefined {
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' }
  let encoded = ''
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i]!
    if (char === '"') {
      try { return { text: decodeURIComponent(encoded), end: i + 1 } } catch { return undefined }
    }
    if (char !== '\\') { encoded += encodeURIComponent(char); continue }
    const next = text[i + 1] ?? ''
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4))
    if (octal) { encoded += `%${parseInt(octal[0], 8).toString(16).padStart(2, '0')}`; i += 3; continue }
    encoded += encodeURIComponent(simple[next] ?? next)
    i += 1
  }
  return undefined
}

function toAgent(a: Record<string, unknown>): PanelAgent {
  const usage = (a['cumulative_usage'] ?? {}) as Record<string, unknown>
  const role = a['ensemble_role']
  return {
    id: str(a['agent_id']),
    name: str(a['name']),
    backend: str(a['backend']),
    model: str(a['model']),
    state: str(a['state']),
    updated: str(a['updated_at']),
    tokensIn: num(usage['inputTokens']),
    tokensOut: num(usage['outputTokens']),
    ...(typeof a['current_activity'] === 'string' && a['current_activity'] !== '' ? { activity: a['current_activity'] } : {}),
    ...(typeof a['phase'] === 'string' ? { phase: a['phase'] } : {}),
    ...(typeof a['last_tool'] === 'string' && a['last_tool'] !== '' ? { lastTool: a['last_tool'] } : {}),
    ...(typeof a['worktree'] === 'object' && a['worktree'] !== null ? { worktree: true } : {}),
    ...(typeof role === 'string' ? { ensemble: role } : {}),
    ...(a['request_id'] === undefined || a['request_id'] === null
      ? {}
      : { approval: { requestId: str(a['request_id']), tool: str(a['tool_name']), command: str(a['command'] ?? JSON.stringify(a['input'] ?? '')).slice(0, 200) } }),
  }
}

function toEnsemble(e: Record<string, unknown>): PanelEnsemble {
  const members = Array.isArray(e['members']) ? (e['members'] as Record<string, unknown>[]) : []
  return {
    id: str(e['ensemble_id']),
    name: str(e['name'] ?? e['ensemble_id']),
    status: str(e['status']),
    valid: num(e['valid']),
    of: num(e['of']),
    members: members.map(m => ({
      role: str(m['role']),
      state: str(m['state']),
      ...(typeof m['name'] === 'string' ? { name: m['name'] } : {}),
      ...(typeof m['valid'] === 'boolean' ? { valid: m['valid'] } : {}),
    })),
  }
}

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

// The project the session started in. Relative $.fs paths follow the session's current directory, which a
// shell `cd` can move (into the mod folder, say), so project files are read by absolute path from here.
let projectDir = ''
const inProject = (path: string) => (projectDir === '' ? path : `${projectDir.replace(/\/$/, '')}/${path}`)

// The models.yaml the server loaded, from list_models. The server resolves it in one place
// (SUBAGENT_MCP_MODELS_FILE, then the project, then the install), so the panel never guesses:
// it edits exactly the file the resolver picked and says so if the server does not report one.
let serverModelsFile: string | undefined
const modelsFile = () => serverModelsFile
const sharedModelsFile = () => serverModelsFile !== undefined && projectDir !== '' && !serverModelsFile.startsWith(`${projectDir.replace(/\/$/, '')}/`)

function noteModelsFile(models: Record<string, unknown>) {
  const reported = models['models_file']
  if (typeof reported === 'string' && reported !== '') serverModelsFile = reported
}

/** Called from the one session.start hook in register.tsx. */
export function declarePanelCommand($: EngineInterface, cwd?: string) {
  if (cwd !== undefined && cwd !== '') projectDir = cwd
  return $.command.register({
    name: 'subagent-mcp',
    description: 'Open the subagent control panel (`widget` for the desktop app\'s small floating form)',
    argumentHint: '[widget]',
  })
}

// What the server refuses (list_models reports it, environment variables included) against what the
// project's models.yaml says; the difference is locked, because only the file can be edited here.
// Backends the server's environment disables (list_models `disabled_backends_env`); older servers don't say.
let envDisabled: string[] = []

async function loadPolicy($: EngineInterface) {
  let live: string[] = []
  let file: string[] = []
  try {
    const models = await callTool($, 'list_models')
    noteModelsFile(models)
    const policy = (models['model_policy'] ?? {}) as Record<string, unknown>
    live = ((policy['disabled_backends'] as unknown[] | undefined) ?? []).map(str)
    envDisabled = ((policy['disabled_backends_env'] as unknown[] | undefined) ?? []).map(str)
  } catch {
    // keep what the file says
  }
  try {
    const path = modelsFile()
    if (path !== undefined) file = readDisabled(await $.fs.read(path)) ?? []
  } catch {
    file = []
  }
  const disabled = [...new Set([...live, ...file])]
  // Locked: what the file alone can't turn on, because the environment disables it too.
  const locked = [...new Set([...envDisabled, ...disabled.filter(b => !file.includes(b))])]
  await update($, panel, s => ({ ...s, disabled, locked }))
}

export const registerPanel = (on: On) => {
  let timer: { cancel: () => void } | undefined
  // Bumped by every open and every hand-off; a late refresh checks it before reclaiming focus.
  let epoch = 0
  // Cleared when a server answers that it has no get_dashboard; list_agents serves until the retry.
  let dashboard = true
  let retryAt = 0
  // Which agent, in which state, the shown digest was fetched for.
  let fetched: { id: string; state: string } | undefined

  on('command.run', { command: 'subagent-mcp' }, async ($, e) => {
    const mine = ++epoch
    // `/subagent-mcp widget` asks the desktop app for the small floating form; other surfaces ignore it.
    const widget = e.args.trim() === 'widget'
    // Opening starts on the list, not a diff or question left from the last time the pane was open.
    await update($, panel, s => ({ ...s, diff: null, confirm: null }))
    const opened = await $.ui.open({ id: PANE, title: 'Subagents', closeOnEscape: true, rows: 16, ...(widget ? { placement: 'widget' as const } : { focus: true as const }) })

    const refresh = async () => {
      try {
        let rows: Record<string, unknown>[] | undefined
        let ensembles: PanelEnsemble[] = []
        if (!dashboard && Date.now() >= retryAt) dashboard = true
        if (dashboard) {
          try {
            // One read for agents, approvals and ensembles.
            const board = await callTool($, 'get_dashboard', { recent: 25 })
            if (Array.isArray(board['agents'])) {
              rows = board['agents'] as Record<string, unknown>[]
              ensembles = ((board['ensembles'] as Record<string, unknown>[] | undefined) ?? []).map(toEnsemble)
            }
          } catch (error) {
            if (!MISSING_TOOL.test(str((error as Error).message))) throw error
            dashboard = false
            retryAt = Date.now() + DASHBOARD_RETRY_MS
          }
        }
        if (rows === undefined) {
          const listed = await callTool($, 'list_agents', { limit: 30 })
          rows = (listed['agents'] as Record<string, unknown>[] | undefined) ?? []
        }
        const agents = rows.map(toAgent)
        // Running agents lead; the server's order (newest first) holds within each group.
        agents.sort((x, y) => Number(isRunning(y)) - Number(isRunning(x)))
        let latest: string | null = null
        try {
          const cache = JSON.parse(await $.fs.read(inProject('.subagents/memory/update.json'))) as { available?: boolean; latest?: string | null }
          latest = cache.available === true && typeof cache.latest === 'string' ? cache.latest : null
        } catch {
          latest = null
        }
        const before = await read($, panel)
        const selected = agents.some(a => a.id === before.selected) ? before.selected : (agents[0]?.id ?? null)
        let detail = before.detailFor === selected ? before.detail : []
        const chosen = agents.find(a => a.id === selected)
        // A settled agent's digest does not change: poll running ones, and fetch once more when the state moves.
        const stale = fetched === undefined || fetched.id !== selected || fetched.state !== chosen?.state
        if (selected !== null && (chosen === undefined || isRunning(chosen) || stale || before.detailFor !== selected || detail.length === 0)) {
          try {
            detail = digest(await callTool($, 'get_agent_events', { agent: selected, summary: true }))
            fetched = { id: selected, state: chosen?.state ?? '' }
          } catch {
            // keep the previous digest
          }
        }
        await update($, panel, s => ({
          ...s,
          agents,
          ensembles,
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

    void loadPolicy($)

    timer?.cancel()
    timer = $.clock.every(POLL_MS, refresh)
    // Running the command again while the pane is open reclaims the keys: the open above asks for focus,
    // and the ring is put on the selected row once the list is drawn. A refusal (text in the prompt, a
    // dialog up) is fine: the pane then shows its hint.
    void refresh().then(async () => {
      const state = await read($, panel)
      // Skip when the pane was closed or reopened meanwhile, or shows a confirmation or input (no agent row).
      if (mine === epoch && state.confirm === null && state.selected !== null) await $.ui.focus({ requestId: PANE, key: `agent-${state.selected}` }).catch(() => undefined)
    })

    return {
      text: opened.isPlaced ? 'Subagent panel opened.' : `Subagent panel is waiting: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Code } = $.ui.resolve(e)
    const state = await read($, panel)
    const selected = state.agents.find(a => a.id === state.selected)
    const running = state.agents.filter(isRunning)
    const openEnsembles = state.ensembles.filter(x => OPEN_ENSEMBLE.includes(x.status))
    const glyph = (s: string) => <Text color={statusOf(s).color}>{statusOf(s).glyph}</Text>

    // The desktop app's minimized form: a glance, no keys (clicks may not reach a widget).
    if (e.props.placement === 'widget') {
      const waiting = state.agents.filter(a => a.state === 'needs_approval').length
      return (
        <Box flexDirection="column">
          <Text bold>
            {running.length} running{waiting > 0 ? ` · ${waiting} need approval` : ''}{openEnsembles.length > 0 ? ` · ${openEnsembles.length} ensemble(s)` : ''}
          </Text>
          {running.slice(0, 4).map(a => (
            <Box key={`w-${a.id}`} gap={1}>
              {glyph(a.state)}
              <Text dimColor={a.state !== 'needs_approval'} wrap="truncate">{`${a.name}: ${activityOf(a)}`}</Text>
            </Box>
          ))}
          {openEnsembles.slice(0, 2).map(x => (
            <Box key={`we-${x.id}`} gap={1}>
              <Text color="subtle">◇</Text>
              <Text dimColor>{`${x.name}: ${x.members.filter(m => !RUNNING.includes(m.state) && m.state !== 'pending').length}/${x.members.length} settled`}</Text>
            </Box>
          ))}
          {running.length === 0 && state.message !== '' && <Text dimColor>{state.message}</Text>}
        </Box>
      )
    }
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

    // The setup and update flows run in the conversation, so the pane closes first: the person's attention
    // belongs to Claude's questions, not the panel.
    const handOff = async (text: string) => {
      await update($, panel, s => ({ ...s, confirm: null, message: '', at: Date.now() }))
      try {
        await $.ui.close({ id: PANE })
      } catch (error) {
        return say(`Could not close the panel: ${str((error as Error).message).slice(0, 80)}`)
      }
      timer?.cancel()
      epoch += 1
      try {
        await $.prompt.submit({ text })
      } catch (error) {
        $.ui.toast(`Could not send the prompt to Claude: ${str((error as Error).message).slice(0, 80)}`)
      }
    }

    const d = state.diff
    if (d !== null) {
      const section = d.sections[d.index]
      const page = (by: number) => update($, panel, s => (s.diff === null ? s : { ...s, diff: { ...s.diff, index: Math.min(s.diff.sections.length - 1, Math.max(0, s.diff.index + by)) } }))
      const back = () => update($, panel, s => ({ ...s, diff: null }))
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold>{`${d.agent} · changes`}</Text>
            <Text dimColor>{d.summary}</Text>
          </Box>
          {section === undefined ? (
            <Text dimColor>No changes.</Text>
          ) : (
            <Box flexDirection="column">
              <Box gap={1}>
                <Text color="suggestion" wrap="truncate-start">{section.path}</Text>
                <Text dimColor>{`(${d.index + 1}/${d.sections.length})${d.truncated ? ' · diff cut at the size limit' : ''}`}</Text>
              </Box>
              <Code key={`diff-${d.index}`} source={section.patch} path={section.path} format="diff" />
            </Box>
          )}
          <Box gap={2} flexWrap="wrap">
            <Button key="diff-back" hotkey="b" plain autoFocus onPress={back}>back</Button>
            <Button key="diff-prev" hotkey="k" plain dimColor={d.index === 0} onPress={() => page(-1)}>prev file</Button>
            <Button key="diff-next" hotkey="j" plain dimColor={d.index >= d.sections.length - 1} onPress={() => page(1)}>next file</Button>
          </Box>
        </Box>
      )
    }

    const c = state.confirm
    if (c !== null && c.kind === 'message') {
      const agent = c.agent
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} gap={1}>
          <Text bold>{`Message ${agent}`}</Text>
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
          <Box>
            <Button key="cancel" hotkey="n" plain dimColor onPress={() => say('Cancelled.')}>cancel</Button>
          </Box>
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
        await handOff(updatePrompt(c.latest))
      }
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={c.kind === 'update' ? 'suggestion' : 'warning'} paddingX={1} gap={1}>
          <Text bold>{question}</Text>
          {e.surface === 'desktop' ? (
            <Box gap="sm">
              <Button key="yes" hotkey="y" variant="primary" onPress={yes}>{c.kind === 'update' ? 'Update' : c.kind === 'cleanup' ? 'Remove' : 'Stop'}</Button>
              <Button key="no" hotkey="n" variant="secondary" onPress={() => say('Cancelled.')}>Cancel</Button>
            </Box>
          ) : (
            <Box gap={2}>
              <Button key="yes" hotkey="y" plain onPress={yes}>yes</Button>
              <Button key="no" hotkey="n" plain onPress={() => say('Cancelled.')}>no</Button>
            </Box>
          )}
        </Box>
      )
    }

    const wide = e.props.placement === 'dock' && e.props.bodyColumns >= 90
    const select = (id: string) => update($, panel, s => ({ ...s, selected: id, detail: [], detailFor: id }))
    // Running agents and the most recent finished ones; the selected agent always stays in view.
    let finished = 0
    const visible = state.showAll
      ? state.agents
      : state.agents.filter(a => isRunning(a) || a.id === state.selected || ++finished <= RECENT)
    const hidden = state.agents.length - visible.length
    const at = visible.findIndex(a => a.id === state.selected)
    const move = (by: number) => {
      const next = visible[Math.min(visible.length - 1, Math.max(0, at + by))]
      return next === undefined ? undefined : select(next.id)
    }
    const pending = selected?.approval
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
    const showDiff = async (agent: PanelAgent) => {
      try {
        const body = await callTool($, 'get_agent_diff', { agent: agent.id, max_chars: 60000 })
        const files = Array.isArray(body['files']) ? (body['files'] as Record<string, unknown>[]) : []
        const diff: PanelDiff = {
          agent: agent.name,
          summary: `${files.length} file(s), +${num(body['insertions'])} -${num(body['deletions'])} on ${str(body['branch'])}`,
          sections: splitDiff(str(body['patch'])),
          index: 0,
          truncated: body['truncated'] === true,
        }
        await update($, panel, s => ({ ...s, diff, confirm: null }))
      } catch (error) {
        await say(`Diff failed: ${str((error as Error).message).slice(0, 100)}`)
      }
    }
    const toggle = async (backend: string) => {
      try {
        if (serverModelsFile === undefined) noteModelsFile(await callTool($, 'list_models').catch(() => ({})))
        const path = modelsFile()
        if (path === undefined) return say('The server did not report which models.yaml it loaded; reconnect subagent-mcp and try again')
        const text = await $.fs.read(path)
        const now = readDisabled(text)
        if (now === null) return say('disabledBackends in models.yaml is not a one-line list; edit it by hand')
        // The file is the truth for what it lists: a backend it disables can always be turned back on here.
        if (!now.includes(backend) && state.locked.includes(backend)) return say(`${backend} is disabled by an environment variable; change it where the server starts`)
        const next = now.includes(backend) ? now.filter(b => b !== backend) : [...now, backend]
        const edit = writeDisabled(text, next)
        if (!edit.ok) return say(edit.reason)
        await $.fs.write(`${path}.bak`, text)
        await $.fs.write(path, edit.text)
        // Show the file's new list now; the server reloads models.yaml a moment after the write, so asking it
        // straight away would still report the old list (and mark the backend env-locked). Ask again shortly.
        await update($, panel, s => {
          const locked = s.locked.filter(b => b !== backend || envDisabled.includes(backend))
          return { ...s, disabled: [...new Set([...next, ...locked])], locked }
        })
        $.clock.after(1500, () => loadPolicy($))
        if (!next.includes(backend) && envDisabled.includes(backend)) {
          return say(`${backend} removed from models.yaml, but the environment still disables it; change it where the server starts`)
        }
        const where = sharedModelsFile() ? `the ${path} the server resolved for projects without their own; i gives this one its own` : 'models.yaml reloads live'
        await say(`${backend} ${next.includes(backend) ? 'disabled' : 'enabled'} (${where}; previous copy in models.yaml.bak)`)
      } catch (error) {
        await say(`Could not change ${modelsFile() ?? 'models.yaml'}: ${str((error as Error).message).slice(0, 80)} (run i to give this project its own .subagents/models.yaml)`)
      }
    }

    if (e.surface === 'desktop') {
      return desktopPane($.ui.resolve(e), {
        state,
        visible,
        hidden,
        selected,
        running,
        wide,
        backends: BACKENDS,
        isRunning,
        activityOf,
        statusOf,
        k,
        ago,
        act: {
          select,
          move,
          decide,
          stop: a => ask({ kind: 'stop', agent: a.name }),
          stopAll: () => ask({ kind: 'stopAll', names: running.map(a => a.name) }),
          message: a => ask({ kind: 'message', agent: a.name }),
          diff: showDiff,
          cleanup: a => ask({ kind: 'cleanup', agent: a.name }),
          init: () => handOff(INIT_PROMPT),
          update: () => ask({ kind: 'update', latest: state.updateAvailable ?? '' }),
          toggleAll: () => update($, panel, s => ({ ...s, showAll: !s.showAll })),
          backend: toggle,
        },
      })
    }

    const heading = (text: string) => <Text bold dimColor size="caption">{text}</Text>

    // One line per agent: marker, state glyph, name, then who runs it and how long ago it moved.
    const row = (a: PanelAgent) => {
      const isSelected = state.selected === a.id
      const meta = [a.ensemble === undefined ? '' : a.ensemble, a.backend, a.model, ago(a.updated)].filter(Boolean).join(' · ')
      return (
        <Button key={`agent-${a.id}`} plain onPress={() => select(a.id)}>
          <Text color="claude">{isSelected ? '▸ ' : '  '}</Text>
          {glyph(a.state)}
          <Text bold={isSelected}>{` ${a.name}`}</Text>
          <Text dimColor>{`  ${meta}`}</Text>
        </Button>
      )
    }

    // The digest from get_agent_events: a stats line, then recent tools ("  tool target"), then "> message".
    const header = state.detail[0]?.replace(/^[^:]*:\s*[^,]*,\s*/, '') ?? ''
    const tools = state.detail.slice(1).filter(l => l.startsWith('  ')).map(l => l.trim())
    const said = state.detail.find(l => l.startsWith('> '))?.slice(2) ?? ''

    const card = (a: PanelAgent) => (
      <Box key={`card-${a.id}`} flexDirection="column" borderStyle="round" borderColor={pending === undefined ? 'subtle' : 'permission'} paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold>{a.name}</Text>
            <Text color={statusOf(a.state).color}>{`${statusOf(a.state).glyph} ${statusOf(a.state).label}`}</Text>
          </Box>
          <Text dimColor wrap="truncate">
            {[`${a.backend} · ${a.model}`, `${k(a.tokensIn)} in / ${k(a.tokensOut)} out`, header, a.worktree === true ? 'worktree' : ''].filter(Boolean).join(' · ')}
          </Text>
        </Box>
        {pending !== undefined && (
          <Box flexDirection="column">
            <Text color="permission">{`Waiting for approval: ${pending.tool} ${pending.command}`}</Text>
            <Box gap={2} flexWrap="wrap">
              <Button key="allow" hotkey="a" plain onPress={() => decide('allow')}>allow</Button>
              <Button key="allow-session" hotkey="r" plain onPress={() => decide('allow_for_session')}>allow for session</Button>
              <Button key="deny" hotkey="d" plain onPress={() => decide('deny')}>deny</Button>
            </Box>
          </Box>
        )}
        {tools.length > 0 && (
          <Box flexDirection="column">
            {heading('RECENT TOOLS')}
            {tools.map((t, i) => (
              <Text key={`t${i}`} wrap="truncate">
                <Text color="subtle">{'› '}</Text>
                <Text mono>{t}</Text>
              </Text>
            ))}
          </Box>
        )}
        {said !== '' && <Text italic dimColor>{`“${said}”`}</Text>}
        <Box gap={2} flexWrap="wrap">
          {isRunning(a) && <Button key="stop" hotkey="s" plain onPress={() => ask({ kind: 'stop', agent: a.name })}>stop</Button>}
          <Button key="message" hotkey="m" plain onPress={() => ask({ kind: 'message', agent: a.name })}>message</Button>
          {a.worktree === true && <Button key="diff" hotkey="v" plain onPress={() => showDiff(a)}>diff</Button>}
          {!isRunning(a) && <Button key="cleanup" hotkey="w" plain dimColor onPress={() => ask({ kind: 'cleanup', agent: a.name })}>clean worktree</Button>}
        </Box>
      </Box>
    )

    const group = (title: string, agents: PanelAgent[]) =>
      agents.length === 0 ? null : (
        <Box key={`grp-${title}`} flexDirection="column">
          {heading(title)}
          {agents.map(a => (
            <Box key={`g-${a.id}`} flexDirection="column">
              {row(a)}
              {isRunning(a) && (
                <Box paddingLeft={4}>
                  <Text color={a.state === 'needs_approval' ? 'permission' : undefined} dimColor={a.state !== 'needs_approval'} wrap="truncate">{activityOf(a)}</Text>
                </Box>
              )}
              {!wide && state.selected === a.id && <Box paddingLeft={2} marginY={1}>{card(a)}</Box>}
            </Box>
          ))}
        </Box>
      )

    // Inline, the pane shows a window over the tree, so the selected agent's card opens right under its row;
    // docked wide, the card has its own column.
    const list = (
      <Box flexDirection="column" gap={1}>
        {state.agents.length === 0 && <Text dimColor>No agents yet. Spawned agents show up here.</Text>}
        {group('RUNNING', visible.filter(isRunning))}
        {group('RECENT', visible.filter(a => !isRunning(a)))}
        {(hidden > 0 || state.showAll) && (
          <Box>
            <Button key="all" hotkey="l" plain dimColor onPress={() => update($, panel, s => ({ ...s, showAll: !s.showAll }))}>
              {state.showAll ? 'show recent only' : `show ${hidden} older`}
            </Button>
          </Box>
        )}
      </Box>
    )

    const ensembleBlock = state.ensembles.length === 0 ? null : (
      <Box flexDirection="column">
        {heading('ENSEMBLES')}
        {state.ensembles.map(x => (
          <Box key={`ens-${x.id}`} flexDirection="column">
            <Box gap={1}>
              <Text color="subtle">◇</Text>
              <Text bold>{x.name}</Text>
              <Text dimColor>{`${x.status} · ${x.valid}/${x.of} valid`}</Text>
            </Box>
            {x.members.map((m, i) => (
              <Box key={`m${i}`} paddingLeft={2} gap={1}>
                {glyph(m.state)}
                <Text>{`${m.role}${m.name === undefined ? '' : ` (${m.name})`}`}</Text>
                <Text dimColor>{statusOf(m.state).label}</Text>
                {m.valid === true && <Text color="success">valid</Text>}
                {m.valid === false && <Text color="error">invalid</Text>}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )

    const waiting = state.agents.filter(a => a.state === 'needs_approval').length
    const done = state.agents.filter(a => a.state === 'completed').length
    const failed = state.agents.filter(a => a.state === 'failed').length
    const problem = state.message.startsWith('subagent-mcp is not') || / failed|Could not/.test(state.message)

    return (
      <Box flexDirection="column" gap={1}>
        {!e.props.isFocused && <Text color="warning">Keys go to the chat. Run /subagent-mcp again to use the panel.</Text>}
        <Box justifyContent="space-between" flexWrap="wrap" columnGap={2}>
          <Box gap={2}>
            <Text>
              <Text color="claude">●</Text>
              {` ${running.length - waiting} running`}
            </Text>
            {waiting > 0 && (
              <Text color="permission">{`◆ ${waiting} waiting`}</Text>
            )}
            <Text dimColor>
              <Text color="success">✓</Text>
              {` ${done} done`}
            </Text>
            {failed > 0 && <Text color="error">{`✗ ${failed} failed`}</Text>}
          </Box>
          {state.updateAvailable !== null && (
            <Button key="update" hotkey="u" plain onPress={() => ask({ kind: 'update', latest: state.updateAvailable ?? '' })}>
              {`update to ${state.updateAvailable}`}
            </Button>
          )}
        </Box>
        {state.message !== '' && (
          <Text color={problem ? 'error' : undefined} dimColor={!problem} wrap="wrap">{state.message}</Text>
        )}
        {wide ? (
          <Box gap={2}>
            <Box flexDirection="column" width={Math.floor(e.props.bodyColumns * 0.45)}>{list}</Box>
            <Box flexDirection="column" flexGrow={1}>
              {selected === undefined ? <Text dimColor>Select an agent.</Text> : card(selected)}
            </Box>
          </Box>
        ) : (
          list
        )}
        {ensembleBlock}
        <Box flexDirection="column">
          <Text bold dimColor size="caption">BACKENDS</Text>
          <Box columnGap={2} flexWrap="wrap">
            {BACKENDS.map((b, i) => {
              const off = state.disabled.includes(b)
              return (
                <Button key={`backend-${b}`} hotkey={String(i + 1)} plain dimColor={off} onPress={() => toggle(b)}>
                  <Text color={off ? 'inactive' : 'success'}>{off ? '○ ' : '● '}</Text>
                  <Text strikethrough={off}>{b}</Text>
                  {off && <Text dimColor>{state.locked.includes(b) ? ' off (env)' : ' off'}</Text>}
                </Button>
              )
            })}
          </Box>
        </Box>
        <Box columnGap={2} flexWrap="wrap">
          <Button key="down" hotkey="j" plain dimColor onPress={() => move(1)}>next</Button>
          <Button key="up" hotkey="k" plain dimColor onPress={() => move(-1)}>prev</Button>
          {running.length > 0 && (
            <Button key="stop-all" hotkey="x" plain dimColor onPress={() => ask({ kind: 'stopAll', names: running.map(a => a.name) })}>stop all</Button>
          )}
          <Button key="init" hotkey="i" plain dimColor onPress={() => handOff(INIT_PROMPT)}>init</Button>
        </Box>
      </Box>
    )
  })
}
