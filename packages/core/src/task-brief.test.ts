import { describe, it, expect } from 'vitest';
import { coerceTaskBrief } from './task-brief';

describe('coerceTaskBrief', () => {
  it('passes through a well-formed brief and clamps progress', () => {
    const raw = {
      goal: '  Add OAuth  ',
      state: { progress: 160, stepLabel: '3 / 5', status: 'waiting' },
      nextAction: { text: 'Delete old API?', detail: 'unused', messageId: 'm1' },
      timeline: [
        { kind: 'progress', text: 'Writing error handling', detail: ['ran tests', 'edited auth.ts'] },
        { kind: 'decision', text: 'Use Google', why: 'most users have it', when: 123 },
      ],
    };
    const b = coerceTaskBrief(raw, 'fallback', 1000);
    expect(b.goal).toBe('Add OAuth');
    expect(b.state.progress).toBe(100);
    expect(b.state.status).toBe('waiting');
    expect(b.state.stepLabel).toBe('3 / 5');
    expect(b.nextAction).toEqual({ text: 'Delete old API?', detail: 'unused', messageId: 'm1' });
    expect(b.timeline).toHaveLength(2);
    expect(b.timeline[0].detail).toEqual(['ran tests', 'edited auth.ts']);
    expect(b.generatedAt).toBe(1000);
  });

  it('falls back to defaults on garbage input', () => {
    const b = coerceTaskBrief(null, 'My Chat', 5);
    expect(b.goal).toBe('My Chat');
    expect(b.state).toEqual({ progress: 0, stepLabel: undefined, status: 'working' });
    expect(b.nextAction).toBeUndefined();
    expect(b.timeline).toEqual([]);
    expect(b.generatedAt).toBe(5);
  });

  it('drops invalid timeline entries and coerces unknown kinds to action', () => {
    const raw = { goal: 'g', timeline: [
      { kind: 'weird', text: 'x' },
      { text: '' },           // empty text -> dropped
      'nope',                 // non-object -> dropped
      { kind: 'dropped', text: 'passport', why: 'too heavy' },
    ] };
    const b = coerceTaskBrief(raw, 'fb');
    expect(b.timeline.map(e => e.kind)).toEqual(['action', 'dropped']);
    expect(b.timeline[0].text).toBe('x');
  });

  it('ignores a nextAction with no text', () => {
    const b = coerceTaskBrief({ goal: 'g', nextAction: { detail: 'd' } }, 'fb');
    expect(b.nextAction).toBeUndefined();
  });
});
