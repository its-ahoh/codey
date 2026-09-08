import { describe, it, expect, vi } from 'vitest';
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

  it('keeps worker tokens out of the transcript when they have their own bubbles', async () => {
    const workerMsgs = { onStream: vi.fn(), onThinking: vi.fn() } as any;
    const e = new ChatEmitter(() => {}, 'c1', workerMsgs);
    expect(e.rendersWorkerBubbles).toBe(true);
    e.onStream('the whole answer');
    await e.notify('a question for you');
    expect(workerMsgs.onStream).toHaveBeenCalledWith('the whole answer');
    // The member bubble owns the answer; only the group-level notice is left.
    expect(e.transcript).toBe('a question for you');
  });

  it('reports no worker bubbles without a WorkerMessageEmitter', () => {
    expect(new ChatEmitter(() => {}, 'c1').rendersWorkerBubbles).toBe(false);
    expect(new ChannelEmitter(async () => {}, undefined, 'c1', 'telegram' as any).rendersWorkerBubbles).toBe(false);
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

  it('status is not sent as a channel message', async () => {
    const sent: any[] = [];
    const e = new ChannelEmitter(async (r) => { sent.push(r); }, undefined, 'c1', 'telegram' as any);
    await e.status('working');
    expect(sent).toEqual([]);
  });
});
