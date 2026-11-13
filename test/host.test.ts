import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { LiveConfig } from "../src/config/live.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { buildInfo, connectHost, HOST_PROTOCOL, hostDisposition, hostPaths, HostClient, HostSession, serveHost } from "../src/host.js";
import { attachSessionAfterInitialize } from "../src/session.js";
import { Supervisor } from "../src/supervisor.js";

// Daemon integration tests must never contact the release API.
process.env.SUBAGENT_MCP_UPDATE_CHECK = "0";

const permission = { allow: [], deny: [], default: "escalate" as const };
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

function daemonOptions(cwd: string): {
  cwd: string;
  agentsDirectory: string;
  modelsFile: string;
  scriptPath: string;
} {
  const agentsDirectory = join(cwd, ".subagents");
  return {
    cwd,
    agentsDirectory,
    modelsFile: join(agentsDirectory, "models.yaml"),
    scriptPath: serverPath,
  };
}

async function waitForChild(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child ${String(child.pid)} did not exit`)), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`pid ${pid} did not exit`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function registry(): ConfigRegistry {
  const agent: AgentConfig = {
    name: "general",
    backend: "codex",
    model: "fake-model",
    description: "General agent",
    systemPrompt: "",
    permission,
    env: {},
    sourcePath: "test-fixture",
  };
  const roster: ModelRoster = {
    claude: [],
    codex: [{ name: "fake-model" }],
    opencode: [],
    antigravity: [],
    cursor: [],
  };
  return new ConfigRegistry([agent], roster);
}

async function stopDaemon(cwd: string): Promise<void> {
  const paths = hostPaths(cwd);
  const client = await HostClient.connect(paths.socketPath, 300).catch(() => undefined);
  if (client !== undefined) {
    await client.call("shutdown").catch(() => undefined);
    client.close();
  }
  const killIfOther = async (pid: number): Promise<void> => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.pidPath, "utf8"));
    const pid = typeof parsed === "object" && parsed !== null && "pid" in parsed ? Number(parsed.pid) : Number.NaN;
    await killIfOther(pid);
  } catch {
    // no pid file
  }
  try {
    await killIfOther(Number((await readFile(join(paths.lockPath, "pid"), "utf8")).trim()));
  } catch {
    // no lock
  }
  await rm(paths.lockPath, { recursive: true, force: true });
  await rm(paths.socketPath, { force: true });
}

test("a second client still sees an agent after the first disconnects", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-"));
  const adapter = new FakeAdapter("codex");
  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const, finalText: "done" },
    }),
  }]);
  const supervisor = new Supervisor({
    registry: registry(),
    adapters: new AdapterRegistry([adapter]),
    cwd,
  });
  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  try {
    const first = await HostClient.connect(paths.socketPath);
    const spawned = await first.call("spawn_agent", {
      agent: "general",
      prompt: "hello",
      description: "host",
      run_in_background: true,
    }) as { agent_id: string; timeout_seconds: null };
    assert.equal(spawned.timeout_seconds, null);
    first.close();

    const second = await HostClient.connect(paths.socketPath);
    const listed = await second.call("list_agents") as { agents: { agent_id: string }[] };
    assert.equal(listed.agents.some((agent) => agent.agent_id === spawned.agent_id), true);
    second.close();
  } finally {
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
  }
});

test("an unconfigured host tells the caller how to fix it and to reconnect", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-noconfig-"));
  const agents = join(cwd, ".subagents");
  const models = join(agents, "models.yaml");
  let client: HostClient | undefined;
  try {
    client = await connectHost({ cwd, agentsDirectory: agents, modelsFile: models, scriptPath: serverPath });
    await assert.rejects(
      client.call("spawn_agent", { agent: "general", prompt: "hello", description: "missing" }),
      (error: unknown) => error instanceof Error
        && /ask the user to run `\/mcp` and then reconnect subagent-mcp/.test(error.message)
        && error.message.includes(models),
    );
  } finally {
    client?.close();
    await stopDaemon(cwd);
  }
});

test("reconnecting attaches to the same host and keeps a spawned agent", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-reconnect-"));
  const agents = join(cwd, ".subagents");
  const models = join(agents, "models.yaml");
  await mkdir(agents, { recursive: true });
  await writeFile(models, `models:
  claude: []
  codex: [fake-model]
  opencode: []
  antigravity: []
  cursor: []
`);
  await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
model: fake-model
description: General agent
---
Work.
`);
  const options = { cwd, agentsDirectory: agents, modelsFile: models, scriptPath: serverPath };
  let first: HostClient | undefined;
  let second: HostClient | undefined;
  try {
    first = await connectHost(options);
    const hello = await first.call("hello") as { pid: number };
    const live = new LiveConfig({ agentsDirectory: agents, modelsFile: models });
    await live.reload();
    assert.equal(live.hasConfig(), true);
    live.close();
    first.close();
    first = undefined;

    second = await connectHost(options);
    const again = await second.call("hello") as { pid: number };
    assert.equal(again.pid, hello.pid);
    const listed = await second.call("list_agents") as { agents: unknown[] };
    assert.deepEqual(listed.agents, []);
  } finally {
    first?.close();
    second?.close();
    await stopDaemon(cwd);
  }
});

