import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationDigestCache, VoiceConverseEvent } from '@codey/core';

/**
 * Control-flow tests for Gateway.runVoiceConverse — the branchiest part of
 * the voice pipeline (command short-circuit, ack ordering, seq alignment and
 * the four-level digest/TTS degradation chain). Degradation paths in
 * particular never run in the happy case, so without these they would only
 * be exercised the first time an API key expires mid-walk.
 */

const ttsCalls: string[] = [];
const ttsState: { impl: (text: string) => Promise<Buffer> } = {
  impl: async (t) => Buffer.from(`audio:${t}`),
};
vi.mock('./voice-tts', () => ({
  synthesizeSpeech: (text: string) => {
    ttsCalls.push(text);
    return ttsState.impl(text);
  },
}));

import { Codey } from './gateway';

interface Harness {
  gateway: any;
  events: VoiceConverseEvent[];
  agentCalls: string[];
  /** Records the event count at the moment the agent was invoked. */
  eventsBeforeAgent: number;
}

/** Long enough that 'auto' verbosity routes it through the digest. */
const LONG_REPLY = 'A detailed reply. '.repeat(30);

const TTS_CONFIG = {
  enabled: true,
  provider: 'api' as const,
  apiUrl: 'https://api.test/v1',
  apiKey: 'sk-t',
  apiModel: 'tts-1',
  voiceId: 'alloy',
  verbosity: 'auto' as const,
};

function makeHarness(opts: {
  reply?: string;
  tts?: any;
  workspaces?: string[];
  switchOk?: boolean;
  notifications?: string;
  /** Sentences the streaming digest hands back, or null to make it unavailable. */
  digestSentences?: string[] | null;
  oneShotDigest?: string | null;
} = {}): Harness {
  const events: VoiceConverseEvent[] = [];
  const agentCalls: string[] = [];
  const harness: Harness = { gateway: null, events, agentCalls, eventsBeforeAgent: -1 };

  // Built off the prototype rather than the constructor: the real one loads
  // context from disk and writes pairings.json, none of which this method
  // touches.
  const gateway: any = Object.create(Codey.prototype);
  gateway.logger = { error: () => {}, warn: () => {}, info: () => {} };
  gateway.voiceDigestCache = new ConversationDigestCache();
  gateway.configManager = {
    get: () => ({ voice: { tts: opts.tts === undefined ? TTS_CONFIG : opts.tts } }),
  };
  gateway.getVoiceHandler = () => ({
    runMessage: async (m: any) => {
      harness.eventsBeforeAgent = events.length;
      agentCalls.push(m.text);
      return opts.reply ?? LONG_REPLY;
    },
  });
  gateway.switchWorkspaceByName = async () => opts.switchOk ?? true;
  gateway.getWorkspaceList = () => opts.workspaces ?? ['codey', 'notes'];
  gateway.describeUnseenNotifications = () => opts.notifications ?? '有两条未读通知。';
  gateway.streamVoiceDigest = async (_full: string, onSentence: (s: string) => void) => {
    if (opts.digestSentences === null || opts.digestSentences === undefined) return false;
    opts.digestSentences.forEach(onSentence);
    return true;
  };
  gateway.runVoiceDigestPrompt = async () => opts.oneShotDigest ?? null;

  harness.gateway = gateway;
  return harness;
}

const run = async (h: Harness, transcript: string, convId?: string) => {
  await h.gateway.runVoiceConverse(transcript, convId, (e: VoiceConverseEvent) => h.events.push(e));
  return h.events;
};

const typesOf = (events: VoiceConverseEvent[]) => events.map((e) => e.type);
const textsOf = (events: VoiceConverseEvent[]) =>
  events.filter((e): e is Extract<VoiceConverseEvent, { type: 'text' }> => e.type === 'text');
const audiosOf = (events: VoiceConverseEvent[]) =>
  events.filter((e): e is Extract<VoiceConverseEvent, { type: 'audio' }> => e.type === 'audio');

beforeEach(() => {
  ttsCalls.length = 0;
  ttsState.impl = async (t) => Buffer.from(`audio:${t}`);
});

describe('runVoiceConverse — command short-circuit', () => {
  it('switches workspace without ever running the agent', async () => {
    const h = makeHarness();
    const events = await run(h, '切换到 codey 工作区');

    expect(typesOf(events)).toEqual(['start', 'command', 'done']);
    expect(events[1]).toMatchObject({ action: 'switch-workspace', result: '已切换到 codey' });
    expect(h.agentCalls).toEqual([]);
  });

  it('reports a workspace that does not exist rather than failing silently', async () => {
    const h = makeHarness({ switchOk: false });
    const events = await run(h, '切换到 nope 工作区');
    expect(events[1]).toMatchObject({ result: '没有找到工作区 nope' });
  });

  it('lists workspaces and notifications', async () => {
    const listed = await run(makeHarness(), 'list workspaces');
    expect(listed[1]).toMatchObject({ action: 'list-workspaces', result: '工作区有：codey、notes' });

    const notified = await run(makeHarness(), '有什么通知');
    expect(notified[1]).toMatchObject({ action: 'list-notifications', result: '有两条未读通知。' });
  });

  it('says so when there are no workspaces configured', async () => {
    const events = await run(makeHarness({ workspaces: [] }), 'list workspaces');
    expect(events[1]).toMatchObject({ result: '没有配置任何工作区。' });
  });
});

