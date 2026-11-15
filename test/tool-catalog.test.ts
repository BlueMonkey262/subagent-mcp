import assert from "node:assert/strict";
import test from "node:test";

import { catalogJson, ServedCatalog, TOOL_CATALOG, validateToolInput } from "../src/tool-catalog.js";

test("the catalog names every tool once, with an object JSON Schema each", () => {
  const names = TOOL_CATALOG.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ["spawn_agent", "get_dashboard", "get_agent_diff", "start_ensemble", "restart_host"]) assert.ok(names.includes(name), name);
  for (const tool of catalogJson()) assert.equal(tool.inputSchema["type"], "object", tool.name);
  assert.deepEqual(catalogJson().filter((tool) => tool.local === true).map((tool) => tool.name), ["restart_host"]);
  assert.deepEqual(catalogJson().filter((tool) => tool.format === "compact").map((tool) => tool.name), ["start_ensemble", "get_ensemble", "cancel_ensemble"]);
});

test("validateToolInput parses known tools, drops unknown keys, and passes other methods through", () => {
  assert.deepEqual(validateToolInput("stop_agent", { agent: "Ada", extra: 1 }), { ok: true, value: { agent: "Ada" } });
  const bad = validateToolInput("list_agents", { limit: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /Invalid arguments for list_agents/);
  assert.deepEqual(validateToolInput("hello", { anything: true }), { ok: true, value: { anything: true } });
});

function fakeHost() {
  const state = { build: undefined as string | undefined, fetches: 0, answer: undefined as unknown, fail: false };
  return {
    state,
    source: {
      hostBuild: () => state.build,
      fetch: async () => {
        state.fetches += 1;
        if (state.fail) throw new Error("Unknown host method tool_catalog");
        return state.answer;
      },
    },
  };
}

test("ServedCatalog serves its own tools until the host answers, then the host's, notifying only on a change", async () => {
  const host = fakeHost();
  let notices = 0;
  const catalog = new ServedCatalog(host.source, async () => { notices += 1; });
  const own = catalog.tools;
  await catalog.refresh();
  assert.equal(host.state.fetches, 0, "no host yet");

  // Same catalog from the host: served from the host, but nothing changed for the client.
  host.state.build = "b1";
  host.state.answer = { build: "b1", tools: catalogJson() };
  await catalog.refresh();
  assert.equal(catalog.servesHost("b1"), true);
  assert.equal(notices, 0);
  await catalog.refresh();
  assert.equal(host.state.fetches, 1, "fetched once per build");

  // A restarted host with a new tool.
  host.state.build = "b2";
  host.state.answer = { build: "b2", tools: [...catalogJson(), { name: "new_tool", description: "New", inputSchema: { type: "object" }, format: "pretty" }] };
  await catalog.refresh();
  assert.equal(notices, 1);
  assert.ok(catalog.tools.some((tool) => tool.name === "new_tool"));
  assert.equal(catalog.servesHost("b2"), true);
  assert.equal(catalog.servesHost("b1"), false);
  assert.notDeepEqual(catalog.tools, own);
});

test("ServedCatalog keeps its own tools for a host without tool_catalog, or a malformed answer", async () => {
  const host = fakeHost();
  let notices = 0;
  const catalog = new ServedCatalog(host.source, async () => { notices += 1; });
  host.state.build = "old";
  host.state.fail = true;
  await catalog.refresh();
  assert.equal(catalog.servesHost("old"), false);
  assert.deepEqual(catalog.tools, catalogJson());

  host.state.build = "odd";
  host.state.fail = false;
  host.state.answer = { tools: [{ nope: true }] };
  await catalog.refresh();
  assert.equal(catalog.servesHost("odd"), false);
  assert.equal(notices, 0);
});

test("concurrent refreshes for one build share a single fetch", async () => {
  const host = fakeHost();
  host.state.build = "b1";
  host.state.answer = { tools: catalogJson() };
  const catalog = new ServedCatalog(host.source, async () => undefined);
  await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
  assert.equal(host.state.fetches, 1);
});

test("a fetch for a build the host has since left is dropped, not served", async () => {
  let release: (value: unknown) => void = () => undefined;
  let build = "b1";
  const answers: Record<string, unknown> = {
    b2: { tools: [...catalogJson(), { name: "b2_tool", description: "", inputSchema: { type: "object" }, format: "pretty" }] },
  };
  const catalog = new ServedCatalog({
    hostBuild: () => build,
    fetch: () => build === "b1" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(answers[build]),
  }, async () => undefined);
  const slow = catalog.refresh();
  build = "b2";
  await catalog.refresh();
  release({ tools: [{ name: "b1_tool", description: "", inputSchema: { type: "object" }, format: "pretty" }] });
  await slow;
  assert.ok(catalog.tools.some((tool) => tool.name === "b2_tool"));
  assert.ok(!catalog.tools.some((tool) => tool.name === "b1_tool"));
  assert.equal(catalog.servesHost("b2"), true);
});

test("a transient fetch failure is retried; a host without tool_catalog gets this build's tools back", async () => {
  const host = fakeHost();
  let notices = 0;
  const catalog = new ServedCatalog(host.source, async () => { notices += 1; });
  host.state.build = "b1";
  host.state.answer = { tools: [...catalogJson(), { name: "extra", description: "", inputSchema: { type: "object" }, format: "pretty" }] };
  await catalog.refresh();
  assert.equal(notices, 1);

  // Restarted onto a host that predates tool_catalog: the extra tool must go.
  host.state.build = "old";
  host.state.fail = true;
  await catalog.refresh();
  assert.deepEqual(catalog.tools, catalogJson());
  assert.equal(notices, 2);
  const fetches = host.state.fetches;
  await catalog.refresh();
  assert.equal(host.state.fetches, fetches, "a host without the method is not asked again");

  // A dropped socket mid-fetch: asked again on the next refresh.
  const flaky = fakeHost();
  const other = new ServedCatalog({ hostBuild: flaky.source.hostBuild, fetch: async () => { flaky.state.fetches += 1; if (flaky.state.fetches === 1) throw new Error("subagent-mcp host connection closed"); return { tools: catalogJson() }; } }, async () => undefined);
  flaky.state.build = "b1";
  await other.refresh();
  assert.equal(other.servesHost("b1"), false);
  await other.refresh();
  assert.equal(flaky.state.fetches, 2);
  assert.equal(other.servesHost("b1"), true);
});