test("a second host process backs off without disturbing the first", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-duplicate-"));
  const options = daemonOptions(cwd);
  const paths = hostPaths(cwd);
  let client: HostClient | undefined;
  let duplicate: ChildProcess | undefined;
  try {
    client = await connectHost(options);
    const first = await client.call("hello") as { pid: number };
    duplicate = spawn(process.execPath, [serverPath], {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        SUBAGENT_MCP_HOST: "1",
        SUBAGENT_MCP_AGENTS_DIR: options.agentsDirectory,
        SUBAGENT_MCP_MODELS_FILE: options.modelsFile,
      },
    });
    assert.equal(await waitForChild(duplicate), 0);

    const again = await client.call("hello") as { pid: number };
    assert.equal(again.pid, first.pid);
    assert.equal(Number((await readFile(join(paths.lockPath, "pid"), "utf8")).trim()), first.pid);
  } finally {
    if (duplicate !== undefined && duplicate.exitCode === null) duplicate.kill("SIGTERM");
    client?.close();
    await stopDaemon(cwd);
  }
});

test("an older host shutdown preserves a newer host socket and lock", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-ownership-"));
  const options = daemonOptions(cwd);
  const paths = hostPaths(cwd);
  let older: HostClient | undefined;
  let newer: HostClient | undefined;
  let fresh: HostClient | undefined;
  try {
    older = await connectHost(options);
    const oldHello = await older.call("hello") as { pid: number };

    await rm(paths.socketPath, { force: true });
    await rm(paths.lockPath, { recursive: true, force: true });
    await rm(paths.pidPath, { force: true });

    newer = await connectHost(options);
    const newHello = await newer.call("hello") as { pid: number };
    assert.notEqual(newHello.pid, oldHello.pid);

    await older.call("shutdown");
    older.close();
    older = undefined;
    await waitForPidExit(oldHello.pid);

    fresh = await HostClient.connect(paths.socketPath);
    const after = await fresh.call("hello") as { pid: number };
    assert.equal(after.pid, newHello.pid);
    assert.equal(Number((await readFile(join(paths.lockPath, "pid"), "utf8")).trim()), newHello.pid);
  } finally {
    older?.close();
    newer?.close();
    fresh?.close();
    await stopDaemon(cwd);
  }
});

