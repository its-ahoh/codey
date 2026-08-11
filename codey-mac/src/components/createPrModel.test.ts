import { describe, it, expect } from 'vitest';
import { createPrButtonState } from './createPrModel';

describe('createPrButtonState', () => {
  it('hidden while working/blocked', () => {
    expect(createPrButtonState('working', true).show).toBe(false);
    expect(createPrButtonState('blocked', true).show).toBe(false);
  });
  it('shown when waiting or done', () => {
    expect(createPrButtonState('waiting', true).show).toBe(true);
    expect(createPrButtonState('done', false).show).toBe(true);
  });
  it('enabled only when branch is ahead', () => {
    expect(createPrButtonState('done', true).enabled).toBe(true);
    expect(createPrButtonState('done', false).enabled).toBe(false);
  });
});
