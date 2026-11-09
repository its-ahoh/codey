import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyModelEnv, nvmBinDirs, preferLocalBin, unwiredAllProtocols, withCommonBinPaths } from './env';

describe('nvmBinDirs', () => {
  it('orders installed versions newest-first', () => {
    expect(nvmBinDirs('/Users/tester', ['v18.20.8', 'v24.18.1', 'v22.17.0', 'v22.17.1'])).toEqual([
      '/Users/tester/.nvm/versions/node/v24.18.1/bin',
      '/Users/tester/.nvm/versions/node/v22.17.1/bin',
      '/Users/tester/.nvm/versions/node/v22.17.0/bin',
      '/Users/tester/.nvm/versions/node/v18.20.8/bin',
    ]);
  });

  it('sorts numerically, not lexically', () => {
    const dirs = nvmBinDirs('/h', ['v9.0.0', 'v10.0.0']);
    expect(dirs[0]).toContain('v10.0.0');
  });

  it('drops alias entries that are not versions', () => {
    expect(nvmBinDirs('/h', ['node', 'lts/*', 'v20.19.4'])).toEqual([
      '/h/.nvm/versions/node/v20.19.4/bin',
    ]);
  });

  it('is empty when nvm has nothing installed', () => {
    expect(nvmBinDirs('/h', [])).toEqual([]);
  });
});

describe('withCommonBinPaths', () => {
  it('prepends the usual CLI bin dirs to a minimal GUI PATH', () => {
    const env = { HOME: '/Users/tester', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    expect(segments).toContain('/Users/tester/.local/bin');
    expect(segments).toContain('/opt/homebrew/bin');
    expect(segments).toContain('/usr/local/bin');
    // The inherited system dirs stay intact and in order after the prepends.
    // (nvm bin dirs, if this machine has any, are appended after them.)
    const first = segments.indexOf('/usr/bin');
    expect(segments.slice(first, first + 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  it('appends nvm bin dirs rather than prepending them', () => {
    // Appending keeps a terminal-launched gateway on the node the user picked.
    const env = { HOME: '/Users/tester', PATH: '/usr/bin:/bin' };
    const segments = (withCommonBinPaths(env).PATH || '').split(':');
    const nvm = segments.filter(p => p.includes('/.nvm/versions/node/'));
    for (const p of nvm) {
      expect(segments.indexOf(p)).toBeGreaterThan(segments.indexOf('/usr/bin'));
    }
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

describe('preferLocalBin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-bin-'));
  const local = path.join(home, '.local/bin');
  const nvm = path.join(home, '.nvm/versions/node/v18.0.0/bin');
  const other = path.join(home, 'fake-bin');
  const tool = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
  };
  tool(local, 'claude');
  tool(nvm, 'claude');
  tool(other, 'claude');
  tool(nvm, 'grok');

  it('skips an old nvm copy that comes first when the official one exists', () => {
    expect(preferLocalBin('claude', { HOME: home, PATH: `${nvm}:${local}:/usr/bin` })).toBe(path.join(local, 'claude'));
  });

  it('keeps the bare name when the official one already comes first', () => {
    expect(preferLocalBin('claude', { HOME: home, PATH: `${local}:${nvm}` })).toBe('claude');
  });

  it('leaves any other PATH choice alone, such as a fake binary in tests', () => {
    expect(preferLocalBin('claude', { HOME: home, PATH: `${other}:${nvm}:${local}` })).toBe('claude');
  });

  it('keeps the nvm copy when there is no official one', () => {
    expect(preferLocalBin('grok', { HOME: home, PATH: `${nvm}:/usr/bin` })).toBe('grok');
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

describe('unwiredAllProtocols', () => {
  const all = { provider: 'acme', model: 'acme-max', apiKey: 'sk-both', apiType: 'all' as const };

  it('is satisfied when both endpoints are present', () => {
    expect(unwiredAllProtocols({
      ...all, anthropicBaseUrl: 'https://a', openaiBaseUrl: 'https://o',
    })).toEqual([]);
  });

  it('names the half that applyModelEnv will leave on the ambient environment', () => {
    expect(unwiredAllProtocols({ ...all, openaiBaseUrl: 'https://o' })).toEqual(['anthropic']);
    expect(unwiredAllProtocols({ ...all, anthropicBaseUrl: 'https://a' })).toEqual(['openai']);
    expect(unwiredAllProtocols(all)).toEqual(['anthropic', 'openai']);
  });

  it('agrees with what applyModelEnv actually wires up', () => {
    const model = { ...all, openaiBaseUrl: 'https://o' };
    const env = applyModelEnv({}, model, 'anthropic');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(unwiredAllProtocols(model)).toContain('anthropic');
  });

  it('says nothing about single-protocol models — a bare baseUrl is the official API', () => {
    expect(unwiredAllProtocols({ provider: 'anthropic', model: 'm', apiKey: 'k', apiType: 'anthropic' })).toEqual([]);
    expect(unwiredAllProtocols({ provider: 'openai', model: 'm', apiKey: 'k', apiType: 'openai' })).toEqual([]);
  });

  it('says nothing when there is no key to wire up', () => {
    expect(unwiredAllProtocols({ provider: 'acme', model: 'm', apiType: 'all' })).toEqual([]);
    expect(unwiredAllProtocols(undefined)).toEqual([]);
  });
});
