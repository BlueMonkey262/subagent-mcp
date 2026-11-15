import assert from "node:assert/strict";
import test from "node:test";

import { classifyFailure, normalizeFailure } from "../src/core/failure.js";
import { classifyProviderError } from "../src/core/providers.js";

test("quota, auth, rate limit, and task failures get distinct automation categories", () => {
  const quota = classifyFailure({
    code: "CLAUDE_RESULT_ERROR",
    message: "Claude AI usage limit reached; resets in 3600s",
    subtype: "success",
  });
  assert.equal(quota.category, "quota");
  assert.equal(quota.retryable, false);
  assert.equal(quota.recommended_action, "quarantine");
  assert.equal(quota.retry_after_seconds, 3600);

  const auth = classifyFailure({ code: "CURSOR_TURN_FAILED", message: "Invalid API key: unauthorized" });
  assert.equal(auth.category, "auth");
  assert.equal(auth.recommended_action, "quarantine");

  const rate = classifyFailure({ code: "CURSOR_TURN_FAILED", message: "429 Too Many Requests, retry after 12 seconds" });
  assert.equal(rate.category, "rate_limit");
  assert.equal(rate.retryable, true);
  assert.equal(rate.recommended_action, "retry");
  assert.equal(rate.retry_after_seconds, 12);

  const task = classifyFailure({ code: "CODEX_TURN_FAILED", message: "The agent could not finish the task" });
  assert.equal(task.category, "task");
  assert.equal(task.recommended_action, "none");
});

test("structured status and subtype outrank generic code prefixes", () => {
  assert.equal(classifyFailure({ code: "CLAUDE_PROCESS_EXIT", message: "quota exceeded", httpStatus: 429 }).category, "rate_limit");
  assert.equal(classifyFailure({ code: "CLAUDE_RESULT_ERROR", message: "", subtype: "error_max_budget_usd" }).category, "quota");
  assert.equal(classifyFailure({ code: "CLAUDE_RESULT_ERROR", message: "", subtype: "error_max_turns" }).category, "task");
  assert.equal(classifyFailure({ code: "CODEX_PROCESS_EXIT", message: "process exited" }).category, "process");
  assert.equal(classifyFailure({ code: "CLAUDE_PROTOCOL_ERROR", message: "bad envelope" }).category, "protocol");
  assert.equal(classifyFailure({ code: "OPENCODE_POLL_ERROR", message: "fetch failed" }).category, "transport");
});

test("provider wording from the ensemble branch still classifies through the shared table", () => {
  for (const message of ["The upstream service throttled this request", "Rate window: requests per minute exceeded"]) {
    assert.equal(classifyFailure({ code: "OPENCODE_PROVIDER_ERROR", message }).category, "rate_limit", message);
    assert.equal(classifyProviderError(message), "rate_limit", message);
  }
  assert.equal(classifyFailure({ code: "OPENCODE_PROVIDER_ERROR", message: "Forbidden: this model is not available" }).category, "auth");
  assert.equal(classifyProviderError("Forbidden: this model is not available"), "auth");
});

test("legacy failed turns cannot retain a *_SUCCESS code", () => {
  const legacy = normalizeFailure({
    code: "CLAUDE_SUCCESS",
    message: "quota exceeded",
  }, { failed: true });
  assert.ok(legacy);
  assert.equal(legacy.code, "CLAUDE_RESULT_ERROR");
  assert.equal(legacy.category, "quota");
  assert.equal(legacy.source, "legacy");

  const fallback = normalizeFailure({ code: "CODEX_SUCCESS", message: "boom" }, { failed: true });
  assert.equal(fallback?.code, "TURN_FAILED");
});