test("connectHost refuses to duplicate a live recorded pid with a missing socket", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-missing-socket-"));
  const paths = hostPaths(cwd);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.pidPath, `${JSON.stringify({
    pid: process.pid,
    protocol: 1,
    socketPath: paths.socketPath,
  })}\n`);

  await assert.rejects(
    connectHost(daemonOptions(cwd)),
    (error: unknown) => error instanceof Error
      && error.message.includes(`host pid ${process.pid}`)
      && error.message.includes(`stop pid ${process.pid}`)
      && error.message.includes("Refusing to start a duplicate"),
  );
  await assert.rejects(readFile(join(paths.lockPath, "pid"), "utf8"));
  assert.equal(JSON.parse(await readFile(paths.pidPath, "utf8")).pid, process.pid);
});

test("host errors keep their code, first in the message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-codes-"));
  const supervisor = new Supervisor({ registry: registry(), adapters: new AdapterRegistry([new FakeAdapter("codex")]), cwd });
  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  const client = await HostClient.connect(paths.socketPath);
  try {
    await assert.rejects(
      client.call("spawn_agent", { agent: "missing", prompt: "hi", description: "no such agent" }),
      (error: Error & { code?: string }) => error.code === "CONFIGURATION_ERROR" && error.message.startsWith("CONFIGURATION_ERROR: "),
    );
  } finally {
    client.close();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
  }
});

/** Run `body` with build-identity env overrides, restoring the previous values afterwards. */
async function withBuildEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  try {
    return await body();
  } finally {
    apply(saved);
  }
}

const buildEnv = (id: string, time: number) => ({ SUBAGENT_MCP_BUILD_ID: id, SUBAGENT_MCP_BUILD_TIME: String(time) });

test("hostDisposition: replace only an older, idle host no other session uses; never downgrade", () => {
  const local = { build: "new", builtAt: 2_000 };
  const host = (extra: Record<string, unknown>) => ({ protocol: HOST_PROTOCOL, clients: 1, ...extra });
  assert.equal(hostDisposition(host({ build: "new", builtAt: 2_000, active: 2 }), local), "keep");
  assert.equal(hostDisposition(host({ build: "old", builtAt: 1_000 }), local), "replace");
  assert.equal(hostDisposition(host({}), local), "replace", "a host from before builds were reported is older");
  assert.equal(hostDisposition(host({ build: "old", builtAt: 1_000, active: 1 }), local), "stale");
  assert.equal(hostDisposition(host({ build: "old", builtAt: 1_000, waiting: 1 }), local), "stale");
  assert.equal(hostDisposition(host({ build: "old", builtAt: 1_000, clients: 2 }), local), "stale", "another session is attached");
  assert.equal(hostDisposition(host({ build: "newer", builtAt: 3_000 }), local), "newer", "never downgrade");
  assert.equal(hostDisposition({ protocol: HOST_PROTOCOL - 1 }, local), "replace");
  assert.equal(hostDisposition({ protocol: HOST_PROTOCOL - 1, active: 1 }, local), "refuse");
  assert.match(buildInfo().build, /^[0-9a-f]{16}$|^unknown$/);
});

test("reconnecting replaces an idle host on an older build", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-rebuild-"));
  const options = daemonOptions(cwd);
  await mkdir(options.agentsDirectory, { recursive: true });
  try {
    const before = await withBuildEnv(buildEnv("build-a", 1_000), async () => {
      const client = await connectHost(options);
      const hello = await client.call("hello") as { pid: number; build: string; clients: number };
      client.close();
      return hello;
    });
    assert.equal(before.build, "build-a");
    assert.equal(before.clients, 1);
    const after = await withBuildEnv(buildEnv("build-b", 2_000), async () => {
      const client = await connectHost(options);
      const hello = await client.call("hello") as { pid: number; build: string };
      client.close();
      return hello;
    });
    assert.equal(after.build, "build-b");
    assert.notEqual(after.pid, before.pid);
    await waitForPidExit(before.pid);
  } finally {
    await stopDaemon(cwd);
  }
});

