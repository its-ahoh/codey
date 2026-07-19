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
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  return root;
}

function chatFile(root: string, ws: string, id: string): string {
  return path.join(root, ws, 'chats', `${id}.json`);
}

// Regression for the fallback-banner-as-title bug. Before the fix, a chat
// could be persisted with its title set to the leaked "[Fallback: …]" banner.
// ChatManager must heal such titles on load by re-deriving from the first user
// message, and persist the repair so it survives subsequent loads.
describe('ChatManager fallback-title heal', () => {
  it('re-derives a persisted "[Fallback: …]" title from the first user message', () => {
    const root = tmpRoot();
    const mgr = new ChatManager(root);
    const chat = mgr.create({ workspaceName: 'ws', title: 'placeholder' });
    mgr.appendMessage(chat.id, {
      id: 'u1', role: 'user', content: 'Refactor the auth module to use JWT',
      timestamp: 1, isComplete: true,
    });

    // Simulate the old on-disk contamination.
    const file = chatFile(root, 'ws', chat.id);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    onDisk.title = '[Fallback: claude-code(opus) → opencode(deepseek)]';
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8');

    const healed = new ChatManager(root);
    expect(healed.get(chat.id)?.title).toBe('Refactor the auth module to use JWT');

    // The repair is persisted: a fresh manager also sees the clean title.
    const reloaded = new ChatManager(root);
    expect(reloaded.get(chat.id)?.title).toBe('Refactor the auth module to use JWT');
  });

  it('falls back to "New Chat" when there is no user message to derive from', () => {
    const root = tmpRoot();
    const mgr = new ChatManager(root);
    const chat = mgr.create({ workspaceName: 'ws', title: 'placeholder' });

    const file = chatFile(root, 'ws', chat.id);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    onDisk.title = '[Fallback: claude-code(opus) → codex(gpt-5)]';
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8');

    const healed = new ChatManager(root);
    expect(healed.get(chat.id)?.title).toBe('New Chat');
  });

  it('leaves normal titles untouched', () => {
    const root = tmpRoot();
    const mgr = new ChatManager(root);
    const chat = mgr.create({ workspaceName: 'ws', title: 'Implement billing' });

    const reloaded = new ChatManager(root);
    expect(reloaded.get(chat.id)?.title).toBe('Implement billing');
  });
});
