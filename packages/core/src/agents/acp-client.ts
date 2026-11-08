// packages/core/src/agents/acp-client.ts
//
// A minimal Agent Client Protocol (ACP, https://agentclientprotocol.com)
// client: JSON-RPC 2.0, one message per line, over a child process's stdio.
//
// Only what a non-interactive Codey turn needs is here: send requests and
// await their results, receive notifications, and answer the requests the
// agent sends back (permission prompts). We declare no fs/terminal client
// capabilities, so the agent does its own file and shell work and never asks
// us to.
//
// Kept free of any particular agent's details so a second ACP agent can reuse
// it unchanged.

import type { Readable, Writable } from 'stream';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC error raised from a request. Keeps the agent's code and data. */
export class AcpRequestError extends Error {
  constructor(readonly method: string, readonly rpc: JsonRpcError) {
    super(rpc.message || `ACP ${method} failed`);
    this.name = 'AcpRequestError';
  }

  /** The error text plus any string `data` the agent attached. */
  get detail(): string {
    const data = typeof this.rpc.data === 'string' ? this.rpc.data : '';
    return data && !this.message.includes(data) ? `${this.message}: ${data}` : this.message;
  }
}

/** Handler for a request the agent sends us. Return the result; throw an
 *  AcpRequestError (or anything) to reply with an error. */
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type AcpNotificationHandler = (method: string, params: unknown) => void;

/** Any JSON-RPC 2.0 message: a request (method + id), a notification
 *  (method, no id), or a response (id + result | error). */
interface JsonRpcMessage {
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** JSON-RPC "method not found". */
export const METHOD_NOT_FOUND = -32601;

export class AcpClient {
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, Pending>();
  private closedError?: Error;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: {
      onNotification?: AcpNotificationHandler;
      onRequest?: AcpRequestHandler;
    } = {},
  ) {
    input.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()));
    // Writing to an agent that already died fails asynchronously (EPIPE) as an
    // 'error' event. Unheard, that event throws and takes the whole gateway
    // down; heard, it just fails the waiting requests. The process 'close'
    // handler reports the real reason, so this one only steps in first.
    const onStreamError = (err: Error) => this.close(new Error(`agent pipe closed: ${err.message}`));
    output.on('error', onStreamError);
    input.on('error', onStreamError);
  }

  /** Send a request and wait for its result. Rejects with AcpRequestError on
   *  an error reply, or with the close reason if the process goes away. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // The agent's reply is untyped JSON; the caller names what it expects.
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification (no reply expected). */
  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Fail every request still waiting, e.g. when the process exits. */
  close(reason: Error): void {
    if (this.closedError) return;
    this.closedError = reason;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  private write(message: unknown): void {
    try {
      this.output.write(JSON.stringify(message) + '\n');
    } catch {
      // stdin already closed — the close handler reports why.
    }
  }

  private onData(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // Not JSON — ignore, as the other adapters do.
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (hasId) void this.answer(message.id as number | string, message.method, message.params);
      else this.handlers.onNotification?.(message.method, message.params);
      return;
    }
    if (!hasId) return;
    const id = message.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) pending.reject(new AcpRequestError(pending.method, message.error));
    else pending.resolve(message.result);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.handlers.onRequest) {
      this.write({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      const rpc: JsonRpcError = err instanceof AcpRequestError
        ? err.rpc
        : { code: -32603, message: err instanceof Error ? err.message : String(err) };
      this.write({ jsonrpc: '2.0', id, error: rpc });
    }
  }
}
