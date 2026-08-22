import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiServer } from './health';
import { ApiTokenStore } from './api-tokens';
import { RouterApi, RouterApiHost } from './router-api';

describe('Router API /v1', () => {
  let dir: string;
  let store: ApiTokenStore;
  let server: ApiServer;
  let port: number;
  let token: string;
  let opts: { timeoutSec: number; rateLimitPerMin: number };

  /** Records what the host was asked to do so tests can assert on routing. */
  let created: Array<Parameters<RouterApiHost['createApiChat']>[0]>;
  let sent: Array<{ chatId: string; text: string }>;
  let chats: Set<string>;
  let messages: Map<string, any[]>;
  let sweeps: number;
  let respond: (chatId: string, text: string) => Promise<{
    response: string; chatId: string; tokens?: number; durationSec?: number;
  }>;

  const host = (): RouterApiHost => ({
    getWorkspaceList: () => ['alpha', 'beta'],
    getTeamNames: () => ['reviewers'],
    getModelNames: () => ['claude-opus-5', 'gpt-5'],
    getDefaultAgent: () => 'claude-code',
    getDefaultModel: () => 'claude-opus-5',
    createApiChat: (input) => {
      created.push(input);
      const id = `chat-${created.length}`;
      chats.add(id);
      return { id };
    },
    hasChat: (chatId) => chats.has(chatId),
    getChatMessages: (chatId) => messages.get(chatId) ?? [],
    deleteChat: (chatId) => { chats.delete(chatId); messages.delete(chatId); },
    deleteExpiredChats: () => { sweeps++; return 0; },
    sendToChat: async (chatId, text) => {
      sent.push({ chatId, text });
      return respond(chatId, text);
    },
  });

  const fakeStatus = () => ({
    status: 'healthy' as const,
    uptime: 1,
    timestamp: 'now',
    channels: { telegram: false, discord: false, imessage: false },
    stats: { messagesProcessed: 0, activeConversations: 0, errors: 0 },
  });

  const fakeConfigManager = () => ({
    get: () => ({ gateway: { port: 0 } }),
    getApiBindHost: () => '127.0.0.1',
    getApiAllowedOrigins: () => [],
    update: () => { /* no-op */ },
    getResolvedVoiceConfig: () => undefined,
  }) as any;

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const json = async (res: Response): Promise<any> => res.json();

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url('/v1/prompt'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-routerapi-'));
    store = new ApiTokenStore(path.join(dir, 'api-tokens.json'));
    token = store.create('test').token;
    created = [];
    sent = [];
    chats = new Set();
    messages = new Map();
    sweeps = 0;
    opts = { timeoutSec: 5, rateLimitPerMin: 60 };
    respond = async (chatId) => ({ response: 'done', chatId, tokens: 42, durationSec: 1.5 });

    server = new ApiServer(0, fakeStatus, fakeConfigManager(), undefined, undefined, undefined, undefined, store);
    server.setRouterApi(new RouterApi(host(), () => opts));
    await server.start();
    port = (server as any).server.address().port;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // ── capabilities ────────────────────────────────────────────────

  it('reports what a client can ask for', async () => {
    const res = await fetch(url('/v1/capabilities'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.workspaces).toEqual(['alpha', 'beta']);
    expect(body.teams).toEqual(['reviewers']);
    expect(body.agents).toContain('claude-code');
    expect(body.defaults).toEqual({ agent: 'claude-code', model: 'claude-opus-5' });
  });

  it('still requires a token for capabilities', async () => {
    expect((await fetch(url('/v1/capabilities'))).status).toBe(401);
  });

  // ── happy path ──────────────────────────────────────────────────

  it('runs a prompt and returns the agent response', async () => {
    const res = await post({ prompt: 'hello' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.response).toBe('done');
    expect(body.tokens).toBe(42);
    expect(body.durationSec).toBe(1.5);
    expect(body.sessionId).toMatch(/^sess_/);
    expect(sent).toEqual([{ chatId: 'chat-1', text: 'hello' }]);
  });

  it('defaults to the first workspace and creates a hidden api chat', async () => {
    await post({ prompt: 'hi' });
    expect(created[0].workspaceName).toBe('alpha');
    expect(created[0].selection).toEqual({ type: 'none' });
  });

  it('honours workspace, team, agent and model', async () => {
    await post({ prompt: 'hi', workspace: 'beta', team: 'reviewers', agent: 'codex', model: 'gpt-5' });
    expect(created[0]).toMatchObject({
      workspaceName: 'beta',
      selection: { type: 'team', name: 'reviewers' },
      agent: 'codex',
      model: 'gpt-5',
    });
  });

  // ── sessions ────────────────────────────────────────────────────

  it('reuses one chat across calls with the same sessionId', async () => {
    await post({ prompt: 'first', sessionId: 's1' });
    await post({ prompt: 'second', sessionId: 's1' });
    expect(created).toHaveLength(1);
    expect(sent.map(s => s.chatId)).toEqual(['chat-1', 'chat-1']);
  });

  it('gives each anonymous call its own chat', async () => {
    await post({ prompt: 'a' });
    await post({ prompt: 'b' });
    expect(created).toHaveLength(2);
  });

  it('re-creates a chat that was deleted behind the session', async () => {
    const first = await json(await post({ prompt: 'a', sessionId: 's1' }));
    chats.clear();
    const second = await json(await post({ prompt: 'b', sessionId: 's1' }));
    expect(created).toHaveLength(2);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('rejects a concurrent request on the same session with 409', async () => {
    let release!: () => void;
    respond = (chatId) => new Promise(resolve => {
      release = () => resolve({ response: 'done', chatId });
    });

    const first = post({ prompt: 'a', sessionId: 's1' });
    // Let the first request reach sendToChat before the second arrives.
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const second = await post({ prompt: 'b', sessionId: 's1' });
    expect(second.status).toBe(409);

    release();
    expect((await first).status).toBe(200);
  });

  it('frees the session again after the request finishes', async () => {
    await post({ prompt: 'a', sessionId: 's1' });
    expect((await post({ prompt: 'b', sessionId: 's1' })).status).toBe(200);
  });

  it('frees the session even when the agent throws', async () => {
    respond = async () => { throw new Error('agent exploded'); };
    expect((await post({ prompt: 'a', sessionId: 's1' })).status).toBe(500);

    respond = async (chatId) => ({ response: 'ok', chatId });
    expect((await post({ prompt: 'b', sessionId: 's1' })).status).toBe(200);
  });

  // ── validation ──────────────────────────────────────────────────

  it('rejects a missing prompt', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ prompt: '   ' })).status).toBe(400);
  });

  it('rejects invalid JSON and an empty body', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post('')).status).toBe(400);
  });

  it('404s an unknown workspace, team or model', async () => {
    expect((await post({ prompt: 'x', workspace: 'nope' })).status).toBe(404);
    expect((await post({ prompt: 'x', team: 'nope' })).status).toBe(404);
    expect((await post({ prompt: 'x', model: 'nope' })).status).toBe(404);
  });

  it('400s an unknown agent', async () => {
    expect((await post({ prompt: 'x', agent: 'nope' })).status).toBe(400);
  });

  it('rejects a non-boolean stream flag', async () => {
    expect((await post({ prompt: 'x', stream: 'yes' })).status).toBe(400);
  });

  it('never reaches the agent when validation fails', async () => {
    await post({ prompt: 'x', workspace: 'nope' });
    expect(sent).toHaveLength(0);
  });

  it('404s an unknown /v1 route', async () => {
    const res = await fetch(url('/v1/nonsense'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });

  it('404s /v1/prompt on the wrong method', async () => {
    const res = await fetch(url('/v1/prompt'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });

  // ── limits ──────────────────────────────────────────────────────

  it('504s when the agent outruns the timeout', async () => {
    opts = { timeoutSec: 0.05, rateLimitPerMin: 60 };
    respond = () => new Promise(resolve => setTimeout(() => resolve({ response: 'late', chatId: 'chat-1' }), 500));

    const res = await post({ prompt: 'slow' });
    expect(res.status).toBe(504);
    expect((await json(res)).error).toMatch(/did not respond/);
  });

  it('429s past the per-minute rate limit', async () => {
    opts = { timeoutSec: 5, rateLimitPerMin: 2 };
    expect((await post({ prompt: 'a' })).status).toBe(200);
    expect((await post({ prompt: 'b' })).status).toBe(200);

    const third = await post({ prompt: 'c' });
    expect(third.status).toBe(429);
    expect((await json(third)).error).toMatch(/[Rr]ate limit/);
  });

  it('rejects an oversized body', async () => {
    const res = await post({ prompt: 'x'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  // ── streaming ───────────────────────────────────────────────────

  /** Collect an NDJSON body into parsed events. */
  const readNdjson = async (res: Response): Promise<any[]> =>
    (await res.text()).split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

  it('streams events as NDJSON and ends with done', async () => {
    respond = async (chatId) => ({ response: 'final', chatId, tokens: 7, durationSec: 2 });
    const res = await post({ prompt: 'go', stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');

    const events = await readNdjson(res);
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    expect(last.response).toBe('final');
    expect(last.tokens).toBe(7);
  });

  it('reports the generated sessionId in a header', async () => {
    const res = await post({ prompt: 'go', stream: true });
    const sessionId = res.headers.get('x-codey-session-id');
    expect(sessionId).toMatch(/^sess_/);
    await readNdjson(res);

    // The header is enough to keep talking to the same session.
    const body = await json(await post({ prompt: 'again', sessionId }));
    expect(body.sessionId).toBe(sessionId);
    expect(created).toHaveLength(1);
  });

  it('does not duplicate a terminal event the run already emitted', async () => {
    const base = host();
    const emitsDone: RouterApiHost = {
      ...base,
      sendToChat: async (chatId, text, sink) => {
        sink({ type: 'done', chatId, response: 'from the agent', tokens: 3 });
        return base.sendToChat(chatId, text, sink);
      },
    };
    await server.stop();
    server = new ApiServer(0, fakeStatus, fakeConfigManager(), undefined, undefined, undefined, undefined, store);
    server.setRouterApi(new RouterApi(emitsDone, () => opts));
    await server.start();
    port = (server as any).server.address().port;

    const events = await readNdjson(await post({ prompt: 'go', stream: true }));
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(events[events.length - 1].response).toBe('from the agent');
  });

  it('forwards the agent\'s own events, in order, before done', async () => {
    respond = async (chatId) => ({ response: 'final', chatId });
    // The sink is the third argument; drive it from the fake host.
    const streamingHost = host();
    const withEvents: RouterApiHost = {
      ...streamingHost,
      sendToChat: async (chatId, text, sink) => {
        sink({ type: 'tool_start', chatId, message: 'reading a file' });
        sink({ type: 'stream', chatId, token: 'par' });
        sink({ type: 'stream', chatId, token: 'tial' });
        return streamingHost.sendToChat(chatId, text, sink);
      },
    };
    await server.stop();
    server = new ApiServer(0, fakeStatus, fakeConfigManager(), undefined, undefined, undefined, undefined, store);
    server.setRouterApi(new RouterApi(withEvents, () => opts));
    await server.start();
    port = (server as any).server.address().port;

    const events = await readNdjson(await post({ prompt: 'go', stream: true }));
    expect(events.map(e => e.type)).toEqual(['tool_start', 'stream', 'stream', 'done']);
    expect(events[1].token + events[2].token).toBe('partial');
  });

  it('ends the stream with an error event, not a 500, when the agent throws', async () => {
    respond = async () => { throw new Error('agent exploded'); };
    const res = await post({ prompt: 'go', stream: true });

    // The status line was already sent, so the failure has to be an event.
    expect(res.status).toBe(200);
    const events = await readNdjson(res);
    expect(events[events.length - 1]).toMatchObject({ type: 'error', message: 'agent exploded' });
  });

  it('ends the stream with an error event on timeout', async () => {
    opts = { timeoutSec: 0.05, rateLimitPerMin: 60 };
    respond = () => new Promise(resolve => setTimeout(() => resolve({ response: 'late', chatId: 'chat-1' }), 500));

    const events = await readNdjson(await post({ prompt: 'slow', stream: true }));
    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect(last.message).toMatch(/did not respond/);
  });

  it('still enforces validation before opening a stream', async () => {
    const res = await post({ prompt: 'x', workspace: 'nope', stream: true });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('frees the session after a stream completes', async () => {
    await post({ prompt: 'a', sessionId: 's1', stream: true }).then(readNdjson);
    expect((await post({ prompt: 'b', sessionId: 's1' })).status).toBe(200);
  });

  // ── session endpoints ───────────────────────────────────────────

  const sessionUrl = (id: string) => url(`/v1/sessions/${encodeURIComponent(id)}`);
  const authed = () => ({ Authorization: `Bearer ${token}` });

  it('returns a session\'s recent messages', async () => {
    await post({ prompt: 'hi', sessionId: 's1' });
    messages.set('chat-1', [
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'hello', timestamp: 2, tokens: 5 },
    ]);

    const body = await json(await fetch(sessionUrl('s1'), { headers: authed() }));
    expect(body.sessionId).toBe('s1');
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi', timestamp: 1, tokens: undefined, durationSec: undefined },
      { role: 'assistant', content: 'hello', timestamp: 2, tokens: 5, durationSec: undefined },
    ]);
  });

  it('caps the returned history to the context window', async () => {
    await post({ prompt: 'hi', sessionId: 's1' });
    messages.set('chat-1', Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, role: 'user', content: `${i}`, timestamp: i,
    })));

    const body = await json(await fetch(sessionUrl('s1'), { headers: authed() }));
    expect(body.messages).toHaveLength(40);
    // The tail, not the head — a reconnecting client wants the latest.
    expect(body.messages[39].content).toBe('99');
  });

  it('404s an unknown session', async () => {
    expect((await fetch(sessionUrl('nope'), { headers: authed() })).status).toBe(404);
  });

  it('requires a token on the session endpoints', async () => {
    expect((await fetch(sessionUrl('s1'))).status).toBe(401);
    expect((await fetch(sessionUrl('s1'), { method: 'DELETE' })).status).toBe(401);
  });

  it('deletes a session and its chat', async () => {
    await post({ prompt: 'hi', sessionId: 's1' });
    expect(chats.has('chat-1')).toBe(true);

    const res = await fetch(sessionUrl('s1'), { method: 'DELETE', headers: authed() });
    expect(res.status).toBe(200);
    expect(chats.has('chat-1')).toBe(false);
    expect((await fetch(sessionUrl('s1'), { headers: authed() })).status).toBe(404);
  });

  it('deletes cleanly when the chat is already gone', async () => {
    await post({ prompt: 'hi', sessionId: 's1' });
    chats.clear();
    expect((await fetch(sessionUrl('s1'), { method: 'DELETE', headers: authed() })).status).toBe(200);
  });

  it('refuses to delete a session with a request in flight', async () => {
    let release!: () => void;
    respond = (chatId) => new Promise(resolve => { release = () => resolve({ response: 'd', chatId }); });

    const running = post({ prompt: 'a', sessionId: 's1' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const res = await fetch(sessionUrl('s1'), { method: 'DELETE', headers: authed() });
    expect(res.status).toBe(409);

    release();
    await running;
  });

  it('404s an unknown method on the session route', async () => {
    await post({ prompt: 'hi', sessionId: 's1' });
    const res = await fetch(sessionUrl('s1'), { method: 'PUT', headers: authed() });
    expect(res.status).toBe(404);
  });

  // ── retention ───────────────────────────────────────────────────

  it("stamps the chat with the token's retention", async () => {
    // A fresh server whose token carries a retention choice.
    await server.stop();
    store = new ApiTokenStore(path.join(dir, 'api-tokens.json'));
    token = store.create('retained', 30).token;
    server = new ApiServer(0, fakeStatus, fakeConfigManager(), undefined, undefined, undefined, undefined, store);
    server.setRouterApi(new RouterApi(host(), () => opts));
    await server.start();
    port = (server as any).server.address().port;

    await post({ prompt: 'hi' });
    expect(created[0].retentionDays).toBe(30);
  });

  it('leaves the chat unstamped for an unlimited token', async () => {
    await post({ prompt: 'hi' });
    expect(created[0].retentionDays).toBeUndefined();
  });

  it('sweeps expired chats when a request comes in, at most once an hour', async () => {
    await post({ prompt: 'a' });
    expect(sweeps).toBe(1);

    // Throttled: a burst of traffic must not rescan every chat each time.
    await post({ prompt: 'b' });
    await post({ prompt: 'c' });
    expect(sweeps).toBe(1);
  });

  it('still answers the request when the sweep throws', async () => {
    const failing: RouterApiHost = {
      ...host(),
      deleteExpiredChats: () => { throw new Error('disk on fire'); },
    };
    await server.stop();
    server = new ApiServer(0, fakeStatus, fakeConfigManager(), undefined, undefined, undefined, undefined, store);
    server.setRouterApi(new RouterApi(failing, () => opts));
    await server.start();
    port = (server as any).server.address().port;

    // Housekeeping is not the caller's problem.
    expect((await post({ prompt: 'hi' })).status).toBe(200);
  });
});
