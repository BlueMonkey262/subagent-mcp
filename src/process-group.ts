import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

/**
 * Signal a child's process group. Spawn with `detached: true` so the child is the group
 * leader; grandchildren (shells, `cargo`, `check_task`) stay in that group and die with it.
 * Falls back to the direct child when it is not a group leader.
 */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a group leader, or the group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * Signal descendants only, leaving the leader alive so a protocol interrupt can still
 * be written to its stdin. Used when the CLI must observe the stop before the group
 * is torn down.
 */
export function signalDescendants(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) return;
  for (const descendant of descendantPids(pid)) {
    try {
      process.kill(descendant, signal);
    } catch {
      // already gone
    }
  }
}

function descendantPids(pid: number): number[] {
  let children: number[];
  try {
    children = parsePids(readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8"));
  } catch {
    // No /proc (macOS, BSD): ask pgrep for direct children instead.
    children = pgrepChildren(pid);
  }
  // Deepest first so a parent is not reaped before its children are visited.
  return children.flatMap((childPid) => [...descendantPids(childPid), childPid]);
}

function pgrepChildren(pid: number): number[] {
  try {
    return parsePids(execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    // pgrep exits 1 when there are no matches.
    return [];
  }
}

function parsePids(text: string): number[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((value) => value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
