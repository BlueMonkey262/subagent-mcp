import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signalDescendants, signalProcessGroup } from "../src/process-group.js";

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("signalProcessGroup reaps a grandchild the direct child would leave behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-process-group-"));
  const pidfile = join(dir, "grandchild");
  const child = spawn("bash", ["-c", `sleep 60 & echo $! > ${JSON.stringify(pidfile)}; wait`], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await waitUntil(async () => {
      try {
        const text = await readFile(pidfile, "utf8");
        return Number(text.trim()) > 0;
      } catch {
        return false;
      }
    });
    const grandchild = Number((await readFile(pidfile, "utf8")).trim());
    assert.equal(alive(grandchild), true);
    signalProcessGroup(child, "SIGTERM");
    await waitUntil(() => !alive(grandchild) && (child.pid === undefined || !alive(child.pid)));
  } finally {
    signalProcessGroup(child, "SIGKILL");
  }
});

test("signalDescendants stops grandchildren and leaves the leader alive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-descendants-"));
  const pidfile = join(dir, "grandchild");
  const child = spawn("bash", ["-c", `sleep 60 & echo $! > ${JSON.stringify(pidfile)}; while true; do sleep 30; done`], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await waitUntil(async () => {
      try {
        return Number((await readFile(pidfile, "utf8")).trim()) > 0;
      } catch {
        return false;
      }
    });
    const grandchild = Number((await readFile(pidfile, "utf8")).trim());
    const leader = child.pid;
    assert.equal(typeof leader, "number");
    signalDescendants(child, "SIGTERM");
    await waitUntil(() => !alive(grandchild));
    assert.equal(leader !== undefined && alive(leader), true);
  } finally {
    signalProcessGroup(child, "SIGKILL");
  }
});
