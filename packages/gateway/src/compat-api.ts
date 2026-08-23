import * as http from 'http';
import { CodingAgent } from '@codey/core';
import { ChatStreamSink } from './chat-runner';
import { RouterApiHost } from './router-api';

/**
 * OpenAI- and Anthropic-shaped endpoints, so existing tools can point at Codey
 * without knowing anything about Codey.
 *
 *   OPENAI_BASE_URL=http://127.0.0.1:3000/v1  OPENAI_API_KEY=<codey token>
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:3000  ANTHROPIC_API_KEY=<codey token>
 *
 * What is deliberately NOT claimed: Codey is an agent, not a model server. It
 * edits files, runs commands and takes tens of seconds. These endpoints speak
 * the providers' wire format faithfully enough for a client library to work —
 * request shape, response shape, SSE framing, error shape — but features that
 * only make sense for a raw model (tool_calls, logprobs, n>1, temperature) are
 * accepted and ignored rather than half-implemented.
 *
 * Statelessness is the important design point. Both provider APIs are
 * stateless: the client owns the history and resends it every turn. Codey's own
 * `/v1/prompt` keeps history server-side. Mixing them would double every
 * message, so by default a compat request flattens the client's `messages` into
 * one prompt and runs it in a throwaway chat. A client that wants Codey's
 * server-side context opts in with `X-Codey-Session-Id`, and then only the last
 * user message is sent.
 *
 * TODO: once #332 (per-token session retention) lands on this branch, stamp the
 * chats created here with the token's `retentionDays` the way `router-api.ts`
 * does — a stateless compat call creates a chat per request, so it is the
 * biggest producer of the pile-up that retention exists to clean up.
 */

export interface CompatOptions {
  timeoutSec: number;
  /** Fallback workspace when the request does not name one. */
  defaultWorkspace?: string;
}

/** Which provider's dialect a request is speaking. */
type Dialect = 'openai' | 'anthropic';

const MAX_BODY_BYTES = 1024 * 1024;
const AGENTS: readonly CodingAgent[] = ['claude-code', 'opencode', 'codex', 'pi'];

class CompatError extends Error {
  constructor(readonly status: number, message: string, readonly kind = 'invalid_request_error') {
    super(message);
  }
}

/** One message as either provider sends it. Content may be text or blocks. */
interface WireMessage {
  role: string;
  content: unknown;
}

export class CompatApi {
  private readonly host: RouterApiHost;
  private readonly options: () => CompatOptions;
  /** sessionId → chatId, for callers that opt into server-side context. */
  private readonly sessions = new Map<string, string>();

  constructor(host: RouterApiHost, options: () => CompatOptions) {
    this.host = host;
    this.options = options;
  }

