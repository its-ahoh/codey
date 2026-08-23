import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiServer } from './health';
import { ApiTokenStore } from './api-tokens';
import { CompatApi } from './compat-api';
import { RouterApi, RouterApiHost } from './router-api';

/**
 * The whole point of these endpoints is that a client library recognises the
 * bytes, so the assertions are about exact wire shape, not just "it worked".
 */
describe('Compat API', () => {
  let dir: string;
  let store: ApiTokenStore;
  let server: ApiServer;
  let port: number;
  let token: string;
  let timeoutSec: number;

  let created: Array<Parameters<RouterApiHost['createApiChat']>[0]>;
  let sent: Array<{ chatId: string; text: string }>;
  let chats: Set<string>;
  let respond: (chatId: string, sink: any) => Promise<{
    response: string; chatId: string; tokens?: number; durationSec?: number;
  }>;

  const host = (): RouterApiHost => ({
    getWorkspaceList: () => ['alpha', 'beta'],
    getTeamNames: () => [],
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
    getChatMessages: () => [],
    deleteChat: (chatId) => { chats.delete(chatId); },
    sendToChat: async (chatId, text, sink) => {
      sent.push({ chatId, text });
      return respond(chatId, sink);
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

  /** OpenAI clients authenticate with a bearer token. */
  const openai = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url('/v1/chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  /** Anthropic clients authenticate with x-api-key and send no Authorization. */
  const anthropic = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url('/v1/messages'), {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  /** Parse an SSE body into [eventName | null, payload] pairs. */
  const readSse = async (res: Response): Promise<Array<[string | null, any]>> => {
    const text = await res.text();
    return text
      .split('\n\n')
      .filter(f => f.trim())
      .map(frame => {
        const lines = frame.split('\n');
        const eventLine = lines.find(l => l.startsWith('event: '));
        const dataLine = lines.find(l => l.startsWith('data: '))!;
        const raw = dataLine.slice('data: '.length);
        return [
          eventLine ? eventLine.slice('event: '.length) : null,
          raw === '[DONE]' ? '[DONE]' : JSON.parse(raw),
        ] as [string | null, any];
      });
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-compat-'));
    store = new ApiTokenStore(path.join(dir, 'api-tokens.json'));
    token = store.create('test').token;
    created = [];
    sent = [];
    chats = new Set();
    timeoutSec = 5;
    respond = async (chatId) => ({ response: 'the answer', chatId, tokens: 12 });

    server = new ApiServer(0, fakeStatus, fakeConfigManager(), undefined, undefined, undefined, undefined, store);
    server.setRouterApi(new RouterApi(host(), () => ({ timeoutSec: 5, rateLimitPerMin: 1000 })));
    server.setCompatApi(new CompatApi(host(), () => ({ timeoutSec })));
    await server.start();
    port = (server as any).server.address().port;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── auth ────────────────────────────────────────────────────────

  it('accepts a token via x-api-key, the way Anthropic clients send it', async () => {
    const res = await anthropic({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
  });

  it('rejects both endpoints without a token', async () => {
    expect((await fetch(url('/v1/models'))).status).toBe(401);
    expect((await fetch(url('/v1/chat/completions'), { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(url('/v1/messages'), { method: 'POST', body: '{}' })).status).toBe(401);
  });

  // ── models ──────────────────────────────────────────────────────

  it('lists models in OpenAI shape', async () => {
    const body = await json(await fetch(url('/v1/models'), { headers: { Authorization: `Bearer ${token}` } }));
    expect(body.object).toBe('list');
    expect(body.data.map((m: any) => m.id)).toEqual(['claude-opus-5', 'gpt-5']);
    expect(body.data[0]).toMatchObject({ object: 'model', owned_by: 'codey' });
  });

  // ── OpenAI non-streaming ────────────────────────────────────────

  it('answers a chat completion in OpenAI shape', async () => {
    const res = await openai({ model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.model).toBe('gpt-5');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]).toMatchObject({
      index: 0,
      message: { role: 'assistant', content: 'the answer' },
      finish_reason: 'stop',
    });
    expect(body.usage.total_tokens).toBe(12);
    // A single question goes through as itself, with no role scaffolding.
    expect(sent[0].text).toBe('hello');
  });

  it('flattens a multi-turn history with role labels', async () => {
    await openai({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    });
    // Without labels a flattened history reads as one run-on message.
    expect(sent[0].text).toBe('Be terse.\n\nUser: first\n\nAssistant: reply\n\nUser: second');
  });

  it('reads OpenAI content blocks as well as plain strings', async () => {
    await openai({
      model: 'gpt-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'from a block' }] }],
    });
    expect(sent[0].text).toBe('from a block');
  });

  it('routes the agent when the model carries a prefix', async () => {
    await openai({ model: 'codex/gpt-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(created[0]).toMatchObject({ agent: 'codex', model: 'gpt-5' });
  });

  // ── Anthropic non-streaming ─────────────────────────────────────

  it('answers a message in Anthropic shape', async () => {
    const res = await anthropic({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.type).toBe('message');
    expect(body.id).toMatch(/^msg_/);
    expect(body.role).toBe('assistant');
    expect(body.content).toEqual([{ type: 'text', text: 'the answer' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage.output_tokens).toBe(12);
  });

  it("honours Anthropic's top-level system field", async () => {
    await anthropic({
      model: 'claude-opus-5',
      max_tokens: 100,
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(sent[0].text).toBe('You are terse.\n\nhi');
  });

  // ── streaming ───────────────────────────────────────────────────

  it('streams OpenAI chunks and terminates with [DONE]', async () => {
    respond = async (chatId, sink) => {
      sink({ type: 'stream', chatId, token: 'par' });
      sink({ type: 'stream', chatId, token: 'tial' });
      return { response: 'partial', chatId, tokens: 3 };
    };

    const res = await openai({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'go' }] });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readSse(res);
    expect(frames[frames.length - 1][1]).toBe('[DONE]');

    const chunks = frames.slice(0, -1).map(f => f[1]);
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks.map(c => c.choices[0].delta.content ?? '').join('')).toBe('partial');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
    expect(chunks.every(c => c.object === 'chat.completion.chunk')).toBe(true);
  });

  it('streams the Anthropic event sequence in order', async () => {
    respond = async (chatId, sink) => {
      sink({ type: 'stream', chatId, token: 'hel' });
      sink({ type: 'stream', chatId, token: 'lo' });
      return { response: 'hello', chatId, tokens: 2 };
    };

    const frames = await readSse(await anthropic({
      model: 'claude-opus-5', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'go' }],
    }));

    expect(frames.map(f => f[0])).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const deltas = frames.filter(f => f[0] === 'content_block_delta');
    expect(deltas.map(d => d[1].delta.text).join('')).toBe('hello');
    expect(deltas[0][1].delta.type).toBe('text_delta');
    expect(frames.find(f => f[0] === 'message_delta')![1].delta.stop_reason).toBe('end_turn');
  });

  it('still delivers the answer when the agent streams no tokens', async () => {
    // Not every adapter emits token deltas; a streaming client must not be
    // left with an empty message just because this one stayed silent.
    respond = async (chatId) => ({ response: 'all at once', chatId });

    const frames = await readSse(await openai({
      model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'go' }],
    }));
    const text = frames.slice(0, -1).map(f => f[1].choices[0].delta.content ?? '').join('');
    expect(text).toBe('all at once');
  });

  it('reports a mid-stream failure as an event, not a status code', async () => {
    respond = async () => { throw new Error('agent exploded'); };

    const res = await openai({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'go' }] });
    expect(res.status).toBe(200);

    const frames = await readSse(res);
    const errorFrame = frames.find(f => f[1] !== '[DONE]' && f[1].type === 'error');
    expect(errorFrame![1].error.message).toBe('agent exploded');
  });

  // ── errors ──────────────────────────────────────────────────────

  it('reports errors in the OpenAI envelope', async () => {
    const res = await openai({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(404);

    const body = await json(res);
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toContain('claude-opus-5');
  });

  it('reports errors in the Anthropic envelope', async () => {
    const res = await anthropic({ model: 'nope', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(404);

    const body = await json(res);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
  });

  it('rejects a missing model or empty messages', async () => {
    expect((await openai({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(400);
    expect((await openai({ model: 'gpt-5', messages: [] })).status).toBe(400);
    expect((await openai({ model: 'gpt-5' })).status).toBe(400);
  });

  it('never reaches the agent when validation fails', async () => {
    await openai({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] });
    expect(sent).toHaveLength(0);
  });

  it('504s when the agent outruns the timeout', async () => {
    timeoutSec = 0.05;
    respond = () => new Promise(resolve => setTimeout(() => resolve({ response: 'late', chatId: 'chat-1' }), 500));
    expect((await openai({ model: 'gpt-5', messages: [{ role: 'user', content: 'slow' }] })).status).toBe(504);
  });

  // ── sessions and workspaces ─────────────────────────────────────

  it('is stateless by default: a chat per request', async () => {
    await openai({ model: 'gpt-5', messages: [{ role: 'user', content: 'a' }] });
    await openai({ model: 'gpt-5', messages: [{ role: 'user', content: 'b' }] });
    expect(created).toHaveLength(2);
  });

  it('reuses a chat and sends only the new message when a session is given', async () => {
    const headers = { 'X-Codey-Session-Id': 's1' };
    await openai({ model: 'gpt-5', messages: [{ role: 'user', content: 'first' }] }, headers);
    await openai({
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    }, headers);

    expect(created).toHaveLength(1);
    // Replaying the array into a chat that already holds the history would
    // duplicate every earlier turn.
    expect(sent.map(s => s.text)).toEqual(['first', 'second']);
  });

  it('honours the workspace header and rejects an unknown one', async () => {
    await openai({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }, { 'X-Codey-Workspace': 'beta' });
    expect(created[0].workspaceName).toBe('beta');

    const res = await openai({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }, { 'X-Codey-Workspace': 'nope' });
    expect(res.status).toBe(404);
  });

  // ── coexistence with the native API ─────────────────────────────

  it('leaves Codey\'s own /v1 routes working', async () => {
    const res = await fetch(url('/v1/prompt'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'native' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).response).toBe('the answer');
  });

  it('404s an unknown /v1 path', async () => {
    const res = await fetch(url('/v1/nonsense'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });
});
