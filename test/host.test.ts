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
import { connectHost, hostPaths, HostClient, serveHost } from "../src/host.js";
import { Supervisor } from "../src/supervisor.js";

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
