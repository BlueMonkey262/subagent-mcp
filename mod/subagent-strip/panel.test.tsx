import { expect, mock, test } from 'claude-code/testing'

import { snapshotOf, transitions } from './hooks/notes'
import { activityOf, splitDiff } from './hooks/panel'
import { readDisabled, writeDisabled } from './hooks/policy'

const PANE = {
  plugin: 'subagent-strip',
  component: 'Pane',
  requestId: 'subagent-mcp',
  surface: 'terminal',
  props: {
    title: 'Subagents',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const agent = (over: Record<string, unknown>) => ({
  agent_id: 'id-' + String(over['name']),
  backend: 'claude',
  model: 'claude-haiku-5-5',
  state: 'running',
  updated_at: new Date().toISOString(),
  cumulative_usage: { inputTokens: 1, outputTokens: 2 },
  ...over,
})

// Answers the server calls the panel makes and records them.
const server = (on: Parameters<Parameters<typeof test>[1]>[1], agents: Record<string, unknown>[], update: unknown = {}) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const body = e.tool === 'list_agents' ? { agents } : {}
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body } }
  })
  on('command.register', () => ({ value: { command: 'subagent-mcp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: typeof update === 'string' ? update : JSON.stringify(update) }))
  return calls
}

const open = async ($: any) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'subagent-mcp', args: '' })
}

test('a pending approval shows its details and allow resolves it', async ($, on) => {
  const calls = server(on, [agent({ name: 'Ada', state: 'needs_approval', request_id: 'req-1', tool_name: 'Bash', command: 'rm -rf build' })])
  await open($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Waiting for approval: Bash rm -rf build/ })).toBeTruthy()

  await ui.press({ key: 'allow' })
  expect(calls.filter(c => c.tool === 'resolve_approval')).toEqual([{ tool: 'resolve_approval', args: { request_id: 'req-1', decision: 'allow' } }])
  await ui.unmount()
})

test('r allows for the session and d denies', async ($, on) => {
  const calls = server(on, [agent({ name: 'Ada', state: 'needs_approval', request_id: 'req-2', tool_name: 'Write', command: '' })])
  await open($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'allow-session' })
  await ui.press({ key: 'deny' })
  expect(calls.filter(c => c.tool === 'resolve_approval').map(c => c.args)).toEqual([
    { request_id: 'req-2', decision: 'allow_for_session' },
    { request_id: 'req-2', decision: 'deny' },
  ])
  await ui.unmount()
})

test('stop asks first and only a yes stops the agent', async ($, on) => {
  const calls = server(on, [agent({ name: 'Ada' })])
  await open($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'stop' })
  expect(await ui.find({ type: 'Text', text: /Stop Ada\?/ })).toBeTruthy()
  expect(calls.some(c => c.tool === 'stop_agent')).toBe(false)

  await ui.press({ key: 'yes' })
  expect(calls.filter(c => c.tool === 'stop_agent').map(c => c.args)).toEqual([{ agent: 'Ada' }])
  await ui.unmount()
})

test('no approval buttons without a pending approval', async ($, on) => {
  server(on, [agent({ name: 'Ada' })])
  await open($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'allow' })).toBeFalsy()
  expect(await ui.find({ key: 'deny' })).toBeFalsy()
  await ui.unmount()
})

test('message sends the typed text to the selected agent in the background', async ($, on) => {
  const calls = server(on, [agent({ name: 'Ada', state: 'completed' })])
  await open($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'message' })
  await ui.input({ plugin: 'subagent-strip', key: 'message', text: 'continue please' })
  expect(calls.filter(c => c.tool === 'send_message').map(c => c.args)).toEqual([
    { agent: 'Ada', prompt: 'continue please', run_in_background: true },
  ])
  await ui.unmount()
})

test('init closes the pane, then hands the interview prompt to Claude', async ($, on) => {
  server(on, [agent({ name: 'Ada', state: 'completed' })])
  const order: string[] = []
  on('ui.close', () => {
    order.push('close')
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    order.push('submit:' + String((e as { text?: string }).text).slice(0, 12))
    return { text: String((e as { text?: string }).text) }
  })
  await open($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'init' })
  expect(order).toEqual(['close', 'submit:Run the suba'])
  await ui.unmount()
})

