import { describe, it, expect } from 'vitest';
import { needsRecheck, verdictToCheck } from './check';

const base = {
  target: { kind: 'prompt' as const, workspaceName: 'default' },
  brief: 'Post five items.',
  params: { count: '5' },
};

describe('needsRecheck', () => {
  it('always checks a newly created automation', () => {
    expect(needsRecheck(undefined, base)).toBe(true);
  });

  it('skips a rename / reschedule / notify-only edit', () => {
    expect(needsRecheck(base, { ...base })).toBe(false);
  });

  it('checks when the brief, params or target change', () => {
    expect(needsRecheck(base, { ...base, brief: 'Post six items.' })).toBe(true);
    expect(needsRecheck(base, { ...base, params: { count: '6' } })).toBe(true);
    expect(needsRecheck(base, { ...base, target: { kind: 'prompt', workspaceName: 'blog' } })).toBe(true);
  });
});

describe('verdictToCheck', () => {
  it('maps each verdict onto the persisted shape', () => {
    expect(verdictToCheck({ status: 'clean' }, 7)).toEqual({ status: 'clean', at: 7 });
    expect(verdictToCheck({ status: 'gaps', questions: ['Which account?'] }, 7))
      .toEqual({ status: 'gaps', questions: ['Which account?'], at: 7 });
    expect(verdictToCheck({ status: 'error', message: 'agent died' }, 7))
      .toEqual({ status: 'error', detail: 'agent died', at: 7 });
  });
});
