import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureAntigravityAgent } from "../src/adapters/antigravity/agent-definition.js";

const definition = `---
name: subagent-general
description: Test definition
---
Do the work.
`;

test("a missing agent definition is copied from the install's .example template", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-agy-definition-"));
  const cwd = join(root, "project");
  const install = join(root, "install");
  const example = join(install, ".agents", "agents", "subagent-general.md.example");
  await mkdir(join(install, ".agents", "agents"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(example, definition);

  const ensured = await ensureAntigravityAgent({ cwd, name: "subagent-general", installDirectory: install });
  assert.equal(ensured.copied, true);
  assert.equal(ensured.copiedFrom, example);
  assert.equal(ensured.path, join(cwd, ".agents", "agents", "subagent-general.md"));
  assert.equal(await readFile(ensured.path, "utf8"), definition);
});

test("a project .example template wins over the install's, and an existing file is never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-agy-definition-"));
  const cwd = join(root, "project");
  const install = join(root, "install");
  const projectDirectory = join(cwd, ".agents", "agents");
  const projectExample = join(projectDirectory, "subagent-general.md.example");
  const installExample = join(install, ".agents", "agents", "subagent-general.md.example");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(join(install, ".agents", "agents"), { recursive: true });
  await writeFile(projectExample, definition);
  await writeFile(installExample, "---\nname: subagent-general\n---\nInstall copy.\n");

  const first = await ensureAntigravityAgent({ cwd, name: "subagent-general", installDirectory: install });
  assert.equal(first.copiedFrom, projectExample);
  assert.equal(await readFile(first.path, "utf8"), definition);

  await writeFile(first.path, "my edits\n");
  const second = await ensureAntigravityAgent({ cwd, name: "subagent-general", installDirectory: install });
  assert.equal(second.copied, false);
  assert.equal(second.copiedFrom, undefined);
  assert.equal(await readFile(first.path, "utf8"), "my edits\n");
});

test("with no real file and no template, nothing is created", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-agy-definition-"));
  const ensured = await ensureAntigravityAgent({ cwd, name: "missing", installDirectory: join(cwd, "install") });
  assert.equal(ensured.copied, false);
  assert.equal(ensured.copiedFrom, undefined);
  assert.equal(ensured.path, join(cwd, ".agents", "agents", "missing.md"));
});
