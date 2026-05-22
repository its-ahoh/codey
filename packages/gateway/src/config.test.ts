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

  it('parses apis array and preserves valid entries', () => {
    withTempConfig({
      apis: [
        { name: 'main', apiType: 'anthropic', baseUrl: 'https://api', apiKey: 'sk-1' },
        { name: '', apiType: 'anthropic', apiKey: 'sk-bad' },
        { name: 'noKey', apiType: 'openai' },
      ],
    }, cm => {
      const apis = cm.listApis();
      expect(apis).toHaveLength(1);
      expect(apis[0].name).toBe('main');
    });
  });

  it('defaults apis to [] when missing', () => {
    withTempConfig({}, cm => {
      expect(cm.listApis()).toEqual([]);
    });
  });
});

describe('api CRUD', () => {
  it('saveApi rejects missing name or key', () => {
    withTempConfig({}, cm => {
      expect(() => cm.saveApi({ name: '', apiType: 'openai', apiKey: 'k' } as any)).toThrow();
      expect(() => cm.saveApi({ name: 'x', apiType: 'openai', apiKey: '' } as any)).toThrow();
    });
  });

  it('renameApi rewrites apiRef on dependent models', () => {
    withTempConfig({
      apis: [{ name: 'old', apiType: 'anthropic', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiRef: 'old' }],
    }, cm => {
      expect(cm.renameApi('old', 'new')).toBe(true);
      expect(cm.listApis()[0].name).toBe('new');
      expect(cm.listModels()[0].apiRef).toBe('new');
    });
  });

  it('deleteApi refuses when models still reference it', () => {
    withTempConfig({
      apis: [{ name: 'a', apiType: 'anthropic', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiRef: 'a' }],
    }, cm => {
      expect(() => cm.deleteApi('a')).toThrow(/m1/);
    });
  });

  it('deleteApi succeeds with no dependents', () => {
    withTempConfig({
      apis: [{ name: 'a', apiType: 'anthropic', apiKey: 'sk' }],
    }, cm => {
      expect(cm.deleteApi('a')).toBe(true);
      expect(cm.listApis()).toHaveLength(0);
    });
  });
});
