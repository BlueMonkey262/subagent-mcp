// Preloaded into a spawned host to prove an agent interrupted by adapters' closeAll() has its
// completion ping persisted by the final snapshot: closeAll() must run before the notifier drain.
import { writeFileSync } from "node:fs";

import { CodexAdapter } from "../dist/src/adapters/codex/adapter.js";
import { Supervisor } from "../dist/src/supervisor.js";

let supervisor;
const events = [];

const originalEnablePersistence = Supervisor.prototype.enablePersistence;
Supervisor.prototype.enablePersistence = function enablePersistence(path) {
  supervisor = this;
  return originalEnablePersistence.call(this, path);
};

// Keep the notifier in flight long enough that a pre-closeAll drain would miss it.
const originalEnqueue = Supervisor.prototype.enqueueUndeliveredPing;
Supervisor.prototype.enqueueUndeliveredPing = async function enqueueUndeliveredPing(result) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SUBAGENT_TEST_PING_DELAY_MS ?? 250)));
  return originalEnqueue.call(this, result);
};

const originalQuiesce = Supervisor.prototype.quiesce;
Supervisor.prototype.quiesce = async function quiesce(...args) {
  events.push("quiesce");
  return originalQuiesce.apply(this, args);
};

const originalCloseAll = CodexAdapter.prototype.closeAll;
CodexAdapter.prototype.closeAll = async function closeAll() {
  events.push("closeAll");
  await originalCloseAll.call(this);
  // Simulate an agent interrupted by closeAll settling just after it returns: the host's
  // onDetachedSettled callback enqueues a ping through a notifier that is still in flight.
  supervisor?.restorePending([{
    id: process.env.SUBAGENT_TEST_PING_ID ?? "task-closeall-race",
    created_at: new Date().toISOString(),
    input: { agent: "general", prompt: "late", description: "late", backend: "codex", notify: "always" },
    dependencies: [],
    state: "queued",
    start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    notify: "always",
  }]);
};

const originalFlushSnapshot = Supervisor.prototype.flushSnapshot;
Supervisor.prototype.flushSnapshot = async function flushSnapshot(...args) {
  const result = await originalFlushSnapshot.apply(this, args);
  events.push("flush");
  writeFileSync(process.env.SUBAGENT_TEST_ORDER_PATH ?? "", JSON.stringify(events));
  return result;
};
