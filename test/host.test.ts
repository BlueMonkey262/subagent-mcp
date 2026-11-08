import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AdapterRegistry } from "../src/adapters/adapter.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { LiveConfig } from "../src/config/live.js";
import { ConfigRegistry } from "../src/config/registry.js";
import type { AgentConfig, ModelRoster } from "../src/config/schema.js";
import { buildInfo, connectHost, HOST_PROTOCOL, hostDisposition, hostPaths, HostClient, HostSession, serveHost } from "../src/host.js";
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
