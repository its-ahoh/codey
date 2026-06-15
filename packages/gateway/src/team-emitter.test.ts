import { describe, it, expect } from 'vitest';
import { ChannelEmitter, ChatEmitter } from './team-emitter';

describe('ChatEmitter', () => {
  it('accumulates notify text into the transcript and streams it', () => {
    const events: any[] = [];
    const e = new ChatEmitter((ev) => events.push(ev), 'c1');
    e.onStream('hello ');
    return e.notify('world').then(() => {
      expect(e.transcript).toContain('world');
      expect(events.some(v => v.type === 'stream' && v.token === 'world')).toBe(true);
    });
  });

  it('captures the latest choices from notify', async () => {
    const e = new ChatEmitter(() => {}, 'c1');
    await e.notify('pick one', ['a', 'b']);
    expect(e.choices).toEqual(['a', 'b']);
  });

  it('forwards thinking tokens to the sink', () => {
    const events: any[] = [];
    const e = new ChatEmitter((ev) => events.push(ev), 'c1');
    e.onThinking('pondering', 2);
    expect(events.some(v => v.type === 'thinking' && v.token === 'pondering' && v.step === 2)).toBe(true);
  });

  it('status emits an info event and is NOT recorded in the transcript', async () => {
    const events: any[] = [];
    const e = new ChatEmitter((ev) => events.push(ev), 'c1');
    await e.status('Step 1: coder');
    expect(events.some(v => v.type === 'info' && v.message === 'Step 1: coder')).toBe(true);
    expect(e.transcript).toBe('');
  });
});

describe('ChannelEmitter', () => {
  it('routes notify through the provided sendResponse and keeps transcript empty', async () => {
    const sent: any[] = [];
    const e = new ChannelEmitter(
      async (r) => { sent.push(r); },
      (text) => { sent.push({ stream: text }); },
      'c1', 'telegram' as any,
    );
    e.onStream('tok');
    await e.notify('done', ['x']);
    expect(sent).toContainEqual({ chatId: 'c1', channel: 'telegram', text: 'done', choices: ['x'] });
    expect(sent).toContainEqual({ stream: 'tok' });
    expect(e.transcript).toBe('');
  });

  it('status routes through sendResponse without choices', async () => {
    const sent: any[] = [];
    const e = new ChannelEmitter(async (r) => { sent.push(r); }, undefined, 'c1', 'telegram' as any);
    await e.status('working');
    expect(sent).toContainEqual({ chatId: 'c1', channel: 'telegram', text: 'working' });
  });
});
