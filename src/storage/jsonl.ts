import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JsonlEnvelope<T> {
  readonly line: number;
  readonly value: T;
}

/** Per-process serialized append-only JSONL writer. Each record is one atomic append call. */
export class AppendOnlyJsonlStore<T> {
  #tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  append(value: T): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) return Promise.reject(new TypeError("JSONL values must be serializable"));
    const serialized = `${json}\n`;
    const operation = this.#tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, serialized, { encoding: "utf8", flag: "a", mode: 0o600 });
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  /** Recover a torn final append before accepting more records after a crash. */
  async repairTail(): Promise<void> {
    await this.#tail;
    let source: string;
    try { source = await readFile(this.path, 'utf8'); }
    catch(error) { if (isErrno(error, 'ENOENT')) return; throw error; }
    if (!source || source.endsWith('\n')) return;
    const boundary = source.lastIndexOf('\n') + 1;
    let repaired: string;
    try { JSON.parse(source.slice(boundary)); repaired = source + '\n'; }
    catch { repaired = source.slice(0, boundary); }
    await writeFile(this.path, repaired, { encoding: 'utf8', mode: 0o600 });
  }

  async readAll(): Promise<readonly JsonlEnvelope<T>[]> {
    await this.#tail;
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const records: JsonlEnvelope<T>[] = [];
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") continue;
      try {
        records.push({ line: index + 1, value: JSON.parse(line) as T });
      } catch (error) {
        const isLastLine = index === lines.length - 1;
        if (isLastLine) break; // an unfsynced crash tail; prior valid history is still returned
        throw new SyntaxError(
          `Invalid JSONL at ${this.path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return records;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
