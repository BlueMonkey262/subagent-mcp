/**
 * Fits a response into a character budget measured on its compact JSON, i.e. everything the caller
 * will see, metadata included. Every pass makes bounded progress, so the result always fits unless
 * the top-level scalars alone exceed the budget:
 *   1. cap every long string at a shrinking ceiling (down to 160 characters);
 *   2. drop trailing items from the largest arrays;
 *   3. cap nested strings further (down to 24 characters);
 *   4. drop the largest top-level objects or arrays, naming them in `omitted_fields`.
 */
export function fitToBudget<T extends Record<string, unknown>>(value: T, maxChars: number): T & { truncated?: true } {
  if (size(value) <= maxChars) return value;
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const omitted: string[] = [];
  const result = () => ({ ...copy, truncated: true as const, ...(omitted.length === 0 ? {} : { omitted_fields: omitted }) });
  const over = () => size(result()) > maxChars;

  let ceiling = longestString(copy, true);
  while (over() && ceiling > 160) {
    ceiling = Math.max(160, Math.floor(ceiling * 0.6));
    capStrings(copy, ceiling, true);
  }
  while (over()) {
    const array = largestArray(copy);
    if (array === undefined) break;
    const excess = size(result()) - maxChars;
    const average = size(array) / array.length;
    const drop = Math.min(array.length - 1, Math.max(1, Math.ceil(excess / Math.max(1, average))));
    array.splice(array.length - drop, drop);
  }
  while (over() && ceiling > 24) {
    ceiling = Math.max(24, Math.floor(ceiling / 2));
    capStrings(copy, ceiling, false);
  }
  while (over()) {
    const largest = Object.entries(copy)
      .filter(([, item]) => typeof item === "object" && item !== null)
      .sort(([, a], [, b]) => size(b) - size(a))[0];
    if (largest === undefined) break;
    delete copy[largest[0]];
    omitted.push(largest[0]);
  }
  return result() as unknown as T & { truncated: true };
}

function size(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function longestString(root: unknown, includeTop: boolean): number {
  let longest = 0;
  walk(root, 0, (text, depth) => { if (includeTop || depth > 0) longest = Math.max(longest, text.length); });
  return longest;
}

/** Top-level strings are capped only in the first pass (ids and statuses are far below 160). */
function capStrings(root: Record<string, unknown>, ceiling: number, includeTop: boolean): void {
  const visit = (container: Record<string, unknown> | unknown[], depth: number): void => {
    for (const key of Object.keys(container)) {
      const item = (container as Record<string, unknown>)[key];
      if (typeof item === "string") {
        if ((includeTop || depth > 0) && item.length > ceiling + 1) {
          (container as Record<string, unknown>)[key] = `${Array.from(item).slice(0, ceiling).join("")}…`;
        }
      } else if (typeof item === "object" && item !== null) {
        visit(item as Record<string, unknown>, depth + 1);
      }
    }
  };
  visit(root, 0);
}

function walk(item: unknown, depth: number, onString: (text: string, depth: number) => void): void {
  if (typeof item === "string") onString(item, depth - 1);
  else if (typeof item === "object" && item !== null) for (const child of Object.values(item)) walk(child, depth + 1, onString);
}

function largestArray(root: unknown): unknown[] | undefined {
  let best: { array: unknown[]; size: number } | undefined;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      if (item.length > 1) {
        const bytes = size(item);
        if (best === undefined || bytes > best.size) best = { array: item, size: bytes };
      }
      for (const child of item) visit(child);
    } else if (typeof item === "object" && item !== null) {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(root);
  return best?.array;
}

/** Pull a JSON value out of a reply that wraps it in a code fence or a sentence. */
export function extractJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  // The safety notice scanChildOutput puts in front of a report is a bracketed line, not data.
  const trimmed = text.trim().replace(/^\[Safety notice:[^\]\n]*\]\s*/, "");
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1]);
  // Otherwise each `{` or `[`, earliest first, with its own matching close: prose before the JSON can
  // hold a bracketed aside ("[as requested]"), which pairing the first opener with the last closer misses.
  let tries = 0;
  for (let start = 0; start < trimmed.length && tries < MAX_JSON_STARTS; start += 1) {
    const char = trimmed[start];
    if (char !== "{" && char !== "[") continue;
    tries += 1;
    const end = matchingClose(trimmed, start);
    if (end !== undefined) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try { return { ok: true, value: JSON.parse(candidate) as unknown }; } catch { /* next */ }
  }
  return { ok: false };
}

/** Openers tried before giving up, so a long reply full of brackets stays cheap. */
const MAX_JSON_STARTS = 64;

/** Index of the bracket that closes the one at `start`, skipping brackets inside JSON strings. */
function matchingClose(text: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return index;
    }
  }
  return undefined;
}
