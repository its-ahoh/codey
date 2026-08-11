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

  it('migrates the former Conversation hotkey default to Shift+Fn', () => {
    withTempConfig({ voice: { converseHotkey: 'Control+Fn' } }, cm => {
      expect(cm.get().voice?.converseHotkey).toBe('Shift+Fn');
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

describe('setAgentDefaultEffort', () => {
  it('sets an effort and persists it to disk', () => {
    withTempConfig({}, (cm, p) => {
      cm.setAgentDefaultEffort('codex', 'high');
      expect(cm.getAgentConfig('codex')?.defaultEffort).toBe('high');
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
      expect(onDisk.agents.codex.defaultEffort).toBe('high');
    });
  });

  it('deletes the key entirely when cleared', () => {
    withTempConfig({ agents: { codex: { defaultEffort: 'max', env: { FOO: 'bar' } } } }, (cm, p) => {
      cm.setAgentDefaultEffort('codex', undefined);
      expect(cm.getAgentConfig('codex')?.defaultEffort).toBeUndefined();
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
      expect('defaultEffort' in onDisk.agents.codex).toBe(false);
      // Unrelated slot fields survive the clear.
      expect(onDisk.agents.codex.env).toEqual({ FOO: 'bar' });
    });
  });

  it('round-trips a set effort through a fresh ConfigManager', () => {
    withTempConfig({}, (cm, p) => {
      cm.setAgentDefaultEffort('claude-code', 'xhigh');
      const reloaded = new ConfigManager(p);
      try {
        expect(reloaded.getAgentConfig('claude-code')?.defaultEffort).toBe('xhigh');
      } finally {
        reloaded.stop();
      }
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

  it('resolves a saved Voice key without duplicating the secret in voice config', () => {
    withTempConfig({
      apiKeys: [{ name: 'voice-main', apiKey: 'sk-voice', openaiBaseUrl: 'https://voice.example/v1', purpose: 'voice' }],
      voice: {
        enabled: true, hotkey: 'Fn', language: 'auto', injection: 'paste', provider: 'api',
        apiUrl: 'https://api.openai.com/v1', apiKeyRef: 'voice-main', apiModel: 'transcribe', localModel: 'local',
        tts: { enabled: true, provider: 'api', apiUrl: 'https://api.openai.com/v1', apiKeyRef: 'voice-main', apiModel: 'tts', voiceId: 'alloy', verbosity: 'auto' },
      },
    }, cm => {
      const resolved = cm.getResolvedVoiceConfig();
      expect(resolved?.apiKey).toBe('sk-voice');
      expect(resolved?.apiUrl).toBe('https://voice.example/v1');
      expect(resolved?.tts?.apiKey).toBe('sk-voice');
      expect(cm.get().voice).not.toHaveProperty('apiKey');
      expect(cm.get().voice?.tts).not.toHaveProperty('apiKey');
    });
  });

  it('allows TTS to use a different saved Voice key from transcription', () => {
    withTempConfig({
      apiKeys: [
        { name: 'transcription', apiKey: 'sk-transcribe', purpose: 'voice' },
        { name: 'speech', apiKey: 'sk-speech', openaiBaseUrl: 'https://speech.example/v1', purpose: 'voice' },
      ],
      voice: {
        enabled: true, hotkey: 'Fn', language: 'auto', injection: 'paste', provider: 'api',
        apiUrl: 'https://api.openai.com/v1', apiKeyRef: 'transcription', apiModel: 'transcribe', localModel: 'local',
        tts: { enabled: true, provider: 'api', apiUrl: 'https://api.openai.com/v1', apiKeyRef: 'speech', apiModel: 'tts', voiceId: 'alloy', verbosity: 'auto' },
      },
    }, cm => {
      const resolved = cm.getResolvedVoiceConfig();
      expect(resolved?.apiKey).toBe('sk-transcribe');
      expect(resolved?.tts?.apiKey).toBe('sk-speech');
      expect(resolved?.tts?.apiUrl).toBe('https://speech.example/v1');
    });
  });

  it('does not inherit the transcription key when TTS has no key selected', () => {
    withTempConfig({
      apiKeys: [{ name: 'transcription', apiKey: 'sk-transcribe', purpose: 'voice' }],
      voice: {
        enabled: true, hotkey: 'Fn', language: 'auto', injection: 'paste', provider: 'api',
        apiUrl: 'https://api.openai.com/v1', apiKeyRef: 'transcription', apiModel: 'transcribe', localModel: 'local',
        tts: { enabled: true, provider: 'api', apiUrl: 'https://api.openai.com/v1', apiModel: 'tts', voiceId: 'alloy', verbosity: 'auto' },
      },
    }, cm => {
      const resolved = cm.getResolvedVoiceConfig();
      expect(resolved?.apiKey).toBe('sk-transcribe');
      expect(resolved?.tts?.apiKey).toBe('');
    });
  });

  it('drops obsolete inline Voice secrets while normalizing config', () => {
    withTempConfig({
      voice: {
        enabled: true, hotkey: 'Fn', language: 'auto', injection: 'paste', provider: 'api',
        apiUrl: 'https://api.openai.com/v1', apiKey: 'old-transcription-key', apiModel: 'transcribe', localModel: 'local',
        tts: { enabled: true, provider: 'api', apiUrl: 'https://api.openai.com/v1', apiKey: 'old-tts-key', apiModel: 'tts', voiceId: 'alloy', verbosity: 'auto' },
      } as any,
    }, cm => {
      expect(cm.get().voice).not.toHaveProperty('apiKey');
      expect(cm.get().voice?.tts).not.toHaveProperty('apiKey');
      expect(cm.getResolvedVoiceConfig()?.apiKey).toBe('');
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

  it('renameApiKey rewrites the selected Voice key reference', () => {
    withTempConfig({
      apiKeys: [{ name: 'old', apiKey: 'sk', purpose: 'voice' }],
      voice: { apiKeyRef: 'old', tts: { apiKeyRef: 'old' } },
    }, cm => {
      expect(cm.renameApiKey('old', 'new')).toBe(true);
      expect(cm.get().voice?.apiKeyRef).toBe('new');
      expect(cm.get().voice?.tts?.apiKeyRef).toBe('new');
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
