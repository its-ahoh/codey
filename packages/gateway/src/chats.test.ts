// Route + pendingTeam persistence. Other ChatManager behaviour lives in the
// sibling chats.*.test.ts files.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'main'), { recursive: true });
  return root;
}

const route = (over: Partial<{ channel: string; channelUserId: string; channelChatId: string; attachedAt: number }> = {}) => ({
  channel: 'telegram',
  channelUserId: 'u1',
  channelChatId: 'c1',
  attachedAt: 1,
  ...over,
}) as Parameters<ChatManager['addRoute']>[1];

describe('ChatManager routes', () => {
  it('attaches a route to a chat', () => {
    const mgr = new ChatManager(tmpRoot());
    const chat = mgr.create({ workspaceName: 'main', title: 't' });

    const updated = mgr.addRoute(chat.id, route());

    expect(updated.routes).toHaveLength(1);
    expect(updated.routes?.[0].channel).toBe('telegram');
    expect(updated.routes?.[0].channelChatId).toBe('c1');
  });

  it('does not duplicate the same channel user', () => {
    const mgr = new ChatManager(tmpRoot());
    const chat = mgr.create({ workspaceName: 'main', title: 't' });

    mgr.addRoute(chat.id, route());
    mgr.addRoute(chat.id, route({ attachedAt: 2 }));

    expect(mgr.get(chat.id)?.routes).toHaveLength(1);
  });

  it('looks a chat up by route and misses on an unknown user', () => {
    const mgr = new ChatManager(tmpRoot());
    const chat = mgr.create({ workspaceName: 'main', title: 't' });
    mgr.addRoute(chat.id, route());

    expect(mgr.findByRoute('telegram', 'u1')?.id).toBe(chat.id);
    expect(mgr.findByRoute('telegram', 'other')).toBeUndefined();
  });

  it('removes a route and stops resolving it', () => {
    const mgr = new ChatManager(tmpRoot());
    const chat = mgr.create({ workspaceName: 'main', title: 't' });
    mgr.addRoute(chat.id, route());

    const after = mgr.removeRoute(chat.id, 'telegram', 'u1');

    expect(after.routes ?? []).toHaveLength(0);
    expect(mgr.findByRoute('telegram', 'u1')).toBeUndefined();
  });

  it('persists routes across a reload', () => {
    const root = tmpRoot();
    const mgr = new ChatManager(root);
    const chat = mgr.create({ workspaceName: 'main', title: 't' });
    mgr.addRoute(chat.id, route({ channel: 'discord', channelUserId: 'd1', channelChatId: 'dc1', attachedAt: 3 }));

    expect(new ChatManager(root).findByRoute('discord', 'd1')?.id).toBe(chat.id);
  });
});

describe('ChatManager pendingTeam', () => {
  const pending = {
    mode: 'sequential' as const,
    teamName: 'review',
    task: 'audit pr',
    teamTurnId: 'test-turn-id',
    memberIndex: 1,
    carry: 'previous output',
    askingWorker: 'reviewer',
    question: 'should I include style nits?',
    askedAt: 1_700_000_000_000,
  };

  it('round-trips pause state through disk', () => {
    const root = tmpRoot();
    const mgr = new ChatManager(root);
    const chat = mgr.create({ workspaceName: 'main', title: 't' });

    mgr.setPendingTeam(chat.id, pending);

    expect(mgr.get(chat.id)?.pendingTeam).toEqual(pending);
    expect(new ChatManager(root).get(chat.id)?.pendingTeam).toEqual(pending);
  });

  it('clears pause state when set to null', () => {
    const mgr = new ChatManager(tmpRoot());
    const chat = mgr.create({ workspaceName: 'main', title: 't' });
    mgr.setPendingTeam(chat.id, pending);

    mgr.setPendingTeam(chat.id, null);

    expect(mgr.get(chat.id)?.pendingTeam).toBeUndefined();
  });
});
