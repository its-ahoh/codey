import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Plain function stub rather than `vi.fn()`: vitest's spy result-tracking
 * reports an error thrown by a mock implementation as an unhandled test
 * error even when the code under test catches it, which makes the
 * degrade-to-null cases unassertable. Calls are recorded by hand instead.
 */
const calls: any[][] = [];
const state: { impl: (...args: any[]) => any } = {
  impl: () => { throw new Error('no impl set'); },
};
vi.mock('undici', () => ({
  request: (...args: any[]) => { calls.push(args); return state.impl(...args); },
}));

import { runTextCompletion, streamTextCompletion, canRunDirectly } from './text-completion';

/** Builds a streaming response whose body yields `chunks` as Buffers. */
const streamRespond = (statusCode: number, chunks: string[]) => () => ({
  statusCode,
  body: (async function* () {
    for (const c of chunks) yield Buffer.from(c);
  })(),
});
const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n`;
const anthropicDelta = (text: string) => sse({ type: 'content_block_delta', delta: { text } });
const openAiDelta = (text: string) => sse({ choices: [{ delta: { content: text } }] });

const respond = (statusCode: number, json: any) => () => ({ statusCode, body: { json: async () => json } });
const anthropicOk = (text: string) => respond(200, { content: [{ type: 'text', text }] });
const openAiOk = (text: string) => respond(200, { choices: [{ message: { content: text } }] });

const ANTHROPIC_MODEL = { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-a', apiType: 'anthropic' as const };
const OPENAI_MODEL = { provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk-o', apiType: 'openai' as const };

beforeEach(() => {
  calls.length = 0;
  state.impl = () => { throw new Error('no impl set'); };
});

describe('canRunDirectly', () => {
  it('requires both an api key and a model id', () => {
    expect(canRunDirectly(ANTHROPIC_MODEL)).toBe(true);
    expect(canRunDirectly(undefined)).toBe(false);
    expect(canRunDirectly({ provider: 'anthropic', model: 'x' })).toBe(false);
    expect(canRunDirectly({ provider: 'anthropic', model: '', apiKey: 'sk' })).toBe(false);
  });
});

describe('runTextCompletion — anthropic', () => {
  it('posts to /messages with the anthropic auth headers and returns the text', async () => {
    state.impl = anthropicOk('改完了，三个文件。'); // lint-allow-non-english
    const out = await runTextCompletion('hi', ANTHROPIC_MODEL);

    expect(out).toBe('改完了，三个文件。'); // lint-allow-non-english
    const [url, opts] = calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('sk-a');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(opts.body).model).toBe('claude-haiku-4-5');
  });

  it('concatenates multiple text blocks and trims', async () => {
    state.impl = respond(200, { content: [{ type: 'thinking' }, { type: 'text', text: ' a' }, { type: 'text', text: 'b ' }] });
    expect(await runTextCompletion('hi', ANTHROPIC_MODEL)).toBe('ab');
  });

  it('honours a custom baseUrl and strips a trailing slash', async () => {
    state.impl = anthropicOk('ok');
    await runTextCompletion('hi', { ...ANTHROPIC_MODEL, baseUrl: 'https://proxy.test/v1/' });
    expect(calls[0][0]).toBe('https://proxy.test/v1/messages');
  });
});

describe('runTextCompletion — openai', () => {
  it('posts to /chat/completions with bearer auth', async () => {
    state.impl = openAiOk('done');
    const out = await runTextCompletion('hi', OPENAI_MODEL);

    expect(out).toBe('done');
    const [url, opts] = calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer sk-o');
  });
});

describe('streamTextCompletion', () => {
  it('reports anthropic deltas as they arrive and returns the full text', async () => {
    state.impl = streamRespond(200, [anthropicDelta('改完了。'), anthropicDelta('细节在屏幕上。')]); // lint-allow-non-english
    const deltas: string[] = [];
    const out = await streamTextCompletion('hi', ANTHROPIC_MODEL, (d) => deltas.push(d));

    expect(deltas).toEqual(['改完了。', '细节在屏幕上。']); // lint-allow-non-english
    expect(out).toBe('改完了。细节在屏幕上。'); // lint-allow-non-english
    expect(JSON.parse(calls[0][1].body).stream).toBe(true);
  });

  it('reassembles SSE lines split across chunk boundaries', async () => {
    const line = anthropicDelta('hello');
    state.impl = streamRespond(200, [line.slice(0, 10), line.slice(10), anthropicDelta(' world')]);
    const deltas: string[] = [];
    expect(await streamTextCompletion('hi', ANTHROPIC_MODEL, (d) => deltas.push(d))).toBe('hello world');
    expect(deltas).toEqual(['hello', ' world']);
  });

  it('reads openai-style deltas and ignores the [DONE] sentinel', async () => {
    state.impl = streamRespond(200, [openAiDelta('a'), openAiDelta('b'), 'data: [DONE]\n']);
    expect(await streamTextCompletion('hi', OPENAI_MODEL, () => {})).toBe('ab');
  });

  it('skips keepalives, blank lines and unparseable payloads', async () => {
    state.impl = streamRespond(200, ['\n', ': ping\n', 'data: not-json\n', anthropicDelta('ok')]);
    expect(await streamTextCompletion('hi', ANTHROPIC_MODEL, () => {})).toBe('ok');
  });

  it('returns the partial text when the stream dies mid-flight', async () => {
    state.impl = () => ({
      statusCode: 200,
      body: (async function* () {
        yield Buffer.from(anthropicDelta('partial'));
        throw new Error('connection reset');
      })(),
    });
    expect(await streamTextCompletion('hi', ANTHROPIC_MODEL, () => {})).toBe('partial');
  });

  it('returns null on a non-2xx response or an empty stream', async () => {
    state.impl = streamRespond(500, []);
    expect(await streamTextCompletion('hi', ANTHROPIC_MODEL, () => {})).toBeNull();
    state.impl = streamRespond(200, ['data: [DONE]\n']);
    expect(await streamTextCompletion('hi', ANTHROPIC_MODEL, () => {})).toBeNull();
  });
});

describe('runTextCompletion — failure modes degrade to null', () => {
  it('returns null on a non-2xx response', async () => {
    state.impl = respond(429, {});
    expect(await runTextCompletion('hi', ANTHROPIC_MODEL)).toBeNull();
  });

  it('returns null when the request throws (network error / abort)', async () => {
    state.impl = () => { throw new Error('aborted'); };
    expect(await runTextCompletion('hi', ANTHROPIC_MODEL)).toBeNull();
  });

  it('returns null on an empty or whitespace-only completion', async () => {
    state.impl = anthropicOk('   ');
    expect(await runTextCompletion('hi', ANTHROPIC_MODEL)).toBeNull();
  });

  it('returns null on an unparseable body shape', async () => {
    state.impl = respond(200, { unexpected: true });
    expect(await runTextCompletion('hi', ANTHROPIC_MODEL)).toBeNull();
  });
});
