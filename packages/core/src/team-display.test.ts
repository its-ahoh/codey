import { describe, it, expect } from 'vitest';
import { parseMarkers } from './team-blackboard';
import { lastParagraphPreview } from './utils/format';

describe('parseMarkers — bullet/list-prefixed markers', () => {
  it('strips a plain line-start marker (existing behaviour)', () => {
    const { markers, stripped } = parseMarkers('hello\n[DECISION]: use X\nworld');
    expect(markers).toEqual([{ kind: 'decision', text: 'use X' }]);
    expect(stripped).toBe('hello\nworld');
  });

  it('strips a marker behind a "- " bullet and records it', () => {
    const { markers, stripped } = parseMarkers('intro\n- [DECISION]: use X because Y\nrest');
    expect(markers).toEqual([{ kind: 'decision', text: 'use X because Y' }]);
    expect(stripped).toBe('intro\nrest');
  });

  it('strips "* " and "• " bullets and numbered list markers', () => {
    const input = [
      '* [FACT]: db is postgres',
      '• [OPEN]: who owns deploy',
      '1. [HANDOFF: bob]: pick up the API',
    ].join('\n');
    const { markers, stripped } = parseMarkers(input);
    expect(stripped).toBe('');
    expect(markers).toEqual([
      { kind: 'fact', text: 'db is postgres' },
      { kind: 'open', text: 'who owns deploy' },
      { kind: 'handoff', to: 'bob', text: 'pick up the API' },
    ]);
  });

  it('does not treat a real markdown checkbox/list item as a marker', () => {
    const input = '- [ ] todo item\n- [x] done item';
    const { markers, stripped } = parseMarkers(input);
    expect(markers).toEqual([]);
    expect(stripped).toBe(input);
  });
});

describe('lastParagraphPreview', () => {
  it('returns the last paragraph when under the cap', () => {
    expect(lastParagraphPreview('first para\n\nsecond para', 200)).toBe('second para');
  });

  it('caps long paragraphs with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = lastParagraphPreview(long, 200);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(201);
  });

  it('returns empty string for blank input', () => {
    expect(lastParagraphPreview('   \n  ', 200)).toBe('');
  });

  it('ignores trailing blank paragraphs', () => {
    expect(lastParagraphPreview('real content\n\n\n   ', 200)).toBe('real content');
  });
});
