/** Default Codex delegation to background without overriding an explicit choice. */
export function codexSpawnDefaults(client: string | undefined, tool: string, input: unknown): unknown {
  if (client !== 'codex-mcp-client' || tool !== 'spawn_agent' || typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const args = input as Record<string, unknown>;
  return args.run_in_background === undefined ? { ...args, run_in_background: true } : input;
}

/** Retry only an explicit unknown-method response: no operation ran on that host. */
export async function callCodexHost(call: (method: string, input: unknown, timeout?: number) => Promise<unknown>, method: string, input: unknown, thread: string, timeout?: number): Promise<unknown> {
  try { return await call(`codex_${method}`, { input, thread }, timeout); }
  catch (error) {
    if (!(error instanceof Error) || !new RegExp(`^Unknown host method codex_${method}$`).test(error.message)) throw error;
    const result = await call(method, input, timeout);
    return typeof result === 'object' && result !== null && !Array.isArray(result)
      ? { ...result, notification_warning: 'The shared host is too old to deliver Codex pings for this work. Use wait_for_agents or get_ensemble when the result is needed; restart_host when active work and other sessions permit.' }
      : result;
  }
}
