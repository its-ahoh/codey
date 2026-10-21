import { describe, expect, it } from 'vitest';
import type { Chat } from '@codey/core';
import { chatTaskForMessage } from './automatic-chat-task';
const chat: Chat = { id: 'chat', title: 'Alice', workspaceName: 'main', selection: { type: 'none' }, createdAt: 1, updatedAt: 1,
  tasks: [{ id: 'site', title: 'Website', createdAt: 1, updatedAt: 1 }, { id: 'icon', title: 'Icon', createdAt: 1, updatedAt: 1 }],
  messages: [{ id: 'm1', role: 'user', taskId: 'site', content: 'Build homepage', timestamp: 1 }, { id: 'm2', role: 'user', taskId: 'icon', content: 'Draw app icon', timestamp: 2 }] };
describe('chat task for a message', () => {
  it('never opens a new task, so a fresh chat keeps one continuous context', () => {
    const fresh: Chat = { ...chat, tasks: undefined, messages: [{ id: 'g1', role: 'user', content: 'Why does it repeat?', timestamp: 1 }] };
    expect(chatTaskForMessage(fresh, 'Add a check for that case', undefined)).toBeUndefined();
  });
  it('continues the last task instead of guessing from wording', () => {
    expect(chatTaskForMessage(chat, 'Website changes', undefined)).toBe('icon');
    expect(chatTaskForMessage({ ...chat, messages: [...chat.messages, { id: 'm3', role: 'user', taskId: 'gone', content: 'x', timestamp: 3 }] }, 'Continue', undefined)).toBeUndefined();
  });
  it('preserves explicit replies and retries', () => {
    expect(chatTaskForMessage(chat, 'Continue', { replyToMessageId: 'm1' })).toBe('site');
    expect(chatTaskForMessage(chat, 'Hello', { taskId: null })).toBeUndefined();
    expect(() => chatTaskForMessage(chat, 'Continue', { taskId: 'foreign' })).toThrow('does not belong');
  });
});
