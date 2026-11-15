#!/usr/bin/env node
// Audits and vendors Antigravity custom-agent definitions, which `agy --agent <name>` reads from
// .agents/agents/<name>.md or ~/.gemini/agents/<name>.md. Requires `npm run build`.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { FileAntigravityAgentResolver } from "../dist/src/adapters/antigravity/agent-definition.js";
import { resolveModelsFile } from "../dist/src/config/models-file.js";
import { loadConfigRegistry } from "../dist/src/config/registry.js";

const cwd = process.cwd();
const agentsDirectory = process.env.SUBAGENT_MCP_AGENTS_DIR ?? join(cwd, ".subagents");
const modelsFile = resolveModelsFile({ cwd }).path;
const resolver = new FileAntigravityAgentResolver();

const usage = `subagent-mcp antigravity doctor
subagent-mcp antigravity vendor <agent-config> [--force]

doctor    resolve every Antigravity config and report its real definition, hash, tools and portability
vendor    copy a resolved definition into <project>/.agents/agents/<name>.md
`;

const [command, ...args] = process.argv.slice(2);
if (command === undefined || command === "-h" || command === "--help") {
  process.stdout.write(usage);
  process.exit(command === undefined ? 1 : 0);
}

let registry;
try {
  registry = await loadConfigRegistry({ agentsDirectory, modelsFile });
} catch (error) {
  console.error(`subagent-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const configs = registry.listAgents().filter(config => config.backend === "antigravity");

async function resolveConfig(config, prepare = true) {
  if (typeof config.antigravityAgent !== "string" || config.antigravityAgent.trim() === "") {
    throw new Error(`config "${config.name}" does not set antigravityAgent`);
  }
  return resolver.resolve({
    name: config.antigravityAgent,
    cwd,
    ...(config.antigravityAgentFile === undefined ? {} : { file: config.antigravityAgentFile }),
    ...(prepare ? {} : { prepare: false }),
  });
}

if (command === "doctor") {
  if (configs.length === 0) {
    console.log("No Antigravity agent configs found.");
    process.exit(0);
  }
  let failed = false;
  for (const config of configs) {
    try {
      const definition = await resolveConfig(config, false);
      console.log(JSON.stringify({
        config: config.name,
        source_path: config.sourcePath,
        agent: definition.name,
        definition_path: definition.sourcePath,
        source: definition.source,
        portable: definition.portable,
        sha256: definition.sha256,
        tools: definition.tools ?? null,
        bridge_enforced: false,
      }, null, 2));
    } catch (error) {
      failed = true;
      console.error(JSON.stringify({
        config: config.name,
        error: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      }, null, 2));
    }
  }
  process.exit(failed ? 1 : 0);
}

if (command === "vendor") {
  const configName = args.find(arg => !arg.startsWith("--"));
  if (configName === undefined) {
    console.error(usage);
    process.exit(1);
  }
  const config = configs.find(item => item.name === configName);
  if (config === undefined) {
    console.error(`subagent-mcp: no Antigravity agent config named "${configName}". Available: ${configs.map(item => item.name).join(", ") || "(none)"}`);
    process.exit(1);
  }
  let definition;
  try {
    definition = await resolveConfig(config);
  } catch (error) {
    console.error(`subagent-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const destination = join(cwd, ".agents", "agents", `${definition.name}.md`);
  const force = args.includes("--force");
  if (existsSync(destination) && !force) {
    console.error(`subagent-mcp: ${destination} already exists; pass --force to replace it.`);
    process.exit(1);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, definition.content, { mode: 0o644 });
  console.log(`vendored ${definition.name} from ${definition.sourcePath}`);
  console.log(`  -> ${destination}`);
  console.log(`  sha256 ${definition.sha256}`);
  console.log(`  project-relative: ${relative(cwd, destination)}`);
  console.log(`  bridge_enforced: false (Antigravity owns tools and permissions)`);
  process.exit(0);
}

console.error(`subagent-mcp: unknown antigravity command "${command}"\n\n${usage}`);
process.exit(1);
