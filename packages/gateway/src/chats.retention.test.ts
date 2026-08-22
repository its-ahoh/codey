import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

/**
 * Deleting chats is irreversible, so these cover the boundary in both
 * directions and — more importantly — everything the sweep must NOT touch.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmpManager(): ChatManager {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  return new ChatManager(root);
}

const DAY = 24 * 60 * 60 * 1000;
// Anchored to real time: appendMessage stamps updatedAt with Date.now(), so a
// fabricated "now" in the future would make a just-written message look stale.
const NOW = Date.now();

/** Backdate a chat's last activity, the way real elapsed time would. */
function age(mgr: ChatManager, chatId: string, days: number): void {
  const chat = mgr.get(chatId)!;
  chat.updatedAt = NOW - days * DAY;
  (mgr as any).persist(chat);
}

describe('ChatManager.deleteExpired', () => {
  it('deletes a chat past its retention', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 30 });
    age(mgr, chat.id, 31);

    expect(mgr.deleteExpired(NOW)).toBe(1);
    expect(mgr.get(chat.id)).toBeUndefined();
  });

  it('keeps a chat that is still inside its retention', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 30 });
    age(mgr, chat.id, 29);

    expect(mgr.deleteExpired(NOW)).toBe(0);
    expect(mgr.get(chat.id)).toBeDefined();
  });

  it('keeps a chat exactly at the boundary', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 30 });
    age(mgr, chat.id, 30);

    expect(mgr.deleteExpired(NOW)).toBe(0);
    expect(mgr.get(chat.id)).toBeDefined();
  });

  it('never touches a chat without a retention, however old', () => {
    const mgr = tmpManager();
    // The user's own chats, and sessions from an 'unlimited' token.
    const user = mgr.create({ workspaceName: 'ws' });
    const unlimited = mgr.create({ workspaceName: 'ws', kind: 'api' });
    const automation = mgr.create({ workspaceName: 'ws', kind: 'automation' });
    for (const c of [user, unlimited, automation]) age(mgr, c.id, 3650);

    expect(mgr.deleteExpired(NOW)).toBe(0);
    expect(mgr.get(user.id)).toBeDefined();
    expect(mgr.get(unlimited.id)).toBeDefined();
    expect(mgr.get(automation.id)).toBeDefined();
  });

  it('measures from last activity, not from creation', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 15 });
    age(mgr, chat.id, 100);
    // A fresh turn touches updatedAt and buys another full window.
    mgr.appendMessage(chat.id, { id: 'm1', role: 'user', content: 'still here', timestamp: NOW });

    expect(mgr.deleteExpired(NOW)).toBe(0);
    expect(mgr.get(chat.id)).toBeDefined();
  });

  it('deletes only the lapsed chats out of a mixed set', () => {
    const mgr = tmpManager();
    const stale = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 15 });
    const fresh = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 90 });
    const mine = mgr.create({ workspaceName: 'ws' });
    age(mgr, stale.id, 20);
    age(mgr, fresh.id, 20);
    age(mgr, mine.id, 20);

    expect(mgr.deleteExpired(NOW)).toBe(1);
    expect(mgr.get(stale.id)).toBeUndefined();
    expect(mgr.get(fresh.id)).toBeDefined();
    expect(mgr.get(mine.id)).toBeDefined();
  });

  it('removes the file from disk, not just the cache', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 15 });
    age(mgr, chat.id, 20);
    mgr.deleteExpired(NOW);

    const reopened = new ChatManager((mgr as any).root ?? roots[roots.length - 1]);
    expect(reopened.get(chat.id)).toBeUndefined();
  });

  it('is a no-op when there is nothing to sweep', () => {
    expect(tmpManager().deleteExpired(NOW)).toBe(0);
  });

  it('persists retentionDays so a restart still knows to sweep', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', kind: 'api', retentionDays: 60 });
    expect(mgr.get(chat.id)!.retentionDays).toBe(60);

    const reopened = new ChatManager(roots[roots.length - 1]);
    expect(reopened.get(chat.id)!.retentionDays).toBe(60);
  });
});