const UPDATE = { available: true, latest: '9.9.9' }

test('update asks first, then closes the pane and submits, leaving no stale confirmation', async ($, on) => {
  server(on, [agent({ name: 'Ada', state: 'completed' })], UPDATE)
  const order: string[] = []
  on('ui.close', () => (order.push('close'), { value: undefined }))
  on('prompt.submit', (_, e) => (order.push('submit'), { text: String((e as { text?: string }).text) }))
  await open($)

  let ui = await $.ui.mount(PANE)
  await ui.press({ key: 'update' })
  expect(await ui.find({ type: 'Text', text: /Update to 9\.9\.9\?/ })).toBeTruthy()
  expect(order).toEqual([])

  await ui.press({ key: 'yes' })
  expect(order).toEqual(['close', 'submit'])
  await ui.unmount()

  // Reopened, the pane shows the list again, not the old question.
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Update to 9\.9\.9\?/ })).toBeFalsy()
  expect(await ui.find({ key: 'message' })).toBeTruthy()
  await ui.unmount()
})

test('a failed prompt submit is reported as a toast', async ($, on) => {
  server(on, [agent({ name: 'Ada', state: 'completed' })])
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(String((e as { text?: string }).text)), { value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', () => {
    throw new Error('no composer')
  })
  await open($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'init' })
  expect(toasts.join(' ')).toMatch(/Could not send the prompt to Claude/)
  await ui.unmount()
})

test('the pane says so when it does not hold the keys', async ($, on) => {
  server(on, [agent({ name: 'Ada', state: 'completed' })])
  await open($)

  const unfocused = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false } })
  expect(await unfocused.find({ type: 'Text', text: /Keys go to the chat/ })).toBeTruthy()
  await unfocused.unmount()

  const focused = await $.ui.mount(PANE)
  expect(await focused.find({ type: 'Text', text: /Keys go to the chat/ })).toBeFalsy()
  await focused.unmount()
})

const YAML = `# comment kept
# disabledBackends: [antigravity]

models:
  claude:
    - name: a
`

test('running agents lead and show what they are doing; older finished ones are folded', async ($, on) => {
  const done = Array.from({ length: 8 }, (_, i) => agent({ name: `Old${i}`, state: 'completed' }))
  server(on, [...done, agent({ name: 'Busy', state: 'running', current_activity: 'Bash npm test' })])
  await open($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Bash npm test/ })).toBeTruthy()
  expect(await ui.find({ key: 'agent-id-Old4' })).toBeTruthy()
  expect(await ui.find({ key: 'agent-id-Old5' })).toBeFalsy()

  await ui.press({ key: 'all' })
  expect(await ui.find({ key: 'agent-id-Old7' })).toBeTruthy()
  await ui.unmount()
})

test('a backend key rewrites only the disabledBackends line and keeps a copy', async ($, on) => {
  server(on, [agent({ name: 'Ada', state: 'completed' })], YAML)
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_, e) => (writes.push({ path: String((e as { path?: string }).path), text: String((e as { text?: string }).text) }), { value: undefined }))
  await open($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'backend-cursor' })
  const main = writes.find(w => w.path.endsWith('models.yaml'))
  expect(writes.some(w => w.path.endsWith('models.yaml.bak') && w.text === YAML)).toBe(true)
  expect(main?.text).toContain('disabledBackends: [cursor]')
  expect(main?.text).toContain('# comment kept')
  expect(main?.text).toContain('# disabledBackends: [antigravity]')
  await ui.unmount()
})

test('the line editor handles lists, empty lists and what it will not touch', () => {
  expect(readDisabled(YAML)).toEqual([])
  expect(readDisabled('disabledBackends: [cursor, "codex"] # why\nmodels:\n')).toEqual(['cursor', 'codex'])
  expect(readDisabled('disabledBackends:\n  - cursor\nmodels:\n')).toBeNull()
  const on = writeDisabled('disabledBackends: [cursor]\nmodels:\n', ['cursor', 'codex'])
  expect(on).toEqual({ ok: true, text: 'disabledBackends: [cursor, codex]\nmodels:\n' })
  expect(writeDisabled('disabledBackends:\n  - cursor\nmodels:\n', []).ok).toBe(false)
  expect(writeDisabled('nothing here', ['cursor']).ok).toBe(false)
})

