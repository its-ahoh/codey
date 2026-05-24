import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Chat, DiscussionMeta } from '@codey/core';
import { ChatManager } from './chats';

describe('Chat.discussion metadata', () => {
  it('roundtrips through persistence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-discussion-'));
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

    fs.rmSync(root, { recursive: true, force: true });
  });
});
