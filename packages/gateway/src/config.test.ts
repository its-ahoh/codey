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
        { name: 'main', apiKey: 'sk-1', anthropicBaseUrl: 'https://anthropic.example', openaiBaseUrl: 'https://openai.example' },
        { name: '', apiKey: 'sk-bad' },
        { name: 'noKey' },
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

  it('getSkillsConfig returns hardcoded defaults when skills block is absent', () => {
    withTempConfig({}, cm => {
      const cfg = cm.getSkillsConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.suggestOnRepeat).toBe(2);
      expect(cfg.autoApply).toBe(true);
      expect(cfg.staleDays).toBe(30);
      expect(cfg.weakSkillDays).toBe(7);
      expect(cfg.distillModel).toBeUndefined();
    });
  });

  it('getSkillsConfig round-trips explicit values from gateway.json', () => {
    withTempConfig({
      skills: { enabled: false, suggestOnRepeat: 5, autoApply: false, staleDays: 14, weakSkillDays: 3, distillModel: 'claude-haiku-3' },
    }, cm => {
      const cfg = cm.getSkillsConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.suggestOnRepeat).toBe(5);
      expect(cfg.autoApply).toBe(false);
      expect(cfg.staleDays).toBe(14);
      expect(cfg.weakSkillDays).toBe(3);
      expect(cfg.distillModel).toBe('claude-haiku-3');
    });
  });
});

describe('api key CRUD', () => {
  it('saveApiKey rejects missing name or key', () => {
    withTempConfig({}, cm => {
      expect(() => cm.saveApiKey({ name: '', apiKey: 'k' })).toThrow();
      expect(() => cm.saveApiKey({ name: 'x', apiKey: '' })).toThrow();
    });
  });

  it('saveApiKey round-trips both base URLs', () => {
    withTempConfig({}, cm => {
      cm.saveApiKey({
        name: 'proxy',
        apiKey: 'sk-proxy',
        anthropicBaseUrl: 'https://proxy.example/anthropic',
        openaiBaseUrl: 'https://proxy.example/openai',
      });
      const saved = cm.getApiKey('proxy');
      expect(saved?.anthropicBaseUrl).toBe('https://proxy.example/anthropic');
      expect(saved?.openaiBaseUrl).toBe('https://proxy.example/openai');
    });
  });

  it('renameApiKey rewrites apiKeyRef on dependent models', () => {
    withTempConfig({
      apiKeys: [{ name: 'old', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiKeyRef: 'old' }],
    }, cm => {
      expect(cm.renameApiKey('old', 'new')).toBe(true);
      expect(cm.listApiKeys()[0].name).toBe('new');
      expect(cm.listModels()[0].apiKeyRef).toBe('new');
    });
  });

  it('deleteApiKey refuses when models still reference it', () => {
    withTempConfig({
      apiKeys: [{ name: 'a', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiKeyRef: 'a' }],
    }, cm => {
      expect(() => cm.deleteApiKey('a')).toThrow(/m1/);
    });
  });

  it('deleteApiKey succeeds with no dependents', () => {
    withTempConfig({
      apiKeys: [{ name: 'a', apiKey: 'sk' }],
    }, cm => {
      expect(cm.deleteApiKey('a')).toBe(true);
      expect(cm.listApiKeys()).toHaveLength(0);
    });
  });
});
