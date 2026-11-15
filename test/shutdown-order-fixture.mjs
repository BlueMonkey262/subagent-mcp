// Preloaded into a spawned host to record whether the final snapshot was written before the
// socket, pid file, and lock were removed.
import { existsSync, writeFileSync } from "node:fs";

import { Supervisor } from "../dist/src/supervisor.js";

const original = Supervisor.prototype.flushSnapshot;
Supervisor.prototype.flushSnapshot = async function flushSnapshot() {
  await original.call(this);
  const order = {
    socket: existsSync(process.env.SUBAGENT_TEST_SOCKET ?? ""),
    pid: existsSync(process.env.SUBAGENT_TEST_PID ?? ""),
    lock: existsSync(process.env.SUBAGENT_TEST_LOCK ?? ""),
  };
  writeFileSync(process.env.SUBAGENT_TEST_ORDER_PATH ?? "", JSON.stringify(order));
};
