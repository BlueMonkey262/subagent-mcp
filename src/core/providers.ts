import type { Backend } from "./types.js";
import { classifyFailure } from "./failure.js";

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
 * Classify a provider error by HTTP status first, then by message text, by delegating to
 * `classifyFailure` so the cooldown decision and the error the agent reports are the same
 * judgement. Only the three classes that mean "back off" survive here; anything else stays
 * unclassified rather than being guessed into a class that would trigger a cooldown.
 * The one rule that lives here instead of in the shared engine is HTTP 402, which is billing.
 */
export function classifyProviderError(message: string, statusCode?: number): ProviderErrorClass | undefined {
  if (statusCode === 402) return "quota";
  const info = classifyFailure({
    message,
    ...(statusCode === undefined ? {} : { httpStatus: statusCode }),
  });
  const category = info.category;
  switch (category) {
    case "rate_limit":
    case "auth":
    case "quota":
      return category;
    default:
      return undefined;
  }
}
