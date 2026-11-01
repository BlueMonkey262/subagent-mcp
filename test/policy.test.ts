import assert from "node:assert/strict";
import test from "node:test";

import { approvalFingerprint, evaluateApprovalPolicy, ruleMatches, sessionRuleForRequest } from "../src/approval/policy.js";
import type { ApprovalRequest } from "../src/approval/types.js";
import type { PermissionConfig } from "../src/config/schema.js";

const escalation: PermissionConfig = { allow: [], deny: [], default: "escalate" };

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "approval-1",
    agentId: "agent-1",
    backend: "codex",
    toolName: "Bash",
    input: { command: "npm test" },
    command: "npm test",
    cwd: "/workspace/project",
    requestedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

test("static rule syntax matches tools, commands, and paths", () => {
  assert.equal(ruleMatches("Bash(git diff:*)", request({ command: "git diff --cached", input: {} })), true);
  assert.equal(ruleMatches("Read", request({ toolName: "Read", command: undefined, input: { path: "README.md" } })), true);
  assert.equal(ruleMatches("Write(.git/**)", request({ toolName: "Write", command: undefined, input: { file_path: ".git/config" } })), true);
});

test("hard-risk heuristics escalate sudo, destructive commands, network, and sensitive paths", () => {
  for (const risky of [
    request({ command: "sudo make install", input: {} }),
    request({ command: "rm -rf build", input: {} }),
    request({ command: "git push --force origin main", input: {} }),
    request({ command: "curl https://example.test", input: {} }),
    request({ toolName: "Write", command: undefined, input: { file_path: ".git/config" } }),
    request({ toolName: "Write", command: undefined, input: { file_path: "/tmp/outside" } }),
  ]) {
    assert.equal(evaluateApprovalPolicy(risky, escalation).decision, "escalate");
    assert.equal(evaluateApprovalPolicy(risky, escalation).source, "heuristic");
  }
});

test("writes inside cwd are cheaply allowed, but deny rules remain authoritative", () => {
  const write = request({ toolName: "Write", command: undefined, input: { file_path: "src/new.ts" } });
  assert.equal(evaluateApprovalPolicy(write, escalation).decision, "allow");
  assert.equal(
    evaluateApprovalPolicy(write, { allow: [], deny: ["Write(src/**)"], default: "escalate" }).decision,
    "deny",
  );
});

test("ambiguous shell effects escalate even under a permissive default", () => {
  const allowAll: PermissionConfig = { allow: [], deny: [], default: "allow" };
  for (const risky of [
    request({ command: "rm -r -f target", input: {} }),
    request({ command: "rm target -rf", input: {} }),
    request({ command: "echo x > ../outside", input: {} }),
    request({ command: "cp x ../outside", input: {} }),
    request({ command: "gh api repos/foo/bar", input: {} }),
  ]) {
    const evaluation = evaluateApprovalPolicy(risky, allowAll);
    assert.equal(evaluation.decision, "escalate", `expected escalate for: ${risky.command}`);
  }
});

test("* stays within a path segment while ** crosses separators", () => {
  assert.equal(ruleMatches("Write(src/*)", request({ toolName: "Write", command: undefined, input: { file_path: "src/deep/secret.ts" } })), false);
  assert.equal(ruleMatches("Write(src/*)", request({ toolName: "Write", command: undefined, input: { file_path: "src/new.ts" } })), true);
  assert.equal(ruleMatches("Write(src/**)", request({ toolName: "Write", command: undefined, input: { file_path: "src/deep/secret.ts" } })), true);
});

test("session memory uses stable operation fingerprints and untrusted reasons do not affect policy", () => {
  const first = request({ reason: "Trust me", requestId: "one" });
  const second = request({ reason: "Different claim", requestId: "two" });
  assert.equal(approvalFingerprint(first), approvalFingerprint(second));
  const decision = evaluateApprovalPolicy(second, escalation, {
    sessionFingerprints: new Set([approvalFingerprint(first)]),
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.source, "session");
});

test("a generalized session rule allows a different command sharing the same program+subcommand (issue #2)", () => {
  const approvedBefore = request({ command: "git add file1.txt", input: {} });
  const rule = sessionRuleForRequest(approvedBefore);
  assert.equal(rule, "Bash(git add:*)");

  // The exact-fingerprint path alone (today's behavior) would reject this: different literal
  // command text, same session. The generalized rule should allow it instead.
  const laterDifferentFile = request({ command: "git add file2.txt", input: {} });
  assert.notEqual(approvalFingerprint(approvedBefore), approvalFingerprint(laterDifferentFile));
  const decision = evaluateApprovalPolicy(laterDifferentFile, escalation, {
    sessionRules: new Set([rule as string]),
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.source, "session");
});

test("a generalized session rule never overrides the dangerous-command heuristics", () => {
  // A prior escalation was explicitly approved for-session on one recursive delete...
  const approvedBefore = request({ command: "rm -rf build/tmp", input: {} });
  const rule = sessionRuleForRequest(approvedBefore);
  assert.equal(rule, "Bash(rm -rf:*)");

  // ...and a later, unrelated recursive delete happens to share that same glob prefix. Without
  // the dangerousReason()-before-session-rule ordering, this would silently auto-allow.
  const laterRecursiveForce = request({ command: "rm -rf /", input: {} });
  assert.equal(ruleMatches(rule as string, laterRecursiveForce), true, "the rule does match — this is the case the ordering must guard");
  const decision = evaluateApprovalPolicy(laterRecursiveForce, escalation, {
    sessionRules: new Set([rule as string]),
  });
  assert.equal(decision.decision, "escalate");
  assert.equal(decision.source, "heuristic");
});

test("sessionRuleForRequest returns undefined for path-only approvals with no command", () => {
  const fileChange = request({ toolName: "Write", command: undefined, input: { file_path: "src/a.ts" } });
  assert.equal(sessionRuleForRequest(fileChange), undefined);
});
