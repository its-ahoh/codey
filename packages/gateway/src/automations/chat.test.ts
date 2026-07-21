import { describe, it, expect, vi } from 'vitest';
import { AutomationChatManager, SESSION_TTL_MS } from './chat';
import type { AutomationChatTurn } from '@codey/core';

const CTX = { workspaces: ['default'], teams: ['news'], tz: 'Asia/Shanghai', nowIso: 'now' };
const COMPLETE = {
  name: 'News', target: { kind: 'prompt' as const, workspaceName: 'default' },
  brief: 'Post five items.', params: {},
};

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
    const { sessionId } = mgr.start('edit', { schedule: { slots: [{ hour: 9, minute: 0 }], tz: 'UTC' } });
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

describe('dry-run check state', () => {
  it('sets check=pending and fires onReadyTransition only on a false->true ready transition', async () => {
    const onReadyTransition = vi.fn();
    const turn = vi.fn()
      .mockResolvedValueOnce(turnResult({ ready: true }))
      .mockResolvedValueOnce(turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX, onReadyTransition });
    const { sessionId } = mgr.start('create', COMPLETE);

    const first = await mgr.send(sessionId, 'go');
    expect(first.check).toBe('pending');
    expect(onReadyTransition).toHaveBeenCalledTimes(1);
    expect(onReadyTransition).toHaveBeenCalledWith(sessionId, COMPLETE);

    const second = await mgr.send(sessionId, 'still ready');
    expect(onReadyTransition).toHaveBeenCalledTimes(1); // no re-trigger while ready stays true
    expect(second.check).toBe('pending');               // state carries over
  });

  it('clears check when ready drops back to false, and re-triggers on the next rise', async () => {
    const onReadyTransition = vi.fn();
    const turn = vi.fn()
      .mockResolvedValueOnce(turnResult({ ready: true }))
      .mockResolvedValueOnce(turnResult({ ready: false }))
      .mockResolvedValueOnce(turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX, onReadyTransition });
    const { sessionId } = mgr.start('create', COMPLETE);
    await mgr.send(sessionId, 'a');
    const dropped = await mgr.send(sessionId, 'b');
    expect(dropped.check).toBeUndefined();
    await mgr.send(sessionId, 'c');
    expect(onReadyTransition).toHaveBeenCalledTimes(2);
  });

  it('resolveCheck records the verdict and appends the message to the transcript', async () => {
    const turn = vi.fn().mockResolvedValue(turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX });
    const { sessionId } = mgr.start('create', COMPLETE);
    await mgr.send(sessionId, 'go');

    expect(mgr.resolveCheck(sessionId, 'clean', 'Dry run passed.')).toBe(true);
    const next = await mgr.send(sessionId, 'next');
    expect(next.check).toBe('clean');
    const transcript = turn.mock.calls[1][0];
    expect(transcript.some((m: any) => m.role === 'assistant' && m.text === 'Dry run passed.')).toBe(true);
  });

  it('resolveCheck is rejected when the check is not pending or the session is gone', async () => {
    const turn = vi.fn().mockResolvedValue(turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX });
    const { sessionId } = mgr.start('create', COMPLETE);
    expect(mgr.resolveCheck(sessionId, 'clean')).toBe(false); // never went pending
    await mgr.send(sessionId, 'go');
    expect(mgr.resolveCheck(sessionId, 'gaps', 'q')).toBe(true);
    expect(mgr.resolveCheck(sessionId, 'clean')).toBe(false); // already resolved
    expect(mgr.resolveCheck('nope', 'clean')).toBe(false);    // unknown session
  });

  it('a late verdict is rejected after ready dropped and cleared the pending check', async () => {
    const turn = vi.fn()
      .mockResolvedValueOnce(turnResult({ ready: true }))
      .mockResolvedValueOnce(turnResult({ ready: false }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX });
    const { sessionId } = mgr.start('create', COMPLETE);
    await mgr.send(sessionId, 'go');       // check -> pending
    await mgr.send(sessionId, 'actually'); // ready drops, check cleared
    expect(mgr.resolveCheck(sessionId, 'clean')).toBe(false);
  });

  it('direct form patches become ready and recheck only execution-relevant changes', () => {
    const onReadyTransition = vi.fn();
    const mgr = new AutomationChatManager({ turn: vi.fn(), context: () => CTX, onReadyTransition });
    const { sessionId } = mgr.start('create');
    const complete = mgr.patch(sessionId, COMPLETE);
    expect(complete.ready).toBe(true);
    expect(complete.check).toBe('pending');
    expect(onReadyTransition).toHaveBeenCalledTimes(1);
    expect(mgr.resolveCheck(sessionId, 'clean')).toBe(true);

    const renamed = mgr.patch(sessionId, { name: 'Renamed' });
    expect(renamed.check).toBe('clean');
    expect(onReadyTransition).toHaveBeenCalledTimes(1);

    const changed = mgr.patch(sessionId, { brief: 'Post ten items.' });
    expect(changed.check).toBe('pending');
    expect(onReadyTransition).toHaveBeenCalledTimes(2);
  });

  it('finalizes only checked drafts and retains edit source identity', () => {
    const mgr = new AutomationChatManager({ turn: vi.fn(), context: () => CTX });
    const { sessionId } = mgr.start('edit', COMPLETE, 'automation-1');
    mgr.patch(sessionId, { name: 'Renamed' });
    expect(() => mgr.finalize(sessionId)).toThrow(/check/i);
    expect(mgr.resolveCheck(sessionId, 'clean')).toBe(true);
    expect(mgr.finalize(sessionId)).toEqual({
      mode: 'edit', sourceAutomationId: 'automation-1', draft: { ...COMPLETE, name: 'Renamed' },
    });
  });

  it('allows an explicit override only for a failed check, never gaps', () => {
    const mgr = new AutomationChatManager({ turn: vi.fn(), context: () => CTX });
    const gaps = mgr.start('create', COMPLETE).sessionId;
    mgr.patch(gaps, { name: 'Ready' });
    mgr.resolveCheck(gaps, 'gaps');
    expect(() => mgr.finalize(gaps, true)).toThrow(/pass/i);

    const failed = mgr.start('create', COMPLETE).sessionId;
    mgr.patch(failed, { name: 'Ready' });
    mgr.resolveCheck(failed, 'error');
    expect(mgr.finalize(failed, true).draft.name).toBe('Ready');
  });
});