// A server with get_dashboard: one read carries agents and ensembles.
const dashboardServer = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  board: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const body = e.tool === 'get_dashboard' ? { revision: 'r1', approvals: [], concurrency: {}, ...board } : (extra[e.tool] ?? {})
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body } }
  })
  on('command.register', () => ({ value: { command: 'subagent-mcp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: '{}' }))
  return calls
}

const ENSEMBLE = {
  ensemble_id: 'ens-1', name: 'review', status: 'running', valid: 1, of: 2,
  members: [{ role: 'glm', name: 'Pan', state: 'completed', valid: true }, { role: 'deepseek', name: 'Kolmogorov', state: 'running' }],
}

test('with get_dashboard the panel reads agents and ensembles in one call and says what a thinking agent last ran', async ($, on) => {
  const calls = dashboardServer(on, {
    agents: [agent({ name: 'Kolmogorov', state: 'running', phase: 'thinking', last_tool: 'shell git diff', ensemble_id: 'ens-1', ensemble_role: 'deepseek' })],
    ensembles: [ENSEMBLE],
  })
  await open($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /thinking, last ran shell git diff/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Ensembles/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /glm \(Pan\): completed ✓ · deepseek \(Kolmogorov\): running/ })).toBeTruthy()
  expect(calls.some(c => c.tool === 'list_agents')).toBe(false)
  await ui.unmount()
})

test('a server without get_dashboard falls back to list_agents', async ($, on) => {
  const calls: string[] = []
  on('mcp.call', (_, e) => {
    calls.push(e.tool)
    if (e.tool === 'get_dashboard') return { value: { isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool get_dashboard not found' }] } }
    const body = e.tool === 'list_agents' ? { agents: [agent({ name: 'Ada', state: 'completed' })] } : {}
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body } }
  })
  on('command.register', () => ({ value: { command: 'subagent-mcp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: '{}' }))
  await open($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'agent-id-Ada' })).toBeTruthy()
  expect(calls).toContain('list_agents')
  await ui.unmount()
})

const PATCH = [
  'diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1,2 @@', ' one', '+two', '',
].join('\n') + [
  'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+fresh', '',
].join('\n')

test('v shows the selected agent\'s worktree diff one file at a time, and b goes back', async ($, on) => {
  const calls = dashboardServer(
    on,
    { agents: [agent({ name: 'Ada', state: 'completed', worktree: { path: '/w', branch: 'subagent/x' } })], ensembles: [] },
    { get_agent_diff: { branch: 'subagent/x', insertions: 2, deletions: 0, files: [{ path: 'a.txt' }, { path: 'new.txt' }], patch: PATCH, truncated: false } },
  )
  await open($)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'diff' })
  expect(calls.filter(c => c.tool === 'get_agent_diff').map(c => c.args['agent'])).toEqual(['id-Ada'])
  expect(await ui.find({ type: 'Text', text: /2 file\(s\), \+2 -0 on subagent\/x/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /a\.txt \(1\/2\)/ })).toBeTruthy()
  await ui.press({ key: 'diff-next' })
  expect(await ui.find({ type: 'Text', text: /new\.txt \(2\/2\)/ })).toBeTruthy()
  await ui.press({ key: 'diff-back' })
  expect(await ui.find({ key: 'agent-id-Ada' })).toBeTruthy()
  await ui.unmount()
})

test('no diff key for an agent without a worktree', async ($, on) => {
  dashboardServer(on, { agents: [agent({ name: 'Ada', state: 'completed' })], ensembles: [] })
  await open($)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'diff' })).toBeFalsy()
  await ui.unmount()
})

test('as a desktop widget the pane is a glance: counts and what each running agent is doing', async ($, on) => {
  dashboardServer(on, {
    agents: [
      agent({ name: 'Ada', state: 'running', current_activity: 'read src/host.ts' }),
      agent({ name: 'Bo', state: 'needs_approval', request_id: 'r', tool_name: 'Bash', command: 'ls' }),
    ],
    ensembles: [ENSEMBLE],
  })
  await open($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, placement: 'widget' } })
    expect(await ui.find({ type: 'Text', text: /2 running · 1 need approval · 1 ensemble/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Ada: read src\/host\.ts/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /review: 1\/2 settled/ })).toBeTruthy()
    expect(await ui.find({ key: 'allow' })).toBeFalsy()
    await ui.unmount()
  }
})

