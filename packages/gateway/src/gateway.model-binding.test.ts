import { describe, expect, it } from 'vitest';
import { bindModelToApiKey, unwiredAllModelWarning } from './gateway';

const key = {
  apiKey: 'sk-shared',
  anthropicBaseUrl: 'https://proxy.test/anthropic',
  openaiBaseUrl: 'https://proxy.test/openai',
};

describe('bindModelToApiKey', () => {
  it('gives an "all" model both endpoints so either protocol can be wired up', () => {
    const cfg = bindModelToApiKey({ model: 'acme-max', apiType: 'all' }, key);
    expect(cfg.anthropicBaseUrl).toBe('https://proxy.test/anthropic');
    expect(cfg.openaiBaseUrl).toBe('https://proxy.test/openai');
    expect(cfg.apiKey).toBe('sk-shared');
  });

  it('carries whichever endpoint an "all" model\'s key actually defines', () => {
    const cfg = bindModelToApiKey(
      { model: 'acme-max', apiType: 'all' },
      { apiKey: 'sk-shared', openaiBaseUrl: 'https://proxy.test/openai' },
    );
    expect(cfg.anthropicBaseUrl).toBeUndefined();
    expect(cfg.openaiBaseUrl).toBe('https://proxy.test/openai');
  });

  it('withholds the dual endpoints from single-protocol models', () => {
    for (const apiType of ['anthropic', 'openai'] as const) {
      const cfg = bindModelToApiKey({ model: 'm', apiType }, key);
      expect(cfg.anthropicBaseUrl).toBeUndefined();
      expect(cfg.openaiBaseUrl).toBeUndefined();
    }
  });

  it('points baseUrl at the model\'s own protocol', () => {
    expect(bindModelToApiKey({ model: 'm', apiType: 'anthropic' }, key).baseUrl)
      .toBe('https://proxy.test/anthropic');
    expect(bindModelToApiKey({ model: 'm', apiType: 'openai' }, key).baseUrl)
      .toBe('https://proxy.test/openai');
  });

  it('resolves an "all" model\'s baseUrl anthropic-first for single-protocol callers', () => {
    expect(bindModelToApiKey({ model: 'm', apiType: 'all' }, key).baseUrl)
      .toBe('https://proxy.test/anthropic');
    expect(bindModelToApiKey({ model: 'm', apiType: 'all' }, { apiKey: 'k', openaiBaseUrl: 'https://o' }).baseUrl)
      .toBe('https://o');
  });

  it('leaves every endpoint unset when the model is bound to no key', () => {
    const cfg = bindModelToApiKey({ model: 'm', apiType: 'all' });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.anthropicBaseUrl).toBeUndefined();
    expect(cfg.openaiBaseUrl).toBeUndefined();
  });

  it('keeps an explicit provider label and defaults the rest by protocol', () => {
    expect(bindModelToApiKey({ model: 'm', apiType: 'all', provider: 'acme' }).provider).toBe('acme');
    expect(bindModelToApiKey({ model: 'm', apiType: 'openai' }).provider).toBe('openai');
    expect(bindModelToApiKey({ model: 'm', apiType: 'anthropic' }).provider).toBe('anthropic');
  });
});

describe('unwiredAllModelWarning', () => {
  it('says nothing when the key covers both protocols', () => {
    expect(unwiredAllModelWarning(bindModelToApiKey({ model: 'acme-max', apiType: 'all' }, key))).toBeUndefined();
  });

  it('names the missing protocol and the key it is missing from', () => {
    const cfg = bindModelToApiKey(
      { model: 'acme-max', apiType: 'all' },
      { apiKey: 'sk-shared', openaiBaseUrl: 'https://proxy.test/openai' },
    );
    const warning = unwiredAllModelWarning(cfg, 'acme-proxy');
    expect(warning).toContain('acme-max');
    expect(warning).toContain('"acme-proxy"');
    expect(warning).toContain('no anthropic base URL');
    expect(warning).not.toContain('openai base URL');
  });

  it('reports both halves when the key defines no endpoint at all', () => {
    const cfg = bindModelToApiKey({ model: 'acme-max', apiType: 'all' }, { apiKey: 'sk-shared' });
    expect(unwiredAllModelWarning(cfg)).toContain('neither protocol is wired up');
  });

  it('says nothing about single-protocol models or unbound ones', () => {
    expect(unwiredAllModelWarning(bindModelToApiKey({ model: 'm', apiType: 'anthropic' }, key))).toBeUndefined();
    expect(unwiredAllModelWarning(bindModelToApiKey({ model: 'm', apiType: 'all' }))).toBeUndefined();
  });
});
