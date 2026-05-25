// Run: npx ts-node packages/gateway/src/pairings.test.ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PairingStore } from './pairings';

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-pair-'));
  const file = path.join(dir, 'pairings.json');
  const store = new PairingStore(file);

  const code = store.startPairing({ channel: 'telegram' });
  assert.match(code, /^\d{6}$/);
  assert.strictEqual(store.findByChannelUser('telegram', 'u1'), undefined);

  const ok = store.completePairing(code, { channel: 'telegram', channelUserId: 'u1', channelChatId: 'c1' });
  assert.strictEqual(ok, true);
  const binding = store.findByChannelUser('telegram', 'u1');
  assert.ok(binding);
  assert.strictEqual(binding!.channelUserId, 'u1');
  assert.strictEqual(binding!.channelChatId, 'c1');

  const second = store.completePairing(code, { channel: 'telegram', channelUserId: 'u2', channelChatId: 'c2' });
  assert.strictEqual(second, false);

  store.updatePrefs('telegram', 'u1', { workspace: 'main', agent: 'claude-code', model: 'sonnet-4-6' });
  const reloaded = new PairingStore(file);
  const b2 = reloaded.findByChannelUser('telegram', 'u1');
  assert.strictEqual(b2?.prefs?.workspace, 'main');
  assert.strictEqual(b2?.prefs?.agent, 'claude-code');

  store.startPairing({ channel: 'telegram' });
  store.completePairing(store.startPairing({ channel: 'discord' }), { channel: 'discord', channelUserId: 'd1', channelChatId: 'dc1' });
  const tg = reloaded.listForChannel('telegram');
  assert.strictEqual(tg.length, 1);

  const c2 = store.startPairing({ channel: 'telegram', ttlMs: 0 });
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(store.completePairing(c2, { channel: 'telegram', channelUserId: 'u3', channelChatId: 'c3' }), false);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('pairings.test ok');
}

run().catch(e => { console.error(e); process.exit(1); });
