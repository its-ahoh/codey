import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from './config';

function withTempConfig(initial: any, fn: (cm: ConfigManager, p: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-cfg-'));
  const p = path.join(dir, 'gateway.json');
  fs.writeFileSync(p, JSON.stringify(initial));
  const cm = new ConfigManager(p);
  try { fn(cm, p); } finally { cm.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('config normalize', () => {
  it('strips legacy apiKey/baseUrl from existing ModelEntry rows', () => {
    withTempConfig({
      models: [{ model: 'm1', apiType: 'anthropic', apiKey: 'sk-old', baseUrl: 'https://old' }],
    }, cm => {
      const m = cm.listModels()[0];
      expect(m.model).toBe('m1');
      expect((m as any).apiKey).toBeUndefined();
      expect((m as any).baseUrl).toBeUndefined();
    });
  });

  it('parses apiKeys array and preserves valid entries', () => {
    withTempConfig({
      apiKeys: [
        { name: 'main', apiType: 'anthropic', baseUrl: 'https://api', apiKey: 'sk-1' },
        { name: '', apiType: 'anthropic', apiKey: 'sk-bad' },
        { name: 'noKey', apiType: 'openai' },
      ],
    }, cm => {
      const apiKeys = cm.listApiKeys();
      expect(apiKeys).toHaveLength(1);
      expect(apiKeys[0].name).toBe('main');
    });
  });

  it('defaults apiKeys to [] when missing', () => {
    withTempConfig({}, cm => {
      expect(cm.listApiKeys()).toEqual([]);
    });
  });
});

describe('api key CRUD', () => {
  it('saveApiKey rejects missing name or key', () => {
    withTempConfig({}, cm => {
      expect(() => cm.saveApiKey({ name: '', apiType: 'openai', apiKey: 'k' } as any)).toThrow();
      expect(() => cm.saveApiKey({ name: 'x', apiType: 'openai', apiKey: '' } as any)).toThrow();
    });
  });

  it('renameApiKey rewrites apiKeyRef on dependent models', () => {
    withTempConfig({
      apiKeys: [{ name: 'old', apiType: 'anthropic', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiKeyRef: 'old' }],
    }, cm => {
      expect(cm.renameApiKey('old', 'new')).toBe(true);
      expect(cm.listApiKeys()[0].name).toBe('new');
      expect(cm.listModels()[0].apiKeyRef).toBe('new');
    });
  });

  it('deleteApiKey refuses when models still reference it', () => {
    withTempConfig({
      apiKeys: [{ name: 'a', apiType: 'anthropic', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiKeyRef: 'a' }],
    }, cm => {
      expect(() => cm.deleteApiKey('a')).toThrow(/m1/);
    });
  });

  it('deleteApiKey succeeds with no dependents', () => {
    withTempConfig({
      apiKeys: [{ name: 'a', apiType: 'anthropic', apiKey: 'sk' }],
    }, cm => {
      expect(cm.deleteApiKey('a')).toBe(true);
      expect(cm.listApiKeys()).toHaveLength(0);
    });
  });
});
