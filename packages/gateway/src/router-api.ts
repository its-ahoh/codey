import * as http from 'http';
import { ChatMessage, CodingAgent } from '@codey/core';
import { CHAT_CONTEXT_WINDOW, ChatStreamEvent, ChatStreamSink } from './chat-runner';

/**
 * The Router API: `/v1/*`, the entry point for programs rather than people.
 *
 * It deliberately owns no execution machinery. A request maps to a hidden chat
 * (`kind: 'api'`) and goes through `Gateway.sendToChat` — the same call the Mac
 * app, the channels and the automations make. Automations already proved this
 * path works with nobody watching; this is that path with an HTTP shell.
 *
 * Auth, CORS and origin checks happen upstream in `health.ts` before anything
 * here runs.
 */

/** The slice of `Codey` this module needs. Keeps the tests free of the real gateway. */
export interface RouterApiHost {
  getWorkspaceList(): string[];
  getTeamNames(): string[];
  getModelNames(): string[];
  getDefaultAgent(): string;
  getDefaultModel(): string;
  createApiChat(input: {
    workspaceName: string;
    title: string;
    selection?: { type: 'team'; name: string } | { type: 'none' };
    agent?: CodingAgent;
    model?: string;
  }): { id: string };
  hasChat(chatId: string): boolean;
  /** Recent messages for a session's chat, oldest first. */
  getChatMessages(chatId: string): ChatMessage[];
  deleteChat(chatId: string): void;
  sendToChat(
    chatId: string,
    text: string,
    sink: ChatStreamSink,
  ): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }>;
}

export interface RouterApiOptions {
  timeoutSec: number;
  rateLimitPerMin: number;
}

const AGENTS: readonly CodingAgent[] = ['claude-code', 'opencode', 'codex', 'pi'];
const MAX_BODY_BYTES = 1024 * 1024;

interface PromptRequest {
  prompt: string;
  stream: boolean;
  workspace?: string;
  agent?: CodingAgent;
  model?: string;
  team?: string;
  sessionId?: string;
}

