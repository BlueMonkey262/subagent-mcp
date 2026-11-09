import { expect, test } from 'claude-code/testing'

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
const server = (on: Parameters<Parameters<typeof test>[1]>[1], agents: Record<string, unknown>[]) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const body = e.tool === 'list_agents' ? { agents } : {}
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body } }
  })
  on('command.register', () => ({ value: { command: 'subagent-mcp' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: '{}' }))
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
