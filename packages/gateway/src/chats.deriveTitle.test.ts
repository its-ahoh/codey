import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-deriveTitle-'));
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  return root;
}

function appendFirst(mgr: ChatManager, content: string) {
  const chat = mgr.create({ workspaceName: 'ws', title: 'placeholder' });
  mgr.appendMessage(chat.id, {
    id: 'u1', role: 'user', content,
    timestamp: 1, isComplete: true,
  });
  return mgr.get(chat.id)!;
}

describe('deriveTitle — empty/whitespace input', () => {
  it('returns "New Chat" for empty string', () => {
    const chat = appendFirst(new ChatManager(tmpRoot()), '');
    expect(chat.title).toBe('New Chat');
  });

  it('returns "New Chat" for whitespace-only string', () => {
    const chat = appendFirst(new ChatManager(tmpRoot()), '   ');
    expect(chat.title).toBe('New Chat');
  });

  it('returns "New Chat" for newline/tab whitespace', () => {
    const chat = appendFirst(new ChatManager(tmpRoot()), '\n\t');
    expect(chat.title).toBe('New Chat');
  });

  it('still derives normally for non-empty content', () => {
    const chat = appendFirst(new ChatManager(tmpRoot()), 'Fix the login bug');
    expect(chat.title).toBe('Fix the login bug');
  });
});
