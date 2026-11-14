import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Minimal Agent Client Protocol client: JSON-RPC 2.0, one JSON message per line on the agent's
 * stdio (https://agentclientprotocol.com). It sends requests and notifications, and hands the
 * agent's own requests (`session/request_permission`, `fs/*`, ...) and notifications
 * (`session/update`) to the owner. It does not interpret ACP semantics.
 */

export interface AcpRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class AcpRequestError extends Error {
  constructor(readonly method: string, readonly error: AcpRpcError) {
    super(`${method} failed: ${error.message}${error.data === undefined ? "" : ` (${safeJson(error.data)})`}`);
  }
}

export interface AcpIncomingRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AcpClientHandlers {
  /** A request from the agent. Reply later with `respond` or `respondError`. */
  readonly onRequest: (request: AcpIncomingRequest) => void;
  readonly onNotification: (method: string, params: Readonly<Record<string, unknown>>) => void;
  /** A stdout line that is not a JSON-RPC message. */
  readonly onProtocolNoise?: (line: string) => void;
  /** The process exited or its stdout closed. Pending requests have already been rejected. */
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

export class AcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #handlers: AcpClientHandlers;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  stderr = "";

  constructor(child: ChildProcessWithoutNullStreams, handlers: AcpClientHandlers, stderrLimitBytes = 32 * 1024) {
    this.#child = child;
    this.#handlers = handlers;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-stderrLimitBytes);
    });
    // Writes to an agent that already exited fail asynchronously; the close handler reports it.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => this.#close(null, null, error));
    child.on("close", (code, signal) => this.#close(code, signal));
  }

  get closed(): boolean {
    return this.#closed;
  }

  get child(): ChildProcessWithoutNullStreams {
    return this.#child;
  }

  request<T = unknown>(method: string, params: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`ACP agent is not running (${method})`));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Readonly<Record<string, unknown>>): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: unknown): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Close stdin, so a well-behaved agent exits on its own. */
  end(): void {
    if (!this.#closed) this.#child.stdin.end();
  }

  #write(message: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#handlers.onProtocolNoise?.(line);
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.#handlers.onProtocolNoise?.(line);
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (typeof message.method === "string") {
      if (message.id !== undefined && (typeof message.id === "number" || typeof message.id === "string")) {
        this.#handlers.onRequest({ id: message.id, method: message.method, params });
      } else {
        this.#handlers.onNotification(message.method, params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      const error = message.error;
      pending.reject(new AcpRequestError(pending.method, {
        code: typeof error.code === "number" ? error.code : -32603,
        message: typeof error.message === "string" ? error.message : "unknown error",
        ...(error.data === undefined ? {} : { data: error.data }),
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  #close(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const reason = error ?? new Error(`ACP agent exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.#handlers.onClose(code, signal);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value);
  }
}
