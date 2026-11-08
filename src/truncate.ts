export const MAX_CONTENT_CHARS = 4_000;

export interface TruncatedText {
  readonly text: string;
  readonly truncatedChars: number;
}

/** Keeps a text prefix without splitting a Unicode surrogate pair. */
export function truncateText(text: string, maxChars = MAX_CONTENT_CHARS): TruncatedText {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new RangeError("maxChars must be a positive integer");
  const characters = Array.from(text);
  if (characters.length <= maxChars) return { text, truncatedChars: 0 };
  return {
    text: characters.slice(0, maxChars).join(""),
    truncatedChars: characters.length - maxChars,
  };
}