  /** Returns false when the path is not one of ours. */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
  ): Promise<boolean> {
    if (url === '/v1/models' && req.method === 'GET') {
      this.listModels(res);
      return true;
    }
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      await this.completion(req, res, 'openai');
      return true;
    }
    if (url === '/v1/messages' && req.method === 'POST') {
      await this.completion(req, res, 'anthropic');
      return true;
    }
    return false;
  }

  /**
   * `GET /v1/models` in OpenAI's shape. Many clients call this to populate a
   * model picker or to validate the model name before the first request.
   */
  private listModels(res: http.ServerResponse): void {
    const created = 0; // Codey's catalog has no creation timestamps.
    sendJson(res, 200, {
      object: 'list',
      data: this.host.getModelNames().map(id => ({
        id,
        object: 'model',
        created,
        owned_by: 'codey',
      })),
    });
  }

  private async completion(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    dialect: Dialect,
  ): Promise<void> {
    let streaming = false;
    try {
      const body = await readBody(req);
      const parsed = this.parse(body, dialect);
      streaming = parsed.stream;

      const chatId = this.resolveChat(req, parsed);

      if (parsed.stream) {
        await this.streamTurn(res, dialect, chatId, parsed);
        return;
      }

      const result = await this.runWithTimeout(chatId, parsed.prompt);
      sendJson(res, 200, dialect === 'openai'
        ? openAiResponse(parsed.model, result.response, result.tokens)
        : anthropicResponse(parsed.model, result.response, result.tokens));
    } catch (err) {
      // Once an SSE body has started the status line is gone; the failure has
      // to reach the client as a stream event instead of an HTTP code.
      if (res.headersSent) {
        writeSse(res, dialect === 'openai' ? null : 'error', {
          type: 'error',
          error: { type: 'api_error', message: (err as Error).message },
        });
        res.end();
        return;
      }
      const status = err instanceof CompatError ? err.status : 500;
      const kind = err instanceof CompatError ? err.kind : 'api_error';
      sendJson(res, status, errorBody(dialect, status, kind, (err as Error).message));
    }
    void streaming;
  }

  // ── request parsing ─────────────────────────────────────────────

  private parse(body: unknown, dialect: Dialect): ParsedRequest {
    if (!body || typeof body !== 'object') throw new CompatError(400, 'Request body must be a JSON object');
    const b = body as Record<string, unknown>;

    if (typeof b.model !== 'string' || !b.model.trim()) {
      throw new CompatError(400, 'model is required');
    }
    const { model, agent } = this.resolveModel(b.model.trim());

    const raw = b.messages;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new CompatError(400, 'messages must be a non-empty array');
    }
    const messages = raw as WireMessage[];

    // Anthropic carries the system prompt in a top-level field; OpenAI puts it
    // in the messages array as role:"system".
    const systemParts: string[] = [];
    if (dialect === 'anthropic' && b.system !== undefined) {
      systemParts.push(extractText(b.system));
    }

    return {
      model,
      agent,
      stream: b.stream === true,
      messages,
      system: systemParts.filter(Boolean).join('\n\n'),
      prompt: '', // filled by resolveChat, which knows whether a session is in play
    };
  }

  /**
   * Map the client's model string onto Codey's catalog.
   *
   * Accepts a bare catalog name (`claude-opus-5`) or an explicit agent prefix
   * (`codex/gpt-5`) for callers that care which CLI runs. An unknown name is a
   * 404 listing what is available — clients surface that message, so it should
   * say something useful.
   */
  private resolveModel(raw: string): { model: string; agent?: CodingAgent } {
    let agent: CodingAgent | undefined;
    let model = raw;

    const slash = raw.indexOf('/');
    if (slash > 0) {
      const prefix = raw.slice(0, slash);
      if (AGENTS.includes(prefix as CodingAgent)) {
        agent = prefix as CodingAgent;
        model = raw.slice(slash + 1);
      }
    }

    const known = this.host.getModelNames();
    if (!known.includes(model)) {
      throw new CompatError(
        404,
        `Unknown model: ${model}. Available: ${known.join(', ') || '(none configured)'}`,
        'not_found_error',
      );
    }
    return { model, agent };
  }

  /**
   * Pick the chat this request runs in, and decide what text to send it.
   *
   * Without a session header the request is stateless the way both provider
   * APIs are: a fresh chat, and the client's whole `messages` array flattened
   * into the prompt. With one, Codey already holds the history, so only the
   * newest user message is sent — replaying the array too would duplicate
   * everything the chat has already seen.
   */
  private resolveChat(req: http.IncomingMessage, parsed: ParsedRequest): string {
    const sessionId = headerValue(req, 'x-codey-session-id');
    const workspace = this.pickWorkspace(headerValue(req, 'x-codey-workspace'));

    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing && this.host.hasChat(existing)) {
        parsed.prompt = lastUserText(parsed.messages);
        if (!parsed.prompt) throw new CompatError(400, 'messages must end with a user message');
        return existing;
      }
      const chat = this.host.createApiChat({
        workspaceName: workspace,
        title: `API: ${sessionId}`,
        agent: parsed.agent,
        model: parsed.model,
      });
      this.sessions.set(sessionId, chat.id);
      parsed.prompt = flatten(parsed.system, parsed.messages);
      return chat.id;
    }

    const chat = this.host.createApiChat({
      workspaceName: workspace,
      title: 'API: compat',
      agent: parsed.agent,
      model: parsed.model,
    });
    parsed.prompt = flatten(parsed.system, parsed.messages);
    return chat.id;
  }

  private pickWorkspace(requested: string | undefined): string {
    const workspaces = this.host.getWorkspaceList();
    if (requested) {
      if (!workspaces.includes(requested)) {
        throw new CompatError(404, `Unknown workspace: ${requested}`, 'not_found_error');
      }
      return requested;
    }
    const fallback = this.options().defaultWorkspace;
    if (fallback && workspaces.includes(fallback)) return fallback;
    if (workspaces.length === 0) throw new CompatError(503, 'No workspaces are configured', 'api_error');
    return workspaces[0];
  }

  // ── running ─────────────────────────────────────────────────────

  private async runWithTimeout(chatId: string, prompt: string) {
    const timeoutSec = this.options().timeoutSec;
    const noop: ChatStreamSink = () => { /* non-streaming callers discard events */ };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CompatError(504, `Agent did not respond within ${timeoutSec}s`, 'api_error')),
        timeoutSec * 1000,
      );
    });
    try {
      return await Promise.race([this.host.sendToChat(chatId, prompt, noop), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Stream in the provider's own SSE dialect.
   *
   * Only the assistant's text is forwarded. Codey's tool_start/checklist/worker
   * events have no representation in either wire format, and inventing one
   * would break the clients this exists to support.
   */
  private async streamTurn(
    res: http.ServerResponse,
    dialect: Dialect,
    chatId: string,
    parsed: ParsedRequest,
  ): Promise<void> {
    const id = dialect === 'openai' ? `chatcmpl-${randomId()}` : `msg_${randomId()}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let aborted = false;
    const onClose = () => { aborted = true; };
    res.on('close', onClose);

    if (dialect === 'openai') {
      // OpenAI clients expect the role to arrive in its own first delta.
      writeSse(res, null, openAiChunk(id, parsed.model, { role: 'assistant', content: '' }));
    } else {
      writeSse(res, 'message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', model: parsed.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      writeSse(res, 'content_block_start', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      });
    }

    // Codey emits `stream` tokens as the agent talks; anything else is
    // Codey-specific and has no place in a provider stream.
    let streamed = '';
    const sink: ChatStreamSink = (event) => {
      if (aborted || event.type !== 'stream' || !event.token) return;
      streamed += event.token;
      if (dialect === 'openai') {
        writeSse(res, null, openAiChunk(id, parsed.model, { content: event.token }));
      } else {
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: event.token },
        });
      }
    };

    const timeoutSec = this.options().timeoutSec;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CompatError(504, `Agent did not respond within ${timeoutSec}s`, 'api_error')),
        timeoutSec * 1000,
      );
    });

    try {
      const result = await Promise.race([this.host.sendToChat(chatId, parsed.prompt, sink), timeout]);
      if (aborted) return;

      // Not every agent streams tokens. When none arrived, deliver the final
      // text in one delta so a streaming client still receives the answer
      // rather than an empty message.
      if (!streamed && result.response) {
        if (dialect === 'openai') {
          writeSse(res, null, openAiChunk(id, parsed.model, { content: result.response }));
        } else {
          writeSse(res, 'content_block_delta', {
            type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text: result.response },
          });
        }
      }

      if (dialect === 'openai') {
        writeSse(res, null, openAiChunk(id, parsed.model, {}, 'stop'));
        res.write('data: [DONE]\n\n');
      } else {
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        writeSse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: result.tokens ?? 0 },
        });
        writeSse(res, 'message_stop', { type: 'message_stop' });
      }
    } catch (err) {
      if (!aborted) {
        writeSse(res, dialect === 'openai' ? null : 'error', {
          type: 'error',
          error: { type: 'api_error', message: (err as Error).message },
        });
        if (dialect === 'openai') res.write('data: [DONE]\n\n');
      }
    } finally {
      if (timer) clearTimeout(timer);
      res.off('close', onClose);
      if (!aborted) res.end();
    }
  }
}

interface ParsedRequest {
  model: string;
  agent?: CodingAgent;
  stream: boolean;
  messages: WireMessage[];
  system: string;
  prompt: string;
}

// ── wire shapes ───────────────────────────────────────────────────

function openAiResponse(model: string, text: string, tokens?: number) {
  return {
    id: `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    // Codey reports one total for the turn; it cannot split input from output.
    // Reporting the total as completion tokens keeps the sum honest.
    usage: { prompt_tokens: 0, completion_tokens: tokens ?? 0, total_tokens: tokens ?? 0 },
  };
}

function anthropicResponse(model: string, text: string, tokens?: number) {
  return {
    id: `msg_${randomId()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: tokens ?? 0 },
  };
}

function openAiChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Each provider reports failures in its own envelope; clients parse for it. */
function errorBody(dialect: Dialect, status: number, kind: string, message: string) {
  if (dialect === 'openai') {
    return { error: { message, type: kind, param: null, code: String(status) } };
  }
  return { type: 'error', error: { type: kind, message } };
}

// ── helpers ───────────────────────────────────────────────────────

/**
 * Flatten a provider conversation into a single prompt.
 *
 * The agent receives one block of text, so the roles have to survive as
 * labels — without them a multi-turn history reads as one run-on message and
 * the agent loses track of who said what.
 */
function flatten(system: string, messages: WireMessage[]): string {
  const parts: string[] = [];
  if (system) parts.push(system);

  const body = messages.filter(m => m.role !== 'system');
  const systemInline = messages.filter(m => m.role === 'system').map(m => extractText(m.content));
  for (const s of systemInline) if (s) parts.unshift(s);

  if (body.length === 1 && body[0].role === 'user') {
    // The common case: one question, no history. Send it as-is rather than
    // wrapping a bare question in conversation scaffolding.
    const text = extractText(body[0].content);
    if (!text) throw new CompatError(400, 'messages must contain text content');
    parts.push(text);
    return parts.join('\n\n');
  }

  for (const m of body) {
    const text = extractText(m.content);
    if (!text) continue;
    parts.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
  }
  const flat = parts.join('\n\n');
  if (!flat.trim()) throw new CompatError(400, 'messages must contain text content');
  return flat;
}

/** The newest user message, for session-backed requests. */
function lastUserText(messages: WireMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return extractText(messages[i].content);
  }
  return '';
}

/**
 * Pull text out of a content field. Both APIs accept a plain string or an array
 * of typed blocks; non-text blocks (images, tool results) are skipped rather
 * than rejected, so a client sending them still gets an answer to its text.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && (block as any).type === 'text') {
          return String((block as any).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/** One SSE frame. Anthropic names its events; OpenAI sends bare `data:`. */
function writeSse(res: http.ServerResponse, event: string | null, payload: unknown): void {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Drain rather than destroy: killing the socket mid-upload reaches the
        // client as a reset instead of the 413 that explains what went wrong.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new CompatError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        reject(new CompatError(400, 'Request body must be a JSON object'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new CompatError(400, 'Invalid JSON'));
      }
    });
    req.on('error', err => reject(err));
  });
}