test('/subagent-mcp widget asks for the widget placement', async ($, on) => {
  const opens: Record<string, unknown>[] = []
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '{"agents":[],"ensembles":[]}' }] } }))
  on('command.register', () => ({ value: { command: 'subagent-mcp' } }))
  on('ui.open', (_, e) => (opens.push(e as Record<string, unknown>), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: '{}' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'subagent-mcp', args: 'widget' })
  expect(opens.at(-1)?.['placement']).toBe('widget')
  expect(opens.at(-1)?.['focus']).toBeUndefined()
  // Let the first refresh settle before the test ends.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect(await ui.find({ type: 'Text', text: /0 running/ })).toBeTruthy()
  await ui.unmount()
})

test('toast lines: approvals, finished agents, finished ensembles; members only through their ensemble', () => {
  const before = snapshotOf(
    [
      { agent_id: 'a', name: 'Ada', state: 'running', backend: 'codex', model: 'm' },
      { agent_id: 'b', name: 'Bo', state: 'running' },
      { agent_id: 'c', name: 'Cy', state: 'running', ensemble_id: 'ens-1' },
    ],
    [{ ensemble_id: 'ens-1', name: 'review', status: 'running', valid: 0, of: 2 }],
  )
  const after = snapshotOf(
    [
      { agent_id: 'a', name: 'Ada', state: 'completed', backend: 'codex', model: 'm' },
      { agent_id: 'b', name: 'Bo', state: 'needs_approval', tool_name: 'Bash', command: 'npm test' },
      { agent_id: 'c', name: 'Cy', state: 'completed', ensemble_id: 'ens-1' },
    ],
    [{ ensemble_id: 'ens-1', name: 'review', status: 'completed', valid: 2, of: 2 }],
  )
  expect(transitions(undefined, after)).toEqual([])
  expect(transitions(before, after)).toEqual([
    'Ada finished (codex m)',
    'Bo needs approval: Bash npm test (/subagent-mcp to answer)',
    'Ensemble review completed: 2/2 valid',
  ])
  expect(transitions(after, after)).toEqual([])
})

test('splitDiff and activityOf', () => {
  expect(splitDiff(PATCH).map(s => s.path)).toEqual(['a.txt', 'new.txt'])
  expect(splitDiff('')).toEqual([])
  const base = { id: 'x', name: 'x', backend: 'b', model: 'm', updated: '', tokensIn: 0, tokensOut: 0 }
  expect(activityOf({ ...base, state: 'running', phase: 'tool', activity: 'read a.ts' })).toBe('read a.ts')
  expect(activityOf({ ...base, state: 'running', phase: 'thinking' })).toBe('thinking')
  expect(activityOf({ ...base, state: 'needs_approval', phase: 'approval' })).toBe('waiting for approval')
})

test('the digest is fetched again when the selected agent settles, then left alone', async ($, on) => {
  const clock = mock.clock(on)
  let state = 'running'
  const digests: string[] = []
  on('mcp.call', (_, e) => {
    if (e.tool === 'get_agent_events') digests.push(state)
    const body =
      e.tool === 'get_dashboard' ? { revision: state, agents: [agent({ name: 'Ada', state })], ensembles: [] }
      : e.tool === 'get_agent_events' ? { name: 'Ada', state, latest_message: state === 'running' ? 'working on it' : 'all done' }
      : {}
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body } }
  })
  on('command.register', () => ({ value: { command: 'subagent-mcp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: '{}' }))
  await open($)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /working on it/ })).toBeTruthy()
  state = 'completed'
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /all done/ })).toBeTruthy()
  const settled = digests.filter(d => d === 'completed').length
  await clock.advance(2000)
  await clock.advance(2000)
  expect(digests.filter(d => d === 'completed').length).toBe(settled)
  await ui.unmount()
})
