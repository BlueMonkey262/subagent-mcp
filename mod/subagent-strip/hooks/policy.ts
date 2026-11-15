// Reading and rewriting the one `disabledBackends` line of a project's models.yaml. Everything else in the
// file, comments included, is left byte for byte as it was.

export const BACKENDS = ['claude', 'codex', 'opencode', 'antigravity', 'cursor', 'copilot'] as const

export type Edit = { ok: true; text: string } | { ok: false; reason: string }

const ACTIVE = /^disabledBackends:[ \t]*(.*?)[ \t]*(?:#.*)?$/m

/** The backends the file disables, or null when the line is not a one-line `[a, b]` list we can edit. */
export function readDisabled(text: string): string[] | null {
  const match = ACTIVE.exec(text)
  if (match === null) return []
  const value = match[1] ?? ''
  const flow = /^\[(.*)\]$/.exec(value)
  if (flow === null) return null
  return (flow[1] ?? '')
    .split(',')
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(s => s !== '')
}

/** The file with `disabledBackends` set to `list`; refuses what it cannot edit safely. */
export function writeDisabled(text: string, list: readonly string[]): Edit {
  if (readDisabled(text) === null) {
    return { ok: false, reason: 'disabledBackends in models.yaml is not a one-line list; edit it by hand' }
  }
  const line = `disabledBackends: [${list.join(', ')}]`
  if (ACTIVE.test(text)) return { ok: true, text: text.replace(ACTIVE, line) }
  const models = /^models:/m.exec(text)
  if (models === null) return { ok: false, reason: 'models.yaml has no models: section' }
  return { ok: true, text: text.slice(0, models.index) + line + '\n\n' + text.slice(models.index) }
}
