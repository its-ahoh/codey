import { describe, it, expect } from 'vitest';
import { parseAskAdvisor, stripAskAdvisor } from './utils/ask-user';

describe('parseAskAdvisor', () => {
  it('returns null when no marker present', () => {
    expect(parseAskAdvisor('just a normal reply')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseAskAdvisor('')).toBeNull();
  });

  it('returns null when reason is blank', () => {
    expect(parseAskAdvisor('[ASK_ADVISOR]:   ')).toBeNull();
  });

  it('parses reason and preamble', () => {
    const out = 'I tried X and Y.\n[ASK_ADVISOR]: stuck on the auth flow';
    expect(parseAskAdvisor(out)).toEqual({
      preamble: 'I tried X and Y.',
      reason: 'stuck on the auth flow',
    });
  });

  it('matches the first marker in document order', () => {
    const out = 'a\n[ASK_ADVISOR]: first\n[ASK_ADVISOR]: second';
    expect(parseAskAdvisor(out)?.reason).toBe('first');
  });
});

describe('stripAskAdvisor', () => {
  it('removes the marker line and trailing whitespace', () => {
    const out = 'kept line\n[ASK_ADVISOR]: blah\n';
    expect(stripAskAdvisor(out)).toBe('kept line');
  });

  it('leaves marker-free text unchanged (sans trailing ws)', () => {
    expect(stripAskAdvisor('hello world')).toBe('hello world');
  });

  it('removes multiple marker lines', () => {
    expect(stripAskAdvisor('a\n[ASK_ADVISOR]: x\nb\n[ASK_ADVISOR]: y')).toBe('a\nb');
  });
});