test("a host another session is using is kept, and restart_host refuses without force", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-shared-"));
  const options = daemonOptions(cwd);
  await mkdir(options.agentsDirectory, { recursive: true });
  let sessionA: HostClient | undefined;
  const sessionB = new HostSession(options);
  try {
    sessionA = await withBuildEnv(buildEnv("build-a", 1_000), () => connectHost(options));
    const first = await sessionA.call("hello") as { pid: number };
    await withBuildEnv({ ...buildEnv("build-b", 2_000), SUBAGENT_MCP_DISK_BUILD_ID: "build-b" }, async () => {
      await sessionB.connect();
      const shared = await sessionB.call("hello") as { pid: number; build: string; clients: number };
      assert.equal(shared.pid, first.pid, "session A's host was not replaced");
      assert.equal(shared.build, "build-a");
      assert.equal(shared.clients, 2);
      assert.match(sessionB.warning() ?? "", /older build/);
      await assert.rejects(sessionB.restart(), /other session\(s\) are connected/);
      assert.equal((await sessionA!.call("hello") as { pid: number }).pid, first.pid, "A is still connected");
    });
  } finally {
    sessionA?.close();
    sessionB.close();
    await stopDaemon(cwd);
  }
});

test("a host newer than the connecting proxy is never downgraded", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-newer-"));
  const options = daemonOptions(cwd);
  await mkdir(options.agentsDirectory, { recursive: true });
  try {
    const newer = await withBuildEnv(buildEnv("build-new", 2_000), async () => {
      const client = await connectHost(options);
      const hello = await client.call("hello") as { pid: number };
      client.close();
      return hello;
    });
    await withBuildEnv(buildEnv("build-old", 1_000), async () => {
      const session = new HostSession(options);
      await session.connect();
      assert.equal((await session.call("hello") as { pid: number }).pid, newer.pid);
      assert.match(session.warning() ?? "", /newer code than this MCP connection/);
      session.close();
    });
  } finally {
    await stopDaemon(cwd);
  }
});

test("a failed restart leaves a clear error instead of a closed connection", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-failed-restart-"));
  const options = { ...daemonOptions(cwd) };
  await mkdir(options.agentsDirectory, { recursive: true });
  const session = new HostSession(options);
  try {
    await withBuildEnv({ ...buildEnv("build-a", 1_000), SUBAGENT_MCP_DISK_BUILD_ID: "build-b" }, async () => {
      await session.connect();
      options.scriptPath = join(cwd, "missing-server.js"); // the replacement cannot start
      await assert.rejects(session.restart(), /did not come up/);
      await assert.rejects(session.call("hello"), /reconnect subagent-mcp/, "not \"connection is closed\"");
    });
  } finally {
    session.close();
    await stopDaemon(cwd);
  }
});

test("restart re-attaches the proxy and re-arms a scheduled task", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-scheduled-restart-"));
  const agents = join(cwd, ".subagents");
  const models = join(agents, "models.yaml");
  await mkdir(agents, { recursive: true });
  await writeFile(models, `models:
  claude: []
  codex: [fake-model]
  opencode: []
  antigravity: []
  cursor: []
`);
  await writeFile(join(agents, "general.md"), `---
name: general
backend: codex
model: fake-model
description: General agent
---
Work.
`);
  const session = new HostSession({ cwd, agentsDirectory: agents, modelsFile: models, scriptPath: serverPath });
  try {
    await session.connect();
    await session.attachSession();
    assert.equal((await session.call("hello") as { attached: number }).attached, 1);
    const spawned = await session.call("spawn_agent", {
      agent: "general", prompt: "later", description: "delayed", delay_seconds: 600,
    }) as { status: string };
    assert.equal(spawned.status, "queued");
    const before = await session.call("hello") as { pid: number; scheduled: number };
    assert.equal(before.scheduled, 1);

    const restarted = await session.restart(true) as {
      pid: number;
      scheduled_tasks_preserved: number;
      note?: string;
    };
    assert.notEqual(restarted.pid, before.pid);
    assert.equal(restarted.scheduled_tasks_preserved, 1);
    assert.match(restarted.note ?? "", /1 scheduled task/);

    let attached = 0;
    let scheduled = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const hello = await session.call("hello") as { attached: number; scheduled: number };
      attached = hello.attached;
      scheduled = hello.scheduled;
      if (attached === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(attached, 1, "the proxy re-attached after the restart");
    assert.equal(scheduled, 1, "the replacement host restored the scheduled task");
  } finally {
    session.close();
    await stopDaemon(cwd);
  }
});