/** Thrown for any request we can answer without running an agent. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class RouterApi {
  private readonly host: RouterApiHost;
  private readonly options: () => RouterApiOptions;
  /** sessionId → chatId. A session IS a hidden chat; this is just the lookup. */
  private readonly sessions = new Map<string, string>();
  /** Sessions with a request in flight. Concurrency on one session is a 409. */
  private readonly inFlight = new Set<string>();
  /** tokenId → recent request timestamps, trimmed to the last minute. */
  private readonly recentRequests = new Map<string, number[]>();

  constructor(host: RouterApiHost, options: () => RouterApiOptions) {
    this.host = host;
    this.options = options;
  }

  /**
   * Handle a `/v1/*` request. Returns false when the path is not one of ours,
   * so the caller can fall through to its own 404.
   */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    tokenId: string,
  ): Promise<boolean> {
    if (url === '/v1/capabilities' && req.method === 'GET') {
      send(res, 200, {
        workspaces: this.host.getWorkspaceList(),
        teams: this.host.getTeamNames(),
        agents: AGENTS,
        models: this.host.getModelNames(),
        defaults: { agent: this.host.getDefaultAgent(), model: this.host.getDefaultModel() },
      });
      return true;
    }

    if (url === '/v1/prompt' && req.method === 'POST') {
      await this.handlePrompt(req, res, tokenId);
      return true;
    }

    const session = /^\/v1\/sessions\/([^/]+)$/.exec(url);
    if (session) {
      const sessionId = decodeURIComponent(session[1]);
      if (req.method === 'GET') { this.handleGetSession(res, sessionId); return true; }
      if (req.method === 'DELETE') { this.handleDeleteSession(res, sessionId); return true; }
    }

    return false;
  }

  private async handlePrompt(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tokenId: string,
  ): Promise<void> {
    let sessionId: string | undefined;
    let claimed = false;
    try {
      this.enforceRateLimit(tokenId);
      const body = await readBody(req);
      const parsed = this.validate(body);

      sessionId = parsed.sessionId ?? `sess_${randomId()}`;
      // Claim before any await that could interleave with a second request for
      // the same session.
      if (this.inFlight.has(sessionId)) {
        throw new HttpError(409, `Session ${sessionId} already has a request in flight`);
      }
      this.inFlight.add(sessionId);
      claimed = true;

      const chatId = this.resolveChat(sessionId, parsed);

      if (parsed.stream) {
        await this.runStreaming(res, chatId, sessionId, parsed.prompt);
        return;
      }

      const result = await this.runWithTimeout(chatId, parsed.prompt);

      send(res, 200, {
        sessionId,
        response: result.response,
        tokens: result.tokens,
        durationSec: result.durationSec,
      });
    } catch (err) {
      // Once the NDJSON body has started, the status line is already sent —
      // an error has to arrive as a final event, not as an HTTP code.
      if (res.headersSent) {
        writeEvent(res, { type: 'error', chatId: '', message: (err as Error).message });
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message, ...(sessionId ? { sessionId } : {}) });
        return;
      }
      send(res, 500, {
        error: (err as Error).message ?? 'Internal error',
        ...(sessionId ? { sessionId } : {}),
      });
    } finally {
      if (claimed && sessionId) this.inFlight.delete(sessionId);
    }
  }

  private enforceRateLimit(tokenId: string): void {
    const limit = this.options().rateLimitPerMin;
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (this.recentRequests.get(tokenId) ?? []).filter(t => t > cutoff);
    if (recent.length >= limit) {
      throw new HttpError(429, `Rate limit exceeded (${limit} requests/minute)`);
    }
    recent.push(now);
    this.recentRequests.set(tokenId, recent);
  }

  private validate(body: unknown): PromptRequest {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be a JSON object');
    const b = body as Record<string, unknown>;

    const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
    if (!prompt) throw new HttpError(400, 'prompt is required');

    if (b.stream !== undefined && typeof b.stream !== 'boolean') {
      throw new HttpError(400, 'stream must be a boolean');
    }
    const stream = b.stream === true;

    const workspaces = this.host.getWorkspaceList();
    let workspace: string | undefined;
    if (b.workspace !== undefined) {
      if (typeof b.workspace !== 'string') throw new HttpError(400, 'workspace must be a string');
      if (!workspaces.includes(b.workspace)) {
        throw new HttpError(404, `Unknown workspace: ${b.workspace}. Known: ${workspaces.join(', ') || '(none)'}`);
      }
      workspace = b.workspace;
    } else {
      if (workspaces.length === 0) throw new HttpError(503, 'No workspaces are configured');
      workspace = workspaces[0];
    }

    let team: string | undefined;
    if (b.team !== undefined) {
      if (typeof b.team !== 'string') throw new HttpError(400, 'team must be a string');
      const teams = this.host.getTeamNames();
      if (!teams.includes(b.team)) {
        throw new HttpError(404, `Unknown team: ${b.team}. Known: ${teams.join(', ') || '(none)'}`);
      }
      team = b.team;
    }

    let agent: CodingAgent | undefined;
    if (b.agent !== undefined) {
      if (!AGENTS.includes(b.agent as CodingAgent)) {
        throw new HttpError(400, `Unknown agent: ${String(b.agent)}. Known: ${AGENTS.join(', ')}`);
      }
      agent = b.agent as CodingAgent;
    }

    let model: string | undefined;
    if (b.model !== undefined) {
      if (typeof b.model !== 'string') throw new HttpError(400, 'model must be a string');
      const models = this.host.getModelNames();
      if (!models.includes(b.model)) {
        throw new HttpError(404, `Unknown model: ${b.model}. Known: ${models.join(', ') || '(none)'}`);
      }
      model = b.model;
    }

    let sessionId: string | undefined;
    if (b.sessionId !== undefined) {
      if (typeof b.sessionId !== 'string' || !b.sessionId.trim()) {
        throw new HttpError(400, 'sessionId must be a non-empty string');
      }
      sessionId = b.sessionId.trim();
    }

    return { prompt, stream, workspace, agent, model, team, sessionId };
  }

  /**
   * Map a session to its chat, creating one on first use. A session whose chat
   * has since been deleted gets a fresh chat rather than a 404: the caller's
   * session id stays valid, it just loses the old context.
   */
  private resolveChat(sessionId: string, parsed: PromptRequest): string {
    const existing = this.sessions.get(sessionId);
    if (existing && this.host.hasChat(existing)) return existing;

    const chat = this.host.createApiChat({
      workspaceName: parsed.workspace!,
      title: `API: ${sessionId}`,
      selection: parsed.team ? { type: 'team', name: parsed.team } : { type: 'none' },
      agent: parsed.agent,
      model: parsed.model,
    });
    this.sessions.set(sessionId, chat.id);
    return chat.id;
  }

  /**
   * Stream the turn as NDJSON: one `ChatStreamEvent` per line, exactly the
   * events the Mac app and the channels already consume. Reuses the wire
   * format `/voice/converse` established rather than introducing SSE.
   *
   * The last line is always `done` or `error`, so a client knows the stream
   * ended on purpose rather than because the socket dropped.
   */
  private async runStreaming(
    res: http.ServerResponse,
    chatId: string,
    sessionId: string,
    prompt: string,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      // Without this a reverse proxy may buffer the whole body and defeat the
      // point of streaming.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      // The non-streaming reply carries `sessionId` in its JSON body. A stream
      // has no such envelope, and a caller that omitted `sessionId` would
      // otherwise never learn the one the server generated — leaving it unable
      // to continue the conversation or read the history back.
      'X-Codey-Session-Id': sessionId,
    });

    // A client that hangs up must not keep the process writing into a dead
    // socket; the agent itself is left running, same as the 504 path.
    let aborted = false;
    const onClose = () => { aborted = true; };
    res.on('close', onClose);

    // sendToChat emits its own terminal event. Track it so the guaranteed
    // final line below does not duplicate one the agent already sent.
    let sawTerminal = false;
    const sink: ChatStreamSink = (event) => {
      if (aborted) return;
      if (event.type === 'done' || event.type === 'error') sawTerminal = true;
      writeEvent(res, event);
    };

    const timeoutSec = this.options().timeoutSec;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new HttpError(504, `Agent did not respond within ${timeoutSec}s; the run continues in session context`)),
        timeoutSec * 1000,
      );
    });

    try {
      const result = await Promise.race([this.host.sendToChat(chatId, prompt, sink), timeout]);
      // Only synthesize a terminal event when the run produced none, so the
      // contract "the last line is done or error" holds either way.
      if (!aborted && !sawTerminal) {
        writeEvent(res, {
          type: 'done',
          chatId,
          response: result.response,
          tokens: result.tokens,
          durationSec: result.durationSec,
        });
      }
    } catch (err) {
      // An error always terminates the stream, even if the run already emitted
      // a 'done': the caller must not treat a timed-out turn as complete.
      if (!aborted) {
        writeEvent(res, { type: 'error', chatId, message: (err as Error).message });
      }
    } finally {
      if (timer) clearTimeout(timer);
      res.off('close', onClose);
      if (!aborted) res.end();
    }
  }

  /** Recent history for a session, for a client that dropped mid-stream. */
  private handleGetSession(res: http.ServerResponse, sessionId: string): void {
    const chatId = this.sessions.get(sessionId);
    if (!chatId || !this.host.hasChat(chatId)) {
      send(res, 404, { error: `Unknown session: ${sessionId}` });
      return;
    }
    const messages = this.host.getChatMessages(chatId).slice(-CHAT_CONTEXT_WINDOW);
    send(res, 200, {
      sessionId,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        tokens: m.tokens,
        durationSec: m.durationSec,
      })),
    });
  }

  /** Discard a session and the chat behind it. Idempotent. */
  private handleDeleteSession(res: http.ServerResponse, sessionId: string): void {
    const chatId = this.sessions.get(sessionId);
    if (!chatId) {
      send(res, 404, { error: `Unknown session: ${sessionId}` });
      return;
    }
    if (this.inFlight.has(sessionId)) {
      send(res, 409, { error: `Session ${sessionId} has a request in flight` });
      return;
    }
    this.sessions.delete(sessionId);
    // The chat may already be gone; deleting a session must still succeed.
    if (this.host.hasChat(chatId)) this.host.deleteChat(chatId);
    send(res, 200, { sessionId, deleted: true });
  }

  /**
   * The agent is NOT cancelled on timeout — it keeps running and its answer
   * lands in the session's chat. Only this HTTP response gives up waiting.
   */
  private async runWithTimeout(
    chatId: string,
    prompt: string,
  ): Promise<{ response: string; tokens?: number; durationSec?: number }> {
    const timeoutSec = this.options().timeoutSec;
    const noop: ChatStreamSink = () => { /* non-streaming callers discard events */ };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new HttpError(504, `Agent did not respond within ${timeoutSec}s; the run continues in session context`)),
        timeoutSec * 1000,
      );
    });

    try {
      return await Promise.race([this.host.sendToChat(chatId, prompt, noop), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** One NDJSON line. */
function writeEvent(res: http.ServerResponse, event: ChatStreamEvent): void {
  res.write(JSON.stringify(event) + '\n');
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function randomId(): string {
  // Session ids are handed back to the caller, not used as credentials — the
  // chat behind one is only reachable through an authenticated request.
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Keep draining instead of destroying the socket: tearing it down
        // mid-upload reaches the client as a connection reset, not as the 413
        // that explains what went wrong.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        reject(new HttpError(400, 'Body must be a JSON object'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', err => reject(err));
  });
}
