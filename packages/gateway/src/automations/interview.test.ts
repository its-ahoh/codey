// packages/gateway/src/automations/interview.test.ts
import { describe, it, expect, vi } from 'vitest';
import { InterviewManager, type InterviewDeps, type InterviewStep } from './interview';

const deps = (over: Partial<InterviewDeps> = {}): InterviewDeps => ({
  generateQuestions: vi.fn(async () => [
    { id: 'q1', question: 'Which account?' },
    { id: 'q2', question: 'How many items?' },
  ]),
  generateFollowup: vi.fn(async () => null),
  synthesize: vi.fn(async () => ({ brief: 'Post to {{account}}.', params: { account: '@jack' } })),
  ...over,
});

describe('InterviewManager', () => {
  it('walks questions one at a time and synthesizes at the end', async () => {
    const m = new InterviewManager(deps());
    const s = await m.start('post news', 'target: prompt');
    expect(s.question?.question).toBe('Which account?');
    const step2 = await m.answer(s.sessionId, '@jack');
    expect(step2.done).toBe(false);
    expect(step2.question?.question).toBe('How many items?');
    const end = await m.answer(s.sessionId, '5');
    expect(end.done).toBe(true);
    expect(end.brief).toBe('Post to {{account}}.');
    expect(end.params).toEqual({ account: '@jack' });
  });

  it('asks at most ONE follow-up per question', async () => {
    const followup = vi.fn(async () => 'Follow up?');
    const m = new InterviewManager(deps({
      generateQuestions: vi.fn(async () => [{ id: 'q1', question: 'Q?' }]),
      generateFollowup: followup,
    }));
    const s = await m.start('g', 't');
    const f = await m.answer(s.sessionId, 'vague');
    expect(f.question?.question).toBe('Follow up?');
    const end = await m.answer(s.sessionId, 'still vague'); // no second follow-up
    expect(end.done).toBe(true);
    expect(followup).toHaveBeenCalledTimes(1);
  });

  it('synthesizes immediately when no questions come back', async () => {
    const m = new InterviewManager(deps({ generateQuestions: vi.fn(async () => []) }));
    const s = await m.start('g', 't');
    expect(s.done).toBe(true);
    expect(s.brief).toBe('Post to {{account}}.');
  });

  it('throws on unknown session', async () => {
    await expect(new InterviewManager(deps()).answer('nope', 'x')).rejects.toThrow();
  });

  it('removes the session when synthesize throws — retry hits unknown session', async () => {
    const m = new InterviewManager(deps({
      synthesize: vi.fn(async () => { throw new Error('Aide returned no brief'); }),
    }));
    const s = await m.start('g', 't');
    await m.answer(s.sessionId, '@jack');
    await expect(m.answer(s.sessionId, '5')).rejects.toThrow('Aide returned no brief');
    await expect(m.answer(s.sessionId, 'x')).rejects.toThrow(/Unknown interview session/);
  });

  it('cancel() discards the session', async () => {
    const m = new InterviewManager(deps());
    const s = await m.start('g', 't');
    m.cancel(s.sessionId);
    await expect(m.answer(s.sessionId, 'x')).rejects.toThrow(/Unknown interview session/);
  });

  it('moves to the next BASE question after a follow-up is answered', async () => {
    const followup = vi.fn(async (): Promise<string | null> => null)
      .mockResolvedValueOnce('Follow up?');
    const m = new InterviewManager(deps({ generateFollowup: followup }));
    const s = await m.start('g', 't');
    expect(s.question?.question).toBe('Which account?');
    const f = await m.answer(s.sessionId, 'vague');
    expect(f.question?.question).toBe('Follow up?');
    const next = await m.answer(s.sessionId, 'clarified');
    expect(next.done).toBe(false);
    expect(next.question?.question).toBe('How many items?');
    const end = await m.answer(s.sessionId, '5');
    expect(end.done).toBe(true);
    // Once per BASE answer; the follow-up answer itself never triggers another.
    expect(followup).toHaveBeenCalledTimes(2);
  });

  it('rejects an overlapping answer for the same session', async () => {
    const m = new InterviewManager(deps());
    const s = await m.start('g', 't');
    const results = await Promise.allSettled([
      m.answer(s.sessionId, 'a'),
      m.answer(s.sessionId, 'b'),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<InterviewStep>[];
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // State did not skip a question: the winning call advanced to q2 only.
    expect(fulfilled[0].value.done).toBe(false);
    expect(fulfilled[0].value.question?.question).toBe('How many items?');
    const end = await m.answer(s.sessionId, '5');
    expect(end.done).toBe(true);
  });
});
