import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Chat, DiscussionMeta } from '@codey/core';
import { ChatManager } from './chats';

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('Chat.discussion metadata', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('roundtrips through persistence', () => {
    const root = tmpRoot('codey-chats-discussion-');
    fs.mkdirSync(path.join(root, 'main'), { recursive: true });

    const mgr = new ChatManager(root);
    const chat = mgr.create({ workspaceName: 'main', title: 'roundtable' });

    const discussion: DiscussionMeta = {
      teamName: 'reviewers',
      status: 'running',
      startedAt: 1_700_000_000_000,
    };

    // ChatManager exposes no public mutator for `discussion` yet; write the
    // field directly via the on-disk JSON and reload to assert the type
    // survives the persistence round-trip.
    const chatFile = path.join(root, 'main', 'chats', `${chat.id}.json`);
    const raw = JSON.parse(fs.readFileSync(chatFile, 'utf8')) as Chat;
    raw.discussion = discussion;
    fs.writeFileSync(chatFile, JSON.stringify(raw, null, 2), 'utf8');

    const reloaded = new ChatManager(root);
    const got = reloaded.get(chat.id);
    expect(got?.discussion).toEqual(discussion);

    // Terminated state with reason also roundtrips.
    const terminated: DiscussionMeta = {
      teamName: 'reviewers',
      status: 'terminated',
      startedAt: 1_700_000_000_000,
      terminatedReason: 'consensus',
    };
    raw.discussion = terminated;
    fs.writeFileSync(chatFile, JSON.stringify(raw, null, 2), 'utf8');
    const reloaded2 = new ChatManager(root);
    expect(reloaded2.get(chat.id)?.discussion).toEqual(terminated);
  });

  it('deletes the discussion directory when the chat is deleted', () => {
    const root = tmpRoot('codey-chats-del-');
    fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
    const mgr = new ChatManager(root);
    const chat = mgr.create({ workspaceName: 'demo', title: 't' });
    const discDir = path.join(root, 'demo', 'chats', chat.id, 'discussion');
    fs.mkdirSync(discDir, { recursive: true });
    fs.writeFileSync(path.join(discDir, 'topic.md'), 'x');
    mgr.delete(chat.id);
    expect(fs.existsSync(discDir)).toBe(false);
  });
});
