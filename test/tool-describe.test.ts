import assert from "node:assert/strict";
import test from "node:test";

import { describeToolInput } from "../src/tool-describe.js";

test("a `pattern` input is reported as the target, verbatim", () => {
  assert.deepEqual(describeToolInput({ pattern: "describeToolInput" }), { target: "describeToolInput" });
  // Search tools that spell the same field differently still land on `pattern`.
  assert.deepEqual(describeToolInput({ pattern: "TODO|FIXME" }), { target: "TODO|FIXME" });
  // What was searched for beats where it ran: a grep in src/ reports its pattern, not the directory.
  assert.deepEqual(describeToolInput({ pattern: "TODO", path: "src/" }), { target: "TODO" });
  assert.deepEqual(describeToolInput({ glob_pattern: "**/*.ts", path: "/work" }), { target: "**/*.ts" });
});

test("a command longer than 160 characters is clipped to 160 characters ending in an ellipsis", () => {
  const long = `rm -rf ${"x".repeat(200)}`;
  const clipped = describeToolInput({ command: long });
  assert.equal(clipped.target, `rm -rf ${"x".repeat(152)}…`);
  assert.equal((clipped.target ?? "").length, 160);
  assert.match(clipped.target ?? "", /…$/);

  // Exactly 160 characters is kept whole, without an ellipsis.
  const exact = "y".repeat(160);
  assert.deepEqual(describeToolInput({ command: exact }), { target: exact });

  // Short commands are untouched, and embedded newlines/tabs fold into single spaces.
  assert.deepEqual(describeToolInput({ command: "npm   test\n--quick" }), { target: "npm test --quick" });
});

test("an edit preview shows at most 3 `-` lines then 3 `+` lines", () => {
  const oldString = ["first old", "second old", "third old", "fourth old", "fifth old", "sixth old"].join("\n");
  const newString = ["first new", "second new", "third new", "fourth new", "fifth new"].join("\n");
  const described = describeToolInput({ file_path: "notes.md", old_string: oldString, new_string: newString });

  assert.equal(described.target, "notes.md");
  assert.equal(
    described.preview,
    ["-first old", "-second old", "-third old", "+first new", "+second new", "+third new"].join("\n"),
  );
  const lines = (described.preview ?? "").split("\n");
  assert.equal(lines.filter((line) => line.startsWith("-")).length, 3);
  assert.equal(lines.filter((line) => line.startsWith("+")).length, 3);

  // camelCase harnesses behave the same, and each shown line is clipped on its own.
  const camel = describeToolInput({
    filePath: "notes.md",
    oldString: "z".repeat(200),
    newString: "w".repeat(200),
  });
  assert.deepEqual(
    (camel.preview ?? "").split("\n"),
    [`-${"z".repeat(99)}…`, `+${"w".repeat(99)}…`],
  );
});

test("an empty tool input object describes nothing", () => {
  assert.deepEqual(describeToolInput({}), {});
  // Blank fields count as absent, so they leave nothing behind either.
  assert.deepEqual(describeToolInput({ command: "", old_string: "" }), {});
});

test("null and non-object tool inputs describe nothing", () => {
  assert.deepEqual(describeToolInput(null), {});
  assert.deepEqual(describeToolInput(undefined), {});
  assert.deepEqual(describeToolInput(["npm test"]), {});
});

test("harness-specific shapes: Antigravity CommandLine, Cursor strReplace/applyPatch", () => {
  assert.deepEqual(describeToolInput({ CommandLine: "echo fixture" }), { target: "echo fixture" });
  assert.deepEqual(
    describeToolInput({ path: "a.ts", strReplace: { oldText: "x", newText: "y" } }),
    { target: "a.ts", preview: "-x\n+y" },
  );
  const patched = describeToolInput({ path: "b.ts", applyPatch: { patchContent: "--- a\n+++ b\n-old\n+new\n context" } });
  assert.equal(patched.preview, "-old\n+new");
});

test("a lone side of an edit adds no bare marker line", () => {
  assert.equal(describeToolInput({ file_path: "a.ts", old_string: "gone" }).preview, "-gone");
  assert.equal(describeToolInput({ file_path: "a.ts", content: "line1\nline2" }).preview, "+line1\n+line2");
  assert.equal(describeToolInput({ file_path: "a.ts", old_string: "", new_string: "" }).preview, undefined);
});

test("huge inputs are only read by a bounded prefix", () => {
  const huge = "line\n".repeat(2_000_000);
  const started = Date.now();
  const described = describeToolInput({ file_path: "big.txt", old_string: huge, new_string: huge });
  assert.ok(Date.now() - started < 500);
  assert.equal(described.preview?.split("\n").length, 6);
});
