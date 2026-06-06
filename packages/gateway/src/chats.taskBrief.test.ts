import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';
import type { TaskBrief } from '@codey/core';

function tmpManager(): { mgr: ChatManager; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  return { mgr: new ChatManager(root), root };
}

const brief: TaskBrief = {
  goal: 'g', state: { progress: 10, status: 'working' }, timeline: [], generatedAt: 999,
};

describe('ChatManager.setTaskBrief', () => {
  it('stores the brief without bumping updatedAt', () => {
    const { mgr } = tmpManager();
    const chat = mgr.create({ workspaceName: 'ws', title: 't' });
    const before = mgr.get(chat.id)!.updatedAt;
    mgr.setTaskBrief(chat.id, brief);
    const after = mgr.get(chat.id)!;
    expect(after.taskBrief).toEqual(brief);
    expect(after.updatedAt).toBe(before);
  });

  it('is a no-op for an unknown chat', () => {
    const { mgr } = tmpManager();
    expect(() => mgr.setTaskBrief('nope', brief)).not.toThrow();
  });
});
