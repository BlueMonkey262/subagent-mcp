// Preloaded into a spawned host to inject a completion ping that is still being persisted when
// shutdown begins, so the test can prove the final snapshot waits for in-flight notifiers.
import { Supervisor } from "../dist/src/supervisor.js";

let supervisor;

const originalEnablePersistence = Supervisor.prototype.enablePersistence;
Supervisor.prototype.enablePersistence = function enablePersistence(path) {
  supervisor = this;
  return originalEnablePersistence.call(this, path);
};

const originalEnqueue = Supervisor.prototype.enqueueUndeliveredPing;
Supervisor.prototype.enqueueUndeliveredPing = async function enqueueUndeliveredPing(result) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SUBAGENT_TEST_PING_DELAY_MS ?? 250)));
  return originalEnqueue.call(this, result);
};

// A late restored task emits a MISSED_START ping through the host's onDetachedSettled callback.
process.on("SIGUSR2", () => {
  supervisor?.restorePending([{
    id: process.env.SUBAGENT_TEST_PING_ID ?? "task-notifier-race",
    created_at: new Date().toISOString(),
    input: { agent: "general", prompt: "late", description: "late", backend: "codex", notify: "always" },
    dependencies: [],
    state: "queued",
    start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    notify: "always",
  }]);
});
