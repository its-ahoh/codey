import { describe, it, expect } from 'vitest';
import { renderQuestion, renderQuestionMessage } from './team-pause';

describe('renderQuestion', () => {
  it('returns text only for free-text question', () => {
    const r = renderQuestion('coder', 'I looked.', 'which db?');
    expect(r.text).toContain('which db?');
    expect(r.choices).toBeUndefined();
  });

  it('returns text + choices for a choice question', () => {
    const r = renderQuestion('coder', '', 'merge?', ['yes', 'no']);
    expect(r.text).toContain('merge?');
    expect(r.choices).toEqual(['yes', 'no']);
  });

  it('renderQuestionMessage stays string-typed for legacy callers', () => {
    const t = renderQuestionMessage('coder', '', 'q?');
    expect(typeof t).toBe('string');
    expect(t).toContain('q?');
  });
});
