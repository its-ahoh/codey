import { describe, it, expect } from 'vitest';
import { parseAskUser } from './ask-user';

describe('parseAskUser', () => {
  it('returns null when no marker is present', () => {
    expect(parseAskUser('hello world\nno marker here')).toBeNull();
  });

  it('parses a standalone marker line', () => {
    const out = parseAskUser('[ASK_USER]: should I use postgres or sqlite?');
    expect(out).toEqual({
      preamble: '',
      question: 'should I use postgres or sqlite?',
    });
  });

  it('parses a marker after preamble content', () => {
    const text = [
      'I started looking at the schema.',
      'Two options exist.',
      '[ASK_USER]: which database should I target?',
      'I will wait.',
    ].join('\n');
    const out = parseAskUser(text);
    expect(out).toEqual({
      preamble: 'I started looking at the schema.\nTwo options exist.',
      question: 'which database should I target?',
    });
  });

  it('uses the first marker when multiple exist', () => {
    const text = '[ASK_USER]: first?\n[ASK_USER]: second?';
    const out = parseAskUser(text);
    expect(out?.question).toBe('first?');
  });

  it('tolerates leading whitespace before the marker', () => {
    const out = parseAskUser('   [ASK_USER]:   trim me  ');
    expect(out).toEqual({ preamble: '', question: 'trim me' });
  });

  it('returns null when the question is empty after trim', () => {
    expect(parseAskUser('[ASK_USER]:    ')).toBeNull();
  });
});
