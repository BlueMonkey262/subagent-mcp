#!/usr/bin/env node
// Manages OpenAI-compatible endpoints (NVIDIA NIM is a preset). Stores them in
// ~/.config/subagent-mcp/endpoints.json and regenerates what each harness needs:
//   litellm.yaml  - proxy config (Codex and Claude agents talk to this local proxy)
//   opencode.json - native OpenAI-compatible providers for OpenCode (no proxy)
//   ~/.codex/config.toml - the [model_providers.subagent_proxy] entry (added once)
// The MCP server reads endpoints.json and adds `<endpoint>/<alias>` models to the claude, codex and
// opencode rosters automatically.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "subagent-mcp");
const file = process.env.SUBAGENT_MCP_ENDPOINTS_FILE ?? join(configDir, "endpoints.json");
const port = process.env.SUBAGENT_MCP_NIM_PORT ?? "4131";
const NIM = {
  baseUrl: "https://integrate.api.nvidia.com/v1",
  models: [
    { id: "deepseek-ai/deepseek-v4-flash-0731", alias: "dsv4-flash" },
    { id: "moonshotai/kimi-k3", alias: "kimi-k3" },
    { id: "z-ai/glm-5.3-flash", alias: "glm-5.3-flash" },
  ],
};

const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { endpoints: {} });
const die = (m) => { console.error(m); process.exit(1); };

function save(data) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  const eps = Object.entries(data.endpoints);
  const yaml = ["model_list:"];
  const oc = { $schema: "https://opencode.ai/config.json", provider: {} };
  for (const [name, ep] of eps) {
    for (const m of ep.models) {
      yaml.push(`  - model_name: ${JSON.stringify(`${name}/${m.alias}`)}`, "    litellm_params:",
        `      model: ${JSON.stringify(`openai/${m.id}`)}`, `      api_base: ${JSON.stringify(ep.baseUrl)}`,
        `      api_key: ${JSON.stringify(ep.apiKey || "none")}`);
    }
    oc.provider[name] = {
      npm: "@ai-sdk/openai-compatible", name,
      options: { baseURL: ep.baseUrl, ...(ep.apiKey ? { apiKey: ep.apiKey } : {}) },
      models: Object.fromEntries(ep.models.map((m) => [m.alias, { name: m.id }])),
    };
  }
  if (eps.length === 0) yaml[0] = "model_list: []";
  yaml.push("", "litellm_settings:", "  drop_params: true", '  callbacks: ["litellm_nim_hooks.proxy_handler_instance"]',
    "", "general_settings:", "  disable_master_key_return: true", "");
  writeFileSync(join(configDir, "litellm.yaml"), yaml.join("\n"), { mode: 0o600 });
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(oc, null, 2) + "\n", { mode: 0o600 });
  registerCodexProvider();
}

function registerCodexProvider() {
  const cfg = join(homedir(), ".codex", "config.toml");
  mkdirSync(join(homedir(), ".codex"), { recursive: true });
  const text = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  if (/^\[model_providers\.subagent_proxy\]/m.test(text)) return;
  appendFileSync(cfg, `\n[model_providers.subagent_proxy]\nname = "subagent_proxy"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "SUBAGENT_MCP_PROXY_KEY"\n`);
  console.log(`added [model_providers.subagent_proxy] to ${cfg}`);
}

function parseModels(list) {
  return list.map((s) => { const [id, alias] = s.split("="); return { id, alias: alias ?? id.split("/").pop() }; });
}

async function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

function describe(name, ep) {
  console.log(`${name}  ${ep.baseUrl}  key:${ep.apiKey ? "set" : "none"}`);
  for (const m of ep.models) console.log(`  ${name}/${m.alias} -> ${m.id}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const data = load();

if (cmd === "add") {
  const args = rest.slice();
  const flags = { model: [] };
  const pos = [];
  while (args.length) {
    const a = args.shift();
    if (a === "--key") flags.key = args.shift();
    else if (a === "--model") flags.model.push(args.shift());
    else pos.push(a);
  }
  const [name, baseUrl] = pos;
  if (!name || !baseUrl || !/^[a-z0-9][a-z0-9_-]*$/i.test(name) || flags.model.length === 0) {
    die("usage: subagent-mcp endpoint add <name> <openai-base-url> --model <id>[=alias] [--model ...] [--key KEY]");
  }
  data.endpoints[name] = { baseUrl: baseUrl.replace(/\/$/, ""), ...(flags.key ? { apiKey: flags.key } : {}), models: parseModels(flags.model) };
  save(data);
  describe(name, data.endpoints[name]);
} else if (cmd === "remove") {
  if (!data.endpoints[rest[0]]) die(`no such endpoint: ${rest[0]}`);
  delete data.endpoints[rest[0]];
  save(data);
} else if (cmd === "list") {
  const eps = Object.entries(data.endpoints);
  if (eps.length === 0) console.log("no endpoints configured");
  eps.forEach(([n, e]) => describe(n, e));
} else if (cmd === "nim") {
  if (rest[0] !== "set-key") die("usage: subagent-mcp nim set-key [KEY]");
  const key = rest[1] ?? (await prompt("NVIDIA NIM API key (nvapi-...): "));
  if (!key) die("no key given");
  data.endpoints.nim = { baseUrl: NIM.baseUrl, apiKey: key, models: data.endpoints.nim?.models ?? NIM.models };
  save(data);
  describe("nim", data.endpoints.nim);
} else {
  die("usage: endpoints.mjs {add|remove|list|nim set-key}");
}
