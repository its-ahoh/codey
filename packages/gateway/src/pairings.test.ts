import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PairingStore } from './pairings';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-pair-'));
  dirs.push(dir);
  return path.join(dir, 'pairings.json');
}

describe('PairingStore', () => {
  it('issues a 6-digit code that is not bound until completed', () => {
    const store = new PairingStore(storeFile());
    const code = store.startPairing({ channel: 'telegram' });
    expect(code).toMatch(/^\d{6}$/);
    expect(store.findByChannelUser('telegram', 'u1')).toBeUndefined();
  });

  it('binds the channel user on completion', () => {
    const store = new PairingStore(storeFile());
    const code = store.startPairing({ channel: 'telegram' });

    expect(store.completePairing(code, { channel: 'telegram', channelUserId: 'u1', channelChatId: 'c1' })).toBe(true);

    const binding = store.findByChannelUser('telegram', 'u1');
    expect(binding?.channelUserId).toBe('u1');
    expect(binding?.channelChatId).toBe('c1');
  });

  it('refuses to redeem the same code twice', () => {
    const store = new PairingStore(storeFile());
    const code = store.startPairing({ channel: 'telegram' });
    store.completePairing(code, { channel: 'telegram', channelUserId: 'u1', channelChatId: 'c1' });

    expect(store.completePairing(code, { channel: 'telegram', channelUserId: 'u2', channelChatId: 'c2' })).toBe(false);
  });

  it('persists prefs to disk so a fresh store sees them', () => {
    const file = storeFile();
    const store = new PairingStore(file);
    const code = store.startPairing({ channel: 'telegram' });
    store.completePairing(code, { channel: 'telegram', channelUserId: 'u1', channelChatId: 'c1' });
    store.updatePrefs('telegram', 'u1', { workspace: 'main', agent: 'claude-code', model: 'sonnet-4-6' });

    const reloaded = new PairingStore(file);
    const binding = reloaded.findByChannelUser('telegram', 'u1');
    expect(binding?.prefs?.workspace).toBe('main');
    expect(binding?.prefs?.agent).toBe('claude-code');
  });

  it('lists only completed pairings for the requested channel', () => {
    const file = storeFile();
    const store = new PairingStore(file);
    store.completePairing(store.startPairing({ channel: 'telegram' }), {
      channel: 'telegram', channelUserId: 'u1', channelChatId: 'c1',
    });
    // A started-but-never-completed code, plus a binding on another channel.
    store.startPairing({ channel: 'telegram' });
    store.completePairing(store.startPairing({ channel: 'discord' }), {
      channel: 'discord', channelUserId: 'd1', channelChatId: 'dc1',
    });

    expect(new PairingStore(file).listForChannel('telegram')).toHaveLength(1);
  });

  it('rejects an expired code', async () => {
    const store = new PairingStore(storeFile());
    const code = store.startPairing({ channel: 'telegram', ttlMs: 0 });
    await new Promise(r => setTimeout(r, 5));

    expect(store.completePairing(code, { channel: 'telegram', channelUserId: 'u3', channelChatId: 'c3' })).toBe(false);
  });
});
