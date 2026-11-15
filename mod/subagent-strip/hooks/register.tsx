import type { Register } from 'claude-code'

import { type Row, type Snapshot, snapshotOf, transitions } from './notes'
import { declarePanelCommand, registerPanel } from './panel'

const LIVE = ['starting', 'running', 'needs_approval']
const ACTIVE_MS = 2000
const DORMANT_MS = 60000
const FAILURES_BEFORE_DORMANT = 3
const SERVER = 'subagent-mcp'
// get_dashboard is for this poller and the panel; the model keeps list_agents and get_ensemble.
const HIDDEN_TOOLS = [`mcp__${SERVER}__get_dashboard`]
const MISSING_TOOL = /get_dashboard.*(not found|unknown)|(not found|unknown).*get_dashboard/i

type Call = { isError?: boolean; structuredContent?: unknown; content: { type: string; text?: string }[] }

const parse = (result: Call): Row => {
  if (result.structuredContent !== undefined) return result.structuredContent as Row
  return JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}') as Row
}

export const register: Register = (on, options) => {
  const toasts = (options as { toasts?: unknown }).toasts !== false
  registerPanel(on)

  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    return listed.value === undefined ? listed : { value: listed.value.filter(t => !HIDDEN_TOOLS.includes(t.name)) }
  })

  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await declarePanelCommand($)
    // /clear gives the session a new id without a new session.start, so the path is resolved on every write
    // one file per session under <mod>/live, next to the status line script, so sessions never overwrite each other
    const root = $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
    const out = async () => `${root}/live/${await $.session.id()}.json`

    let failures = 0
    let dormant = false
    let timer: { cancel: () => void } | undefined
    // get_dashboard answers { unchanged } while nothing moved; a server that predates it gets list_agents.
    let revision: string | undefined
    let dashboard = true
    let last: Snapshot | undefined

    const schedule = (ms: number) => {
      timer?.cancel()
      timer = $.clock.every(ms, poll)
    }

    const read = async (): Promise<Snapshot> => {
      if (dashboard) {
        let result: Call | undefined
        try {
          result = (await $.mcp.call(SERVER, 'get_dashboard', revision === undefined ? {} : { since: revision })) as Call
        } catch (error) {
          // An older server answers an unknown tool with a protocol error naming it.
          if (!MISSING_TOOL.test(String((error as Error)?.message ?? error))) throw error
        }
        if (result !== undefined && !result.isError) {
          const body = parse(result)
          revision = typeof body['revision'] === 'string' ? body['revision'] : undefined
          if (body['unchanged'] === true && last !== undefined) return last
          return snapshotOf((body['agents'] as Row[] | undefined) ?? [], (body['ensembles'] as Row[] | undefined) ?? [])
        }
        const text = result?.content.find(c => c.type === 'text')?.text ?? 'get_dashboard not found'
        if (!MISSING_TOOL.test(text)) throw new Error('get_dashboard failed')
        dashboard = false
      }
      const result = (await $.mcp.call(SERVER, 'list_agents')) as Call
      if (result.isError) throw new Error('list_agents failed')
      return snapshotOf((parse(result)['agents'] as Row[] | undefined) ?? [], [])
    }

    // With no subagent-mcp server connected (no config, or it is down) the mod goes dormant:
    // it clears the live file and probes once a minute, waking as soon as the server answers.
    const poll = async () => {
      try {
        const now = await read()
        if (toasts) for (const note of transitions(last, now)) $.ui.toast(note, { timeoutMs: 8000 })
        last = now
        const agents = now.agents.filter(a => LIVE.includes(String(a['state'])))
        await $.fs.write(await out(), JSON.stringify({ at: Date.now(), agents }))
        failures = 0
        if (dormant) {
          dormant = false
          schedule(ACTIVE_MS)
        }
      } catch {
        failures += 1
        revision = undefined
        if (!dormant && failures >= FAILURES_BEFORE_DORMANT) {
          dormant = true
          await $.fs.write(await out(), JSON.stringify({ at: Date.now(), agents: [] })).catch(() => undefined)
          schedule(DORMANT_MS)
        }
      }
    }

    schedule(ACTIVE_MS)

    return next(e)
  })
}
