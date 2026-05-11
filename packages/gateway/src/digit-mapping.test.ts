import { describe, it, expect } from 'vitest';
import { resolveChoiceDigit } from './digit-mapping';

describe('resolveChoiceDigit', () => {
  const opts = ['yes', 'no', 'maybe'];

  it('maps "1" to first option', () => {
    expect(resolveChoiceDigit('1', opts)).toBe('yes');
  });

  it('maps "  2 " to second option (whitespace tolerated)', () => {
    expect(resolveChoiceDigit('  2 ', opts)).toBe('no');
  });

  it('returns null for out-of-range digit', () => {
    expect(resolveChoiceDigit('5', opts)).toBeNull();
    expect(resolveChoiceDigit('0', opts)).toBeNull();
  });

  it('returns null for non-digit text', () => {
    expect(resolveChoiceDigit('yes', opts)).toBeNull();
    expect(resolveChoiceDigit('1!', opts)).toBeNull();
  });

  it('returns null when options is empty', () => {
    expect(resolveChoiceDigit('1', [])).toBeNull();
  });
});
