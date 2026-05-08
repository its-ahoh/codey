// Run: npx ts-node packages/gateway/src/chats.test.ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
  fs.mkdirSync(path.join(root, 'main'), { recursive: true });

  const mgr = new ChatManager(root);
  const chat = mgr.create({ workspaceName: 'main', title: 't' });

  const r = mgr.addRoute(chat.id, {
    channel: 'telegram',
    channelUserId: 'u1',
    channelChatId: 'u1',
    attachedAt: 1,
  });
  assert.strictEqual(r.routes?.length, 1);
  assert.strictEqual(r.routes?.[0].channel, 'telegram');

  mgr.addRoute(chat.id, {
    channel: 'telegram',
    channelUserId: 'u1',
    channelChatId: 'u1',
    attachedAt: 2,
  });
  assert.strictEqual(mgr.get(chat.id)?.routes?.length, 1);

  const found = mgr.findByRoute('telegram', 'u1', 'u1');
  assert.strictEqual(found?.id, chat.id);
  assert.strictEqual(mgr.findByRoute('telegram', 'u1', 'other'), undefined);

  const after = mgr.removeRoute(chat.id, 'telegram', 'u1', 'u1');
  assert.strictEqual(after.routes?.length ?? 0, 0);
  assert.strictEqual(mgr.findByRoute('telegram', 'u1', 'u1'), undefined);

  const r2 = mgr.addRoute(chat.id, {
    channel: 'discord',
    channelUserId: 'd1',
    channelChatId: 'd1',
    attachedAt: 3,
  });
  assert.strictEqual(r2.routes?.length, 1);
  const reloaded = new ChatManager(root);
  assert.strictEqual(reloaded.findByRoute('discord', 'd1', 'd1')?.id, chat.id);

  // pendingTeam round-trip
  const pending = {
    mode: 'sequential' as const,
    teamName: 'review',
    task: 'audit pr',
    memberIndex: 1,
    carry: 'previous output',
    askingWorker: 'reviewer',
    question: 'should I include style nits?',
    askedAt: 1_700_000_000_000,
  };
  mgr.setPendingTeam(chat.id, pending);
  assert.deepStrictEqual(mgr.get(chat.id)?.pendingTeam, pending);

  const reloadedForPending = new ChatManager(root);
  assert.deepStrictEqual(reloadedForPending.get(chat.id)?.pendingTeam, pending);

  mgr.setPendingTeam(chat.id, null);
  assert.strictEqual(mgr.get(chat.id)?.pendingTeam, undefined);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('chats.test ok');
}

run().catch(e => { console.error(e); process.exit(1); });
