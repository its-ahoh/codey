import { describe, it, expect } from 'vitest';
import { isApiType, modelFitsApiType } from './index';

describe('isApiType', () => {
  it('accepts the three protocol values and nothing else', () => {
    expect(isApiType('anthropic')).toBe(true);
    expect(isApiType('openai')).toBe(true);
    expect(isApiType('all')).toBe(true);
    expect(isApiType('gemini')).toBe(false);
    expect(isApiType(undefined)).toBe(false);
  });
});

describe('modelFitsApiType', () => {
  it('matches a model against an agent that speaks the same protocol', () => {
    expect(modelFitsApiType('anthropic', 'anthropic')).toBe(true);
    expect(modelFitsApiType('openai', 'openai')).toBe(true);
  });

  it('rejects a protocol mismatch', () => {
    expect(modelFitsApiType('anthropic', 'openai')).toBe(false);
    expect(modelFitsApiType('openai', 'anthropic')).toBe(false);
  });

  it("lets an 'all' model drive any agent", () => {
    expect(modelFitsApiType('all', 'anthropic')).toBe(true);
    expect(modelFitsApiType('all', 'openai')).toBe(true);
  });

  it("lets an 'all' agent take any model", () => {
    expect(modelFitsApiType('anthropic', 'all')).toBe(true);
    expect(modelFitsApiType('openai', 'all')).toBe(true);
    expect(modelFitsApiType('all', 'all')).toBe(true);
  });

  it('accepts anything when the agent declares no protocol', () => {
    expect(modelFitsApiType('anthropic', undefined)).toBe(true);
    expect(modelFitsApiType('openai', undefined)).toBe(true);
  });
});
