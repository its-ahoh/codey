import { describe, it, expect } from 'vitest';
import { rewriteStartPairCommand } from './telegram';

describe('rewriteStartPairCommand', () => {
  it('rewrites a QR deep-link start payload into /pair', () => {
    expect(rewriteStartPairCommand('/start pair_123456')).toBe('/pair 123456');
  });

  it('leaves a plain /start untouched', () => {
    expect(rewriteStartPairCommand('/start')).toBe('/start');
  });

  it('leaves non-pairing payloads untouched', () => {
    expect(rewriteStartPairCommand('/start something_else')).toBe('/start something_else');
    expect(rewriteStartPairCommand('/start pair_12')).toBe('/start pair_12');
    expect(rewriteStartPairCommand('/start pair_1234567')).toBe('/start pair_1234567');
  });

  it('leaves normal messages untouched', () => {
    expect(rewriteStartPairCommand('hello pair_123456')).toBe('hello pair_123456');
    expect(rewriteStartPairCommand('/pair 123456')).toBe('/pair 123456');
  });
});