describe('runVoiceConverse — more detail', () => {
  it('replays the cached full reply as text/audio without re-running the agent', async () => {
    const h = makeHarness({ reply: 'Line one. Line two. Line three.', digestSentences: ['Short gist.'] });
    await run(h, 'hello', 'conv-1');
    h.events.length = 0;
    ttsCalls.length = 0;

    const events = await run(h, '说详细点', 'conv-1');

    expect(textsOf(events).map((e) => e.text)).toEqual(['Line one.', 'Line two.', 'Line three.']);
    expect(h.agentCalls).toHaveLength(1); // only the first turn
    expect(typesOf(events)).not.toContain('ack');
  });

  it('reports having nothing to expand, in the language of the request', async () => {
    const zh = await run(makeHarness(), '说详细点', 'conv-empty');
    expect(zh[1]).toMatchObject({ action: 'more-detail', result: '没有可以展开的内容。' });

    const en = await run(makeHarness(), 'more detail', 'conv-empty');
    expect(en[1]).toMatchObject({ result: 'There is nothing to expand on yet.' });
  });

  it('has nothing cached when no conversationId is supplied', async () => {
    const h = makeHarness({ reply: 'Detailed reply.' });
    await run(h, 'hello');
    h.events.length = 0;
    const events = await run(h, '说详细点');
    expect(events[1]).toMatchObject({ action: 'more-detail' });
  });
});

describe('runVoiceConverse — conversation path', () => {
  it('emits ack before the agent starts, not after', async () => {
    const h = makeHarness({ digestSentences: ['Done.'] });
    const events = await run(h, 'what changed');

    expect(typesOf(events).slice(0, 2)).toEqual(['start', 'ack']);
    // The whole point of ack is filling the silence *while* the agent runs.
    expect(h.eventsBeforeAgent).toBe(2);
  });

  it('acknowledges in the language of the transcript', async () => {
    const zh = await run(makeHarness({ digestSentences: ['好了。'] }), '改一下这个函数');
    expect(zh[1]).toMatchObject({ type: 'ack', text: '好的，我去处理' });

    const en = await run(makeHarness({ digestSentences: ['Done.'] }), 'change this function');
    expect(en[1]).toMatchObject({ type: 'ack', text: 'Got it, working on it.' });
  });

  it('pairs each text event with an audio event at the same seq', async () => {
    const h = makeHarness({ digestSentences: ['First.', 'Second.', 'Third.'] });
    const events = await run(h, 'go');

    expect(textsOf(events).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(audiosOf(events).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(ttsCalls).toEqual(['First.', 'Second.', 'Third.']);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('speaks a short reply verbatim without digesting it', async () => {
    const h = makeHarness({ reply: 'All three tests pass.', digestSentences: null, oneShotDigest: null });
    const events = await run(h, 'status');
    // digestSentences null means streaming is unavailable and the one-shot
    // digest returns nothing, so a digested reply would come out empty —
    // getting the original text back proves the short-reply path skipped both.
    expect(textsOf(events).map((e) => e.text)).toEqual(['All three tests pass.']);
  });

  it('errors when the agent produces nothing', async () => {
    const h = makeHarness({ reply: '   ' });
    const events = await run(h, 'go');
    expect(typesOf(events)).toEqual(['start', 'ack', 'error']);
  });

  it('turns an unexpected throw into an error event rather than rejecting', async () => {
    const h = makeHarness();
    h.gateway.getVoiceHandler = () => ({ runMessage: async () => { throw new Error('agent exploded'); } });
    const events = await run(h, 'go');
    expect(events.at(-1)).toEqual({ type: 'error', message: 'agent exploded' });
  });
});

describe('runVoiceConverse — degradation', () => {
  const longReply = LONG_REPLY;

  it('falls back to the one-shot digest when streaming is unavailable', async () => {
    const h = makeHarness({ reply: longReply, digestSentences: null, oneShotDigest: 'One shot gist.' });
    const events = await run(h, 'go');
    expect(textsOf(events).map((e) => e.text)).toEqual(['One shot gist.']);
  });

  it('speaks the undigested reply when every digest path fails', async () => {
    const h = makeHarness({ reply: 'Undigested. Still spoken.', digestSentences: null, oneShotDigest: null });
    const events = await run(h, 'go');
    expect(textsOf(events).map((e) => e.text)).toEqual(['Undigested.', 'Still spoken.']);
  });

  it('emits text but no audio in client TTS mode', async () => {
    const h = makeHarness({ tts: { ...TTS_CONFIG, enabled: false }, digestSentences: ['Spoken by the client.'] });
    const events = await run(h, 'go');

    expect(events[0]).toEqual({ type: 'start', tts: 'client' });
    expect(textsOf(events)).toHaveLength(1);
    expect(audiosOf(events)).toHaveLength(0);
    expect(ttsCalls).toEqual([]);
  });

  it('treats a missing api key as client mode even when enabled', async () => {
    const h = makeHarness({ tts: { ...TTS_CONFIG, apiKey: '' }, digestSentences: ['No key.'] });
    expect((await run(h, 'go'))[0]).toEqual({ type: 'start', tts: 'client' });
  });

  it('flags ttsDegraded and stops synthesizing once synthesis fails', async () => {
    ttsState.impl = async (t) => {
      if (t === 'Second.') throw new Error('tts 500');
      return Buffer.from(`audio:${t}`);
    };
    const h = makeHarness({ digestSentences: ['First.', 'Second.', 'Third.'] });
    const events = await run(h, 'go');

    // All text still goes out — the client needs it to speak the rest itself.
    expect(textsOf(events).map((e) => e.text)).toEqual(['First.', 'Second.', 'Third.']);
    expect(audiosOf(events).map((e) => e.seq)).toEqual([0]);
    expect(events.at(-1)).toEqual({ type: 'done', ttsDegraded: true });
  });
});
