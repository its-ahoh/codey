import { describe, it, expect, vi } from 'vitest';
import { AutomationChatManager, SESSION_TTL_MS } from './chat';
import type { AutomationChatTurn } from '@codey/core';

const CTX = { workspaces: ['default'], teams: ['news'], tz: 'Asia/Shanghai', nowIso: 'now' };

const turnResult = (over: Partial<AutomationChatTurn> = {}): AutomationChatTurn =>
  ({ reply: 'ok', draftPatch: {}, suggestions: [], ready: false, ...over });

const manager = (turn: any = vi.fn(async () => turnResult()), now?: () => number) => ({
  mgr: new AutomationChatManager({ turn, context: () => CTX, now }),
  turn,
});

describe('start', () => {
  it('create mode opens with a fixed prompt and empty draft', () => {
    const { mgr } = manager();
    const step = mgr.start('create');
    expect(step.reply).toMatch(/What should this automation do/);
    expect(step.draft).toEqual({});
    expect(step.ready).toBe(false);
    expect(step.suggestions).toEqual([]);
  });

  it('edit mode seeds the initial draft and asks what to change', () => {
    const { mgr } = manager();
    const step = mgr.start('edit', { name: 'News', brief: 'b' });
    expect(step.reply).toMatch(/What should change/);
    expect(step.draft).toEqual({ name: 'News', brief: 'b' });
  });
});

describe('send', () => {
  it('passes transcript + draft + mode to the turn and merges the patch', async () => {
    const turn = vi.fn(async () => turnResult({
      reply: 'Which workspace?', draftPatch: { name: 'News' }, suggestions: ['default'],
    }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('create');
    const step = await mgr.send(sessionId, 'post news');
    expect(turn).toHaveBeenCalledWith(
      [
        { role: 'assistant', text: expect.stringMatching(/What should this automation do/) },
        { role: 'user', text: 'post news' },
      ],
      {},
      { ...CTX, mode: 'create' },
    );
    expect(step.draft).toEqual({ name: 'News' });
    expect(step.suggestions).toEqual(['default']);
  });

  it('commits the transcript only on success - a failed turn retries without duplication', async () => {
    const turn = vi.fn()
      .mockRejectedValueOnce(new Error('aide down'))
      .mockResolvedValueOnce(turnResult({ reply: 'hi' }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('create');
    await expect(mgr.send(sessionId, 'post news')).rejects.toThrow('aide down');
    await mgr.send(sessionId, 'post news');
    const transcript = turn.mock.calls[1][0];
    expect(transcript.filter((m: any) => m.role === 'user')).toHaveLength(1);
  });

  it('a null patch value clears the field', async () => {
    const turn = vi.fn(async () => turnResult({ draftPatch: { schedule: null } as any }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('edit', { schedule: { hour: 9, minute: 0, tz: 'UTC' } });
    const step = await mgr.send(sessionId, 'make it manual');
    expect('schedule' in step.draft).toBe(false);
  });

  it('rejects a second send while one is in flight', async () => {
    let release!: (v: AutomationChatTurn) => void;
    const turn = vi.fn(() => new Promise<AutomationChatTurn>(res => { release = res; }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('create');
    const first = mgr.send(sessionId, 'one');
    await expect(mgr.send(sessionId, 'two')).rejects.toThrow(/in flight/);
    release(turnResult());
    await first;
  });

  it('throws for unknown or cancelled sessions', async () => {
    const { mgr } = manager();
    await expect(mgr.send('nope', 'x')).rejects.toThrow(/Unknown/);
    const { sessionId } = mgr.start('create');
    mgr.cancel(sessionId);
    await expect(mgr.send(sessionId, 'x')).rejects.toThrow(/Unknown/);
  });

  it('a send whose session is cancelled mid-turn rejects instead of resolving', async () => {
    let release!: (v: AutomationChatTurn) => void;
    const turn = vi.fn(() => new Promise<AutomationChatTurn>(res => { release = res; }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('create');
    const pending = mgr.send(sessionId, 'one');
    mgr.cancel(sessionId);
    release(turnResult());
    await expect(pending).rejects.toThrow(/Unknown/);
  });

  it('sweeps idle sessions past the TTL', async () => {
    let now = 1000;
    const { mgr } = manager(vi.fn(async () => turnResult()), () => now);
    const { sessionId } = mgr.start('create');
    now += SESSION_TTL_MS + 1;
    mgr.start('create'); // any entry point sweeps
    await expect(mgr.send(sessionId, 'x')).rejects.toThrow(/Unknown/);
  });
});
