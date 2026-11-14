import type { Backend } from "./types.js";

/**
 * The upstream provider a turn bills against, when the backend makes it knowable from the model id.
 * OpenCode ids are `provider/model` (`mistral/codestral-latest` → `mistral`); Vibe reports the
 * provider per turn instead (see the Vibe adapter), so it is not derivable here.
 */
export function providerOf(backend: Backend, model: string): string | undefined {
  if (backend !== "opencode") return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

/** What kind of provider failure a turn hit, when it can be told from the error. */
export type ProviderErrorClass = "rate_limit" | "auth" | "quota";

/**
 * Classify a provider error by HTTP status first, then by message text. Unknown errors stay
 * unclassified rather than being guessed into a class that would trigger a cooldown.
 */
export function classifyProviderError(message: string, statusCode?: number): ProviderErrorClass | undefined {
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 401 || statusCode === 403) return "auth";
  if (statusCode === 402) return "quota";
  if (/\b429\b|rate[ _-]?limit|too many requests|requests per (second|minute)|throttl/i.test(message)) return "rate_limit";
  if (/\b40[13]\b|unauthori[sz]ed|invalid (api )?key|api key (is )?(invalid|missing)|authentication|forbidden/i.test(message)) return "auth";
  if (/\b402\b|insufficient (funds|credit|balance)|quota exceeded|exceeded your (current )?quota|billing/i.test(message)) return "quota";
  return undefined;
}
