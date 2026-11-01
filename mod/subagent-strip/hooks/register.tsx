import type { Register } from 'claude-code'

const LIVE = ['starting', 'running', 'needs_approval']
const ACTIVE_MS = 2000
const DORMANT_MS = 60000
const FAILURES_BEFORE_DORMANT = 3

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    // /clear gives the session a new id without a new session.start, so the path is resolved on every write
    // one file per session under <mod>/live, next to the status line script, so sessions never overwrite each other
    const root = $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
    const out = async () => `${root}/live/${await $.session.id()}.json`

    let failures = 0
    let dormant = false
    let timer: { cancel: () => void } | undefined

    const schedule = (ms: number) => {
      timer?.cancel()
      timer = $.clock.every(ms, poll)
    }

    // With no subagent-mcp server connected (no config, or it is down) the mod goes dormant:
    // it clears the live file and probes once a minute, waking as soon as the server answers.
    const poll = async () => {
      try {
        const result = await $.mcp.call('subagent-mcp', 'list_agents')
        if (result.isError) throw new Error('list_agents failed')
        const raw = result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}')
        const list = (raw as { agents?: Record<string, unknown>[] }).agents ?? []
        const agents = list.filter(a => LIVE.includes(String(a.state)))

        await $.fs.write(await out(), JSON.stringify({ at: Date.now(), agents }))
        failures = 0
        if (dormant) {
          dormant = false
          schedule(ACTIVE_MS)
        }
      } catch {
        failures += 1
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
