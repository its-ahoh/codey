import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecretStore, apiKeySecret, channelSecret } from './secret-store';
import { ConfigManager, stripSecrets } from './config';

describe('SecretStore', () => {
  let dir: string;
  let file: string;
  let store: SecretStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-secrets-'));
    file = path.join(dir, 'secrets.json');
    store = new SecretStore(file);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips a value', () => {
    store.set(apiKeySecret('anthropic'), 'sk-abc');
    expect(store.get(apiKeySecret('anthropic'))).toBe('sk-abc');
    expect(new SecretStore(file).get(apiKeySecret('anthropic'))).toBe('sk-abc');
  });

  it('creates the file at 0600', () => {
    store.set(apiKeySecret('a'), 'v');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions widened behind its back', () => {
    store.set(apiKeySecret('a'), 'v');
    fs.chmodSync(file, 0o644);
    expect(new SecretStore(file).get(apiKeySecret('a'))).toBe('v');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('namespaces api keys apart from channel tokens', () => {
    store.set(apiKeySecret('telegram'), 'a-key');
    store.set(channelSecret('telegram'), 'a-bot-token');
    expect(store.get(apiKeySecret('telegram'))).toBe('a-key');
    expect(store.get(channelSecret('telegram'))).toBe('a-bot-token');
  });

  it('treats an empty value as a delete', () => {
    store.set(apiKeySecret('a'), 'v');
    store.set(apiKeySecret('a'), '');
    expect(store.get(apiKeySecret('a'))).toBeUndefined();
  });

  it('renames without losing the value', () => {
    store.set(apiKeySecret('old'), 'v');
    store.rename(apiKeySecret('old'), apiKeySecret('new'));
    expect(store.get(apiKeySecret('old'))).toBeUndefined();
    expect(store.get(apiKeySecret('new'))).toBe('v');
  });

  it('deletes', () => {
    store.set(apiKeySecret('a'), 'v');
    expect(store.delete(apiKeySecret('a'))).toBe(true);
    expect(store.delete(apiKeySecret('a'))).toBe(false);
  });

  it('survives a corrupt file', () => {
    fs.writeFileSync(file, 'garbage');
    const reopened = new SecretStore(file);
    expect(reopened.keys()).toEqual([]);
    reopened.set(apiKeySecret('a'), 'v');
    expect(reopened.get(apiKeySecret('a'))).toBe('v');
  });
});

describe('ConfigManager secret handling', () => {
  let dir: string;
  let configPath: string;
  let secretPath: string;
  const managers: ConfigManager[] = [];

  const withConfig = (json: unknown): ConfigManager => {
    fs.writeFileSync(configPath, JSON.stringify(json, null, 2));
    const m = new ConfigManager(configPath, new SecretStore(secretPath));
    managers.push(m);
    return m;
  };

  const onDisk = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-cfg-'));
    configPath = path.join(dir, 'gateway.json');
    secretPath = path.join(dir, 'secrets.json');
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates inline secrets out of gateway.json on first load', () => {
    const mgr = withConfig({
      gateway: { port: 3000 },
      channels: { telegram: { enabled: true, botToken: 'bot-123' } },
      apiKeys: [{ name: 'anthropic', apiKey: 'sk-inline' }],
    });

    // Still usable in memory — nothing downstream has to change.
    expect(mgr.getApiKey('anthropic')?.apiKey).toBe('sk-inline');
    expect(mgr.get().channels.telegram?.botToken).toBe('bot-123');

    // Gone from the config file.
    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).not.toContain('sk-inline');
    expect(raw).not.toContain('bot-123');
    expect(onDisk().apiKeys[0].name).toBe('anthropic');

    // Present in the 0600 store.
    const secrets = new SecretStore(secretPath);
    expect(secrets.get(apiKeySecret('anthropic'))).toBe('sk-inline');
    expect(secrets.get(channelSecret('telegram'))).toBe('bot-123');
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
  });

  it('survives a restart: the secret comes back from the store', () => {
    withConfig({
      gateway: { port: 3000 },
      apiKeys: [{ name: 'anthropic', apiKey: 'sk-inline' }],
    });

    const restarted = new ConfigManager(configPath, new SecretStore(secretPath));
    managers.push(restarted);
    expect(restarted.getApiKey('anthropic')?.apiKey).toBe('sk-inline');
  });

  it('keeps a newly saved key out of the config file', () => {
    const mgr = withConfig({ gateway: { port: 3000 }, apiKeys: [] });
    mgr.saveApiKey({ name: 'openai', apiKey: 'sk-fresh' });

    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('sk-fresh');
    expect(mgr.getApiKey('openai')?.apiKey).toBe('sk-fresh');
    expect(new SecretStore(secretPath).get(apiKeySecret('openai'))).toBe('sk-fresh');
  });

  it('moves the secret when an entry is renamed', () => {
    const mgr = withConfig({ gateway: { port: 3000 }, apiKeys: [{ name: 'old', apiKey: 'sk-1' }] });
    mgr.renameApiKey('old', 'new');

    expect(mgr.getApiKey('new')?.apiKey).toBe('sk-1');
    const secrets = new SecretStore(secretPath);
    expect(secrets.get(apiKeySecret('new'))).toBe('sk-1');
    expect(secrets.get(apiKeySecret('old'))).toBeUndefined();
  });

  it('drops the secret when an entry is deleted', () => {
    const mgr = withConfig({ gateway: { port: 3000 }, apiKeys: [{ name: 'gone', apiKey: 'sk-1' }] });
    mgr.deleteApiKey('gone');
    expect(new SecretStore(secretPath).get(apiKeySecret('gone'))).toBeUndefined();
  });

  it('resolves voice config through the store', () => {
    const mgr = withConfig({
      gateway: { port: 3000 },
      apiKeys: [{ name: 'voice-key', apiKey: 'sk-voice', purpose: 'voice' }],
      voice: {
        enabled: true, hotkey: 'F5', language: 'en', injection: 'paste',
        provider: 'api', apiUrl: 'https://x', apiModel: 'whisper-1',
        localModel: 'l', apiKeyRef: 'voice-key',
      },
    });
    expect(mgr.getResolvedVoiceConfig()?.apiKey).toBe('sk-voice');
  });

  it('does not invent a secret for an entry that has none', () => {
    const mgr = withConfig({ gateway: { port: 3000 }, apiKeys: [{ name: 'empty', apiKey: '' }] });
    expect(mgr.getApiKey('empty')?.apiKey).toBe('');
  });

  it('stripSecrets blanks values but keeps the entries visible', () => {
    const stripped = stripSecrets({
      gateway: { port: 3000 },
      channels: { telegram: { enabled: true, botToken: 'bot' }, discord: { enabled: false, botToken: 'd' } },
      agents: {}, models: [], fallback: { enabled: true, order: [] }, dev: { logLevel: 'info' },
      apiKeys: [{ name: 'a', apiKey: 'sk-1', openaiBaseUrl: 'https://x' }],
    });
    expect(stripped.apiKeys[0]).toEqual({ name: 'a', apiKey: '', openaiBaseUrl: 'https://x' });
    expect(stripped.channels.telegram?.botToken).toBe('');
    expect(stripped.channels.telegram?.enabled).toBe(true);
    expect(stripped.channels.discord?.botToken).toBe('');
  });
});
