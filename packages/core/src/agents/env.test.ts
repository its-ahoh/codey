import { describe, it, expect } from 'vitest';
import { applyModelEnv, withCommonBinPaths } from './env';

describe('withCommonBinPaths', () => {
  it('prepends the usual CLI bin dirs to a minimal GUI PATH', () => {
    const env = { HOME: '/Users/tester', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    expect(segments).toContain('/Users/tester/.local/bin');
    expect(segments).toContain('/opt/homebrew/bin');
    expect(segments).toContain('/usr/local/bin');
    expect(segments.slice(-4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  it('does not duplicate a path that is already present', () => {
    const env = { HOME: '/Users/tester', PATH: '/opt/homebrew/bin:/usr/bin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    expect(segments.filter(p => p === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('does not treat a substring match as already present', () => {
    const env = { HOME: '/Users/tester', PATH: '/opt/homebrew/bin/inner:/usr/bin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    expect(segments).toContain('/opt/homebrew/bin');
  });
});

describe('applyModelEnv', () => {
  it('wires anthropic-style credentials for an anthropic model', () => {
    const env = applyModelEnv({}, {
      provider: 'anthropic', model: 'claude-sonnet-4-5',
      apiKey: 'sk-a', baseUrl: 'https://proxy/anthropic', apiType: 'anthropic',
    }, 'anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-a');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy/anthropic');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('wires openai-style credentials for an openai model', () => {
    const env = applyModelEnv({}, {
      provider: 'openai', model: 'gpt-5',
      apiKey: 'sk-o', baseUrl: 'https://proxy/v1', apiType: 'openai',
    }, 'openai');
    expect(env.OPENAI_API_KEY).toBe('sk-o');
    expect(env.OPENAI_BASE_URL).toBe('https://proxy/v1');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('wires both protocols for an "all" model that has both endpoints', () => {
    const env = applyModelEnv({}, {
      provider: 'acme', model: 'acme-max', apiKey: 'sk-both', apiType: 'all',
      anthropicBaseUrl: 'https://acme/anthropic',
      openaiBaseUrl: 'https://acme/v1',
    }, 'anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-both');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://acme/anthropic');
    expect(env.OPENAI_API_KEY).toBe('sk-both');
    expect(env.OPENAI_BASE_URL).toBe('https://acme/v1');
  });

  it('leaves a protocol untouched when an "all" model has no URL for it', () => {
    // Injecting the token with no base URL would aim it at the real
    // api.openai.com and fail auth in a way that looks like a bad key.
    const env = applyModelEnv({}, {
      provider: 'acme', model: 'acme-max', apiKey: 'sk-both', apiType: 'all',
      anthropicBaseUrl: 'https://acme/anthropic',
    }, 'openai');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://acme/anthropic');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it('falls back to the adapter default when the model declares no apiType', () => {
    const env = applyModelEnv({}, {
      provider: 'x', model: 'm', apiKey: 'sk-f', baseUrl: 'https://x/v1',
    }, 'openai');
    expect(env.OPENAI_API_KEY).toBe('sk-f');
    expect(env.OPENAI_BASE_URL).toBe('https://x/v1');
  });

  it('does not mutate anything for an absent model', () => {
    expect(applyModelEnv({ PATH: '/usr/bin' }, undefined, 'anthropic')).toEqual({ PATH: '/usr/bin' });
  });
});
