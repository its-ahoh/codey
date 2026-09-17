import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';
import { chatTaskContext } from '@codey/core';
import { buildChatBootstrapPrompt, buildChatCatchupPrompt } from './chat-runner';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-task-'));
  roots.push(root);
  const manager = new ChatManager(root);
  const chat = manager.create({ workspaceName: 'main' });
  manager.createTask(chat.id, 'Website');
  manager.createTask(chat.id, 'Icon');
  return { root, manager, chat, a: chat.tasks![0].id, b: chat.tasks![1].id };
}

describe('persistent chat tasks', () => {
  it('survives reload with task messages and independent sessions', () => {
    const { root, manager, chat, a, b } = setup();
    manager.appendMessage(chat.id, { id: 'a1', role: 'user', content: 'Website', timestamp: 1, taskId: a });
    manager.setSessionAnchor(chat.id, { agent: 'codex', sessionId: 'session-a', scopeKey: a });
    manager.setSessionAnchor(chat.id, { agent: 'codex', sessionId: 'session-b', scopeKey: b });
    manager.setSessionAnchor(chat.id, { agent: 'pi', sessionId: 'session-pi', scopeKey: a });
    const reloaded = new ChatManager(root);
    expect(reloaded.get(chat.id)?.messages[0].taskId).toBe(a);
    expect(reloaded.getSessionAnchor(chat.id, 'codex', a)?.sessionId).toBe('session-a');
    expect(reloaded.getSessionAnchor(chat.id, 'codex', b)?.sessionId).toBe('session-b');
    expect(reloaded.getSessionAnchor(chat.id, 'codex')).toBeUndefined();
    reloaded.clearSessionAnchor(chat.id, 'codex', a);
    expect(reloaded.getSessionAnchor(chat.id, 'codex', a)).toBeUndefined();
    expect(reloaded.getSessionAnchor(chat.id, 'codex', b)?.sessionId).toBe('session-b');
    expect(reloaded.getSessionAnchor(chat.id, 'pi', a)?.sessionId).toBe('session-pi');
  });
  it('rejects invalid titles and foreign task messages without mutating history', () => {
    const { manager, chat } = setup();
    expect(() => manager.createTask(chat.id, ' website ')).toThrow('already exists');
    expect(() => manager.createTask(chat.id, ' ')).toThrow();
    expect(() => manager.appendMessage(chat.id, { id: 'x', role: 'user', content: 'x', timestamp: 1, taskId: 'foreign' })).toThrow();
    expect(chat.messages).toHaveLength(0);
  });
  it('bootstraps and catches up using only the selected task', () => {
    const { manager, chat, a, b } = setup();
    for (const [id, taskId, content] of [['a1', a, 'Website first'], ['b1', b, 'ICON SECRET'], ['a2', a, 'Website followup']]) {
      manager.appendMessage(chat.id, { id, taskId, role: 'user', content, timestamp: 1 });
    }
    const scoped = chatTaskContext(chat, a);
    const bootstrap = buildChatBootstrapPrompt(scoped, 'Continue');
    expect(bootstrap).toContain('Website first');
    expect(bootstrap).not.toContain('ICON SECRET');
    const catchup = buildChatCatchupPrompt(scoped, 'a1', 'Continue');
    expect(catchup).toContain('Website followup');
    expect(catchup).not.toContain('ICON SECRET');
  });
  it('compacts each task without including other conversations', async () => {
    const { manager, chat, a, b } = setup();
    manager.setCompactionRunner(async view => {
      expect(view.messages.every(m => m.taskId === a)).toBe(true);
      return { summary: 'Website summary', summarizedUpTo: 40, model: 'test', updatedAt: 1 };
    });
    manager.appendMessage(chat.id, { id: 'b', role: 'user', content: 'Other secret', taskId: b, timestamp: 1 });
    for (let i = 0; i < 80; i++) manager.appendMessage(chat.id, { id: `a${i}`, role: 'user', content: 'Website', taskId: a, timestamp: i });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(chat.tasks![0].compaction?.summary).toBe('Website summary');
    expect(chat.tasks![1].compaction).toBeUndefined();
    expect(chat.compaction).toBeUndefined();
  });
  it('creates task-local transcript files and removes them with the chat', () => {
    const { manager, chat, a, b } = setup();
    manager.appendMessage(chat.id, { id: 'a', role: 'user', content: 'Website only', taskId: a, timestamp: 1 });
    manager.appendMessage(chat.id, { id: 'b', role: 'user', content: 'ICON SECRET', taskId: b, timestamp: 2 });
    const file = manager.taskTranscriptPath(chat.id, a)!;
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Website only');
    expect(content).not.toContain('ICON SECRET');
    expect(() => manager.taskTranscriptPath(chat.id, '../foreign')).toThrow();
    manager.delete(chat.id);
    expect(fs.existsSync(file)).toBe(false);
  });
});
