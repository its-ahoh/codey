import { describe, it, expect } from 'vitest';
import { resolveEffort } from './effort-resolve';

describe('resolveEffort', () => {
  it('prefers the chat override over everything', () => {
    expect(resolveEffort({ chat: 'low', worker: 'high', global: 'max' })).toBe('low');
  });

  it('falls back to the worker effort when the chat has none', () => {
    expect(resolveEffort({ worker: 'high', global: 'max' })).toBe('high');
  });

  it('falls back to the global default when neither is set', () => {
    expect(resolveEffort({ global: 'max' })).toBe('max');
  });

  it('returns undefined when nothing is set, so no flag is passed', () => {
    expect(resolveEffort({})).toBeUndefined();
  });
});