test("restart is refused while an agent waits for approval, and the host stays up", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-busy-"));
  const adapter = new FakeAdapter("codex");
  adapter.queueScript([{
    create: (context) => ({
      type: "approval.requested",
      agentId: context.agentId,
      backend: context.backend,
      data: {
        requestId: "req-busy",
        agentId: context.agentId,
        backend: "codex" as const,
        toolName: "Bash",
        input: { command: "npm test" },
        command: "npm test",
        cwd,
        requestedAt: new Date().toISOString(),
      },
    }),
  }]);
  const supervisor = new Supervisor({ registry: registry(), adapters: new AdapterRegistry([adapter]), cwd });
  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  const session = new HostSession(daemonOptions(cwd));
  try {
    await session.connect();
    const spawned = await session.call("spawn_agent", { agent: "general", prompt: "work", description: "busy" }) as { status: string };
    assert.equal(spawned.status, "needs_approval");
    await assert.rejects(session.restart(true), /running agents/, "force never overrides running agents");
    assert.equal((await session.call("hello") as { active: number }).active, 1, "the busy host is still serving");
  } finally {
    session.close();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
  }
});

test("the proxy attaches only after initialize and only for Claude Code", () => {
  let calls = 0;
  const host = { attachSession: async () => { calls += 1; return {}; } };
  const fake = (name: string | undefined) => ({
    oninitialized: undefined as (() => void) | undefined,
    getClientVersion: () => (name === undefined ? undefined : { name, version: "1" }),
  });

  const claude = fake("claude-code");
  attachSessionAfterInitialize(claude as never, host);
  assert.equal(calls, 0, "initialize has not completed yet");
  claude.oninitialized?.();
  assert.equal(calls, 1, "Claude Code attaches after initialize");

  for (const name of ["codex", "opencode", undefined]) {
    const other = fake(name);
    attachSessionAfterInitialize(other as never, host);
    other.oninitialized?.();
  }
  assert.equal(calls, 1, "other clients never attach");
});

