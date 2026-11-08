import { scanChildOutput } from "./safety/output.js";

export interface ToolDescription {
  /** File path, command, pattern or URL the tool is working on. */
  readonly target?: string;
  /** Short preview of an edit (changed lines only), when the backend supplies one. */
  readonly preview?: string;
}

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const first = (input: Raw, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = str(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Changed lines of an edit, as `-old` / `+new`, a few lines each. */
function editPreview(oldText: string | undefined, newText: string | undefined): string | undefined {
  if (oldText === undefined && newText === undefined) return undefined;
  const lines = (text: string | undefined, mark: string) =>
    (text ?? "").split("\n").slice(0, 3).map((line) => `${mark}${clip(line, 100)}`);
  return [...lines(oldText, "-"), ...lines(newText, "+")].join("\n");
}

/**
 * Backend-neutral view of a tool call's raw input: what it touches and, for edits, what changes.
 * Each harness names these fields differently (file_path / filePath / path, command, old_string /
 * oldString, Codex fileChange `changes[]`, ...). Output is scanned like all child output.
 */
export function describeToolInput(input: unknown): ToolDescription {
  if (!isRecord(input)) return {};
  let target = first(input, ["file_path", "filePath", "path", "file", "command", "cmd", "pattern", "query", "url", "description"]);
  let preview = editPreview(first(input, ["old_string", "oldString", "old_str"]), first(input, ["new_string", "newString", "new_str", "content"]));

  const changes = input["changes"]; // Codex fileChange
  if (Array.isArray(changes) && changes.length > 0 && isRecord(changes[0])) {
    const paths = changes.filter(isRecord).map((c) => str(c["path"])).filter((p): p is string => p !== undefined);
    target = paths.length > 1 ? `${paths[0]} (+${paths.length - 1} more)` : paths[0] ?? target;
    const diff = str(changes[0]["diff"]);
    if (diff !== undefined) {
      preview = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).slice(0, 6).map((l) => clip(l, 100)).join("\n");
    }
  }

  return {
    ...(target === undefined ? {} : { target: scanChildOutput(clip(oneLine(target), 160)) }),
    ...(preview === undefined || preview === "" ? {} : { preview: scanChildOutput(preview) }),
  };
}
