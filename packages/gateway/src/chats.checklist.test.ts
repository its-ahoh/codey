import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';
import type { ChecklistItem } from '@codey/core';

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

const items: ChecklistItem[] = [
  { text: 'a', status: 'completed' },
  { text: 'b', status: 'in_progress', activeForm: 'Doing b' },
];

describe('ChatManager.setChecklist', () => {
  it('stores the list so a client adopting the run mid-flight can show it', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', title: 't' });
    mgr.setChecklist(chat.id, items);
    expect(mgr.get(chat.id)!.checklist).toEqual(items);
  });

  it('does not bump updatedAt, which orders the chat list by real activity', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', title: 't' });
    const before = mgr.get(chat.id)!.updatedAt;
    mgr.setChecklist(chat.id, items);
    expect(mgr.get(chat.id)!.updatedAt).toBe(before);
  });

  it('replaces the previous list wholesale rather than merging', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', title: 't' });
    mgr.setChecklist(chat.id, items);
    mgr.setChecklist(chat.id, [{ text: 'only', status: 'pending' }]);
    expect(mgr.get(chat.id)!.checklist).toEqual([{ text: 'only', status: 'pending' }]);
  });

  it('clears the list, so a new turn does not inherit the last one', () => {
    const mgr = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', title: 't' });
    mgr.setChecklist(chat.id, items);
    mgr.clearChecklist(chat.id);
    expect(mgr.get(chat.id)!.checklist).toBeUndefined();
  });

  it('is a no-op for an unknown chat', () => {
    const mgr = tmpManager();
    expect(() => mgr.setChecklist('nope', items)).not.toThrow();
    expect(() => mgr.clearChecklist('nope')).not.toThrow();
  });
});