test("a probe does not consume queued pings; attach_session delivers to that socket only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-attach-"));
  const supervisor = new Supervisor({ registry: registry(), adapters: new AdapterRegistry([new FakeAdapter("codex")]), cwd });
  const paths = hostPaths(cwd);
  const endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  const probe = await HostClient.connect(paths.socketPath);
  const first = await HostClient.connect(paths.socketPath);
  const second = await HostClient.connect(paths.socketPath);
  const probePings: Readonly<Record<string, unknown>>[] = [];
  const firstPings: Readonly<Record<string, unknown>>[] = [];
  const secondPings: Readonly<Record<string, unknown>>[] = [];
  probe.onDetached((data) => probePings.push(data));
  first.onDetached((data) => firstPings.push(data));
  second.onDetached((data) => secondPings.push(data));
  try {
    await supervisor.enqueueUndeliveredPing({ agent_id: "a1", backend: "codex", status: "completed", result: "queued" });
    await probe.call("hello");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(probePings.length, 0, "a probe/hello connection never drains the queue");
    assert.equal(firstPings.length, 0);
    assert.equal(secondPings.length, 0);

    await first.call("attach_session");
    await waitUntil(() => firstPings.length === 1);
    assert.equal(firstPings[0]?.["result"], "queued");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(probePings.length, 0, "the probe still receives nothing");
    assert.equal(secondPings.length, 0, "another connected socket receives nothing");

    const attached = await second.call("attach_session") as { delivered: number };
    assert.equal(attached.delivered, 0, "the queue was already drained by the first attach");
    assert.equal(secondPings.length, 0);
  } finally {
    probe.close();
    first.close();
    second.close();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a settle with only a probe connected is queued, then delivered on attach_session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-probe-settle-"));
  const adapter = new FakeAdapter("codex");
  adapter.queueScript([{
    create: (context) => ({
      type: "turn.completed",
      agentId: context.agentId,
      backend: context.backend,
      data: { turnId: context.turnId, status: "completed" as const, finalText: "probe result" },
    }),
  }]);
  let endpoint: Awaited<ReturnType<typeof serveHost>> | undefined;
  const supervisor = new Supervisor({
    registry: registry(),
    adapters: new AdapterRegistry([adapter]),
    cwd,
    onDetachedSettled: (result) => {
      void (async () => {
        const delivered = endpoint === undefined
          ? 0
          : await endpoint.notify({ event: "detached", data: result }).catch(() => 0);
        if (delivered === 0) await supervisor.enqueueUndeliveredPing(result).catch(() => undefined);
      })();
    },
  });
  const paths = hostPaths(cwd);
  endpoint = await serveHost({ socketPath: paths.socketPath, supervisor });
  const probe = await HostClient.connect(paths.socketPath);
  const probePings: Readonly<Record<string, unknown>>[] = [];
  probe.onDetached((data) => probePings.push(data));
  let consumer: HostClient | undefined;
  try {
    await probe.call("hello");
    const spawned = await supervisor.spawnAgent({
      agent: "general", prompt: "work", description: "probe", run_in_background: true,
    });
    await waitUntil(() => supervisor.listAgents().some((agent) =>
      agent["agent_id"] === spawned["agent_id"] && agent["state"] === "completed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(probePings.length, 0, "a raw probe socket is not a consumer");

    consumer = await HostClient.connect(paths.socketPath);
    const consumerPings: Readonly<Record<string, unknown>>[] = [];
    consumer.onDetached((data) => consumerPings.push(data));
    await consumer.call("attach_session");
    await waitUntil(() => consumerPings.length === 1);
    assert.equal(consumerPings[0]?.["result"], "probe result");
    assert.equal(probePings.length, 0);
  } finally {
    probe.close();
    consumer?.close();
    await endpoint.close();
    await rm(paths.socketPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shutdown writes the final snapshot before removing the socket, pid, and lock", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-host-shutdown-order-"));
  const paths = hostPaths(cwd);
  const orderPath = join(cwd, "shutdown-order.json");
  const fixture = pathToFileURL(join(process.cwd(), "test", "shutdown-order-fixture.mjs")).href;
  const saved = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    SUBAGENT_TEST_SOCKET: process.env.SUBAGENT_TEST_SOCKET,
    SUBAGENT_TEST_PID: process.env.SUBAGENT_TEST_PID,
    SUBAGENT_TEST_LOCK: process.env.SUBAGENT_TEST_LOCK,
    SUBAGENT_TEST_ORDER_PATH: process.env.SUBAGENT_TEST_ORDER_PATH,
  };
  process.env.NODE_OPTIONS = `${saved.NODE_OPTIONS ?? ""} --import=${fixture}`.trim();
  process.env.SUBAGENT_TEST_SOCKET = paths.socketPath;
  process.env.SUBAGENT_TEST_PID = paths.pidPath;
  process.env.SUBAGENT_TEST_LOCK = paths.lockPath;
  process.env.SUBAGENT_TEST_ORDER_PATH = orderPath;
  let client: HostClient | undefined;
  try {
    client = await connectHost(daemonOptions(cwd));
    const hello = await client.call("hello") as { pid: number };
    await client.call("shutdown");
    client.close();
    client = undefined;
    await waitForPidExit(hello.pid);
    const order = JSON.parse(await readFile(orderPath, "utf8")) as { socket: boolean; pid: boolean; lock: boolean };
    assert.deepEqual(order, { socket: true, pid: true, lock: true }, "the final snapshot ran before any endpoint removal");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    client?.close();
    await stopDaemon(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
});
