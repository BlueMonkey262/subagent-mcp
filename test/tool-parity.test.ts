// Parity check for the merge of PR #18 (one tool catalog) with main's McpServer registrations.
//
// Before this merge main defined every tool in src/server.ts with `server.registerTool(...)`. That file
// now serves the catalog, so every tool main registered — its names, parameter names/optionality,
// titles and description text — must appear here. The definitions are read from the merge's main tip
// (4ba9c39) with the TypeScript parser rather than copied into a fixture, so this compares against the
// real thing. The commit is an ancestor of the merge, so it is present in the repository; when it is
// not (a shallow clone, or a later history rewrite), the test skips instead of failing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import { TOOL_CATALOG, type ToolDefinition } from "../src/tool-catalog.js";

const MAIN_TIP = "4ba9c39";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

interface RegisteredTool {
  readonly name: string;
  readonly title?: string;
  readonly parameters: ReadonlyMap<string, boolean> | undefined;
  readonly descriptionChunks: readonly string[];
}

function mainServerSource(): string | undefined {
  try {
    return execFileSync("git", ["-C", repoRoot, "show", `${MAIN_TIP}:src/server.ts`], { encoding: "utf8" });
  } catch {
    return undefined;
  }
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === name) return member.initializer;
  }
  return undefined;
}

/** String literal pieces of a description (main concatenates literals and prompt-policy constants). */
function chunks(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return chunks(expression.expression);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...chunks(expression.left), ...chunks(expression.right)];
  }
  return [];
}

/** Whether a zod expression ends in `.optional()` (walking the call chain). */
function isOptional(expression: ts.Expression): boolean {
  let current = expression;
  for (;;) {
    if (!ts.isCallExpression(current)) return false;
    if (ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "optional") return true;
    if (!ts.isPropertyAccessExpression(current.expression)) return false;
    current = current.expression.expression;
  }
}

function registeredTools(source: string): RegisteredTool[] {
  const file = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: RegisteredTool[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "server"
      && node.expression.name.text === "registerTool") {
      const [nameArgument, options] = node.arguments;
      if (nameArgument === undefined || !ts.isStringLiteral(nameArgument)) return;
      if (options === undefined || !ts.isObjectLiteralExpression(options)) return;
      const title = property(options, "title");
      const description = property(options, "description");
      const schema = property(options, "inputSchema");
      let parameters: Map<string, boolean> | undefined;
      if (schema !== undefined && ts.isObjectLiteralExpression(schema)) {
        parameters = new Map();
        for (const member of schema.properties) {
          if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) continue;
          parameters.set(member.name.text, isOptional(member.initializer));
        }
      }
      found.push({
        name: nameArgument.text,
        ...(title !== undefined && ts.isStringLiteral(title) ? { title: title.text } : {}),
        parameters,
        descriptionChunks: description === undefined ? [] : chunks(description),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const source = mainServerSource();
const skip = source === undefined ? `main's server.ts at ${MAIN_TIP} is not in this repository` : false;
const mainTools = source === undefined ? [] : registeredTools(source);

test("the catalog lists every tool main registered, with no extras", { skip }, () => {
  const fromMain = [...new Set(mainTools.map((tool) => tool.name))].sort();
  const fromCatalog = TOOL_CATALOG.map((tool) => tool.name).sort();
  assert.ok(fromMain.length > 0, "parsed main's registrations");
  assert.deepEqual(fromCatalog, fromMain);
  assert.equal(new Set(fromCatalog).size, fromCatalog.length, "no duplicate catalog names");
});

test("every parameter main registered is in the catalog with the same optionality", { skip }, () => {
  const catalog = new Map<string, ToolDefinition>(TOOL_CATALOG.map((tool) => [tool.name, tool] as const));
  for (const tool of mainTools) {
    const definition = catalog.get(tool.name);
    assert.ok(definition !== undefined, `${tool.name} is in the catalog`);
    if (tool.parameters === undefined) continue; // startEnsembleShape / getEnsembleSchema.shape, unchanged by main
    for (const [name, optional] of tool.parameters) {
      const field = definition.inputSchema[name] as unknown as
        { safeParse(value: unknown): { success: boolean } } | undefined;
      assert.ok(field !== undefined, `${tool.name}.${name} is in the catalog schema`);
      assert.equal(field.safeParse(undefined).success, optional, `${tool.name}.${name} optionality`);
    }
  }
});

test("the catalog's parameters do not drift beyond main's registrations", { skip }, () => {
  const fromMain = new Map<string, RegisteredTool>(mainTools.map((tool) => [tool.name, tool] as const));
  for (const tool of TOOL_CATALOG) {
    const registered = fromMain.get(tool.name);
    assert.ok(registered !== undefined, `${tool.name} was registered by main`);
    if (registered.parameters === undefined) continue;
    assert.deepEqual(
      Object.keys(tool.inputSchema).sort(),
      [...registered.parameters.keys()].sort(),
      `${tool.name} parameter names`,
    );
  }
});

// Main's restart_host description ended by saying tool-definition changes still need `/mcp`. With PR #18
// the proxy lists the connected host's catalog and sends tools/list_changed, so that sentence is false;
// the catalog replaces it with the restart/list_changed sentence. Everything else must be preserved.
const DROPPED_DESCRIPTION_TEXT: ReadonlyMap<string, readonly RegExp[]> = new Map([
  ["restart_host", [/Changes to tool/]],
]);

test("titles and every description fragment main registered are preserved", { skip }, () => {
  const catalog = new Map<string, ToolDefinition>(TOOL_CATALOG.map((tool) => [tool.name, tool] as const));
  for (const tool of mainTools) {
    const definition = catalog.get(tool.name);
    assert.ok(definition !== undefined, `${tool.name} is in the catalog`);
    if (tool.title !== undefined) assert.equal(definition.title, tool.title, `${tool.name} title`);
    const dropped = DROPPED_DESCRIPTION_TEXT.get(tool.name) ?? [];
    let dropping = false;
    for (const chunk of tool.descriptionChunks) {
      if (dropping) continue;
      if (dropped.some((pattern) => pattern.test(chunk))) { dropping = true; continue; }
      assert.ok(definition.description.includes(chunk), `${tool.name} description keeps: ${JSON.stringify(chunk)}`);
    }
  }
});
