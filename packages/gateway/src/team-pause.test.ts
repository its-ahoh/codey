import { describe, it, expect } from 'vitest';
import { renderQuestion } from './team-pause';

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
});
