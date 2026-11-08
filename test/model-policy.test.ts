import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPolicyEnv,
  BLOCK_CLAUDE_MODELS_ENV,
  BLOCK_MODELS_ENV,
  blockReason,
  DISABLED_BACKENDS_ENV,
  isClaudeModel,
  ModelBlockedError,
  OPEN_POLICY,
} from "../src/core/model-policy.js";

test("isClaudeModel catches Claude on every backend and spares endpoint models", () => {
  // The Claude CLI sends bare ids and aliases to Anthropic.
  for (const model of ["claude-sonnet-5", "sonnet", "opus", "haiku", "claude-haiku-4-5-20251001"]) {
    assert.equal(isClaudeModel("claude", model), true, model);
  }
  // Its <endpoint>/<alias> models go through the local proxy to other providers.
  assert.equal(isClaudeModel("claude", "nim/nemotron"), false);
  assert.equal(isClaudeModel("claude", "nim/claude-like"), true, "an endpoint alias naming Claude is still refused");
  // The part before the first "/" is a provider or endpoint name, not the model.
  for (const backend of ["claude", "codex", "opencode"] as const) {
    assert.equal(isClaudeModel(backend, "claude-proxy/glm-5.3-flash"), false, `${backend}: endpoint named claude-proxy`);
    assert.equal(isClaudeModel(backend, "claude/kimi-k3"), false, `${backend}: endpoint named claude`);
  }
  assert.equal(isClaudeModel("cursor", "bedrock/anthropic.sonnet-4-5"), true, "a dotted anthropic provider");
  assert.equal(isClaudeModel("opencode", "anthropic/model-x"), true);
  // Other backends: by id (ids as listed by `agent --list-models` and opencode's /api/model).
  assert.equal(isClaudeModel("cursor", "claude-opus-5-5-high"), true);
  assert.equal(isClaudeModel("opencode", "opencode/claude-sonnet-5-5"), true);
  assert.equal(isClaudeModel("opencode", "openrouter/anthropic/some-model"), true);
  assert.equal(isClaudeModel("antigravity", "claude-sonnet-5"), true);
  for (const [backend, model] of [["codex", "gpt-5.6-luna"], ["cursor", "auto"], ["cursor", "grok-4.7-high"],
    ["opencode", "opencode-go/deepseek-v4.1-flash"], ["antigravity", "gemini-3.8-flash-low"]] as const) {
    assert.equal(isClaudeModel(backend, model), false, `${backend} ${model}`);
  }
});

test("blockReason: disabled backends, then the Claude block, then model patterns", () => {
  const policy = {
    blockClaudeModels: true,
    disabledBackends: ["antigravity" as const],
    blockModels: ["*grok*", "codex:gpt-5.6-sol", "ollama-cloud/gpt-oss:*"],
  };
  assert.deepEqual(blockReason(policy, "antigravity", "gemini-3.8-flash-low"), { kind: "backend" });
  assert.deepEqual(blockReason(policy, "cursor", "claude-opus-5-5-high"), { kind: "claude" });
  assert.deepEqual(blockReason(policy, "cursor", "GROK-4.7-high"), { kind: "pattern", pattern: "*grok*" }, "case-insensitive");
  assert.deepEqual(blockReason(policy, "codex", "gpt-5.6-sol"), { kind: "pattern", pattern: "codex:gpt-5.6-sol" });
  assert.equal(blockReason(policy, "opencode", "gpt-5.6-sol"), undefined, "a backend: prefix scopes the pattern");
  assert.equal(blockReason(policy, "codex", "gpt-5x6-sol"), undefined, "a dot in a pattern is literal");
  assert.deepEqual(blockReason(policy, "opencode", "ollama-cloud/gpt-oss:20b"),
    { kind: "pattern", pattern: "ollama-cloud/gpt-oss:*" }, "a colon after a non-backend prefix is part of the id");
  assert.equal(blockReason(policy, "codex", "gpt-5.6-luna"), undefined);
  assert.equal(blockReason(OPEN_POLICY, "claude", "claude-sonnet-5"), undefined);
});

test("refusals carry a code per kind and tell the caller what to do instead", () => {
  const backend = new ModelBlockedError({ kind: "backend" }, "cursor", "auto");
  assert.equal(backend.code, "BACKEND_DISABLED");
  assert.match(backend.message, /cursor backend is disabled/);
  assert.equal(new ModelBlockedError({ kind: "claude" }, "claude", "sonnet").code, "CLAUDE_MODEL_BLOCKED");
  assert.match(new ModelBlockedError({ kind: "claude" }, "claude", "sonnet").message, /built-in Agent tool/);
  const pattern = new ModelBlockedError({ kind: "pattern", pattern: "*grok*" }, "cursor", "grok-4.7-high");
  assert.equal(pattern.code, "MODEL_BLOCKED");
  assert.deepEqual(pattern.details, { backend: "cursor", model: "grok-4.7-high", pattern: "*grok*" });
});

test("the environment forces the Claude switch and adds to the block lists", () => {
  const file = { blockClaudeModels: true, disabledBackends: ["cursor" as const], blockModels: ["*grok*"] };
  assert.deepEqual(applyPolicyEnv(file, {}), file);
  assert.equal(applyPolicyEnv(file, { [BLOCK_CLAUDE_MODELS_ENV]: "0" }).blockClaudeModels, false);
  assert.equal(applyPolicyEnv(OPEN_POLICY, { [BLOCK_CLAUDE_MODELS_ENV]: "true" }).blockClaudeModels, true);
  const merged = applyPolicyEnv(file, { [DISABLED_BACKENDS_ENV]: "Antigravity, cursor", [BLOCK_MODELS_ENV]: "codex:gpt-5.6-sol,*grok*" });
  assert.deepEqual(merged.disabledBackends, ["cursor", "antigravity"]);
  assert.deepEqual(merged.blockModels, ["*grok*", "codex:gpt-5.6-sol"]);
  assert.throws(() => applyPolicyEnv(OPEN_POLICY, { [BLOCK_CLAUDE_MODELS_ENV]: "maybe" }), /must be 1\/true or 0\/false/);
  assert.throws(() => applyPolicyEnv(OPEN_POLICY, { [DISABLED_BACKENDS_ENV]: "copilot" }), /"copilot" is not a backend/);
});
