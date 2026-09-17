import { describe, expect, it } from 'vitest';
import type { Chat } from './types/chat';
import { chatSessionScope, chatTaskContext, resolveChatTask } from './chat-tasks';

const chat: Chat = {
  id: 'chat', title: 'Alice', workspaceName: 'main', selection: { type: 'worker', name: 'alice' },
  createdAt: 1, updatedAt: 1,
  tasks: [
    { id: 'website', title: 'Website', createdAt: 1, updatedAt: 1 },
    { id: 'icon', title: 'App icon', createdAt: 1, updatedAt: 1 },
  ],
  messages: [
    { id: 'general', role: 'user', content: 'General secret', timestamp: 1 },
    { id: 'w1', role: 'user', content: 'Website secret', timestamp: 2, taskId: 'website' },
    { id: 'i1', role: 'assistant', content: 'Icon secret', timestamp: 3, taskId: 'icon' },
  ],
  compaction: { summary: 'General summary', summarizedUpTo: 1, model: 'test', updatedAt: 1 },
};

describe('task routing', () => {
  it('prioritizes a replied-to message over a selected task', () => {
    expect(resolveChatTask(chat, 'Change it', { replyToMessageId: 'w1', taskId: 'icon' }))
      .toEqual({ kind: 'resolved', taskId: 'website' });
  });
  it('honors general conversation and explicit destinations', () => {
    expect(resolveChatTask(chat, 'Website', { taskId: null })).toEqual({ kind: 'resolved' });
    expect(resolveChatTask(chat, 'Website', { taskId: 'icon' })).toEqual({ kind: 'resolved', taskId: 'icon' });
  });
  it('matches a task name but does not guess vague requests', () => {
    expect(resolveChatTask(chat, 'Update the website')).toEqual({ kind: 'resolved', taskId: 'website' });
    expect(resolveChatTask(chat, 'Make it blue').kind).toBe('ambiguous');
    expect(resolveChatTask(chat, 'Website and App icon').kind).toBe('ambiguous');
  });
  it('rejects foreign tasks and missing replies', () => {
    expect(resolveChatTask(chat, 'Go', { taskId: 'foreign' }).kind).toBe('invalid');
    expect(resolveChatTask(chat, 'Go', { replyToMessageId: 'missing' }).kind).toBe('invalid');
  });
  it('keeps legacy chats in general conversation', () => {
    expect(resolveChatTask({ ...chat, tasks: undefined }, 'Hello')).toEqual({ kind: 'resolved' });
  });
  it('does not match task names inside unrelated words', () => {
    const short = { ...chat, tasks: [{ id: 'art', title: 'Art', createdAt: 1, updatedAt: 1 }] };
    expect(resolveChatTask(short, 'Start over').kind).toBe('ambiguous');
    expect(resolveChatTask(short, 'Review Art.')).toEqual({ kind: 'resolved', taskId: 'art' });
  });
});

describe('context boundaries', () => {
  it('keeps task history separate from other tasks and general summaries', () => {
    const view = chatTaskContext(chat, 'website');
    expect(view.messages.map(m => m.id)).toEqual(['w1']);
    expect(view.compaction).toBeUndefined();
    expect(chatTaskContext(chat).messages.map(m => m.id)).toEqual(['general']);
    expect(chat.messages).toHaveLength(3);
  });
  it('separates task, Bot, profile and directory session identities', () => {
    const original = chatSessionScope(chat, 'website', '/a', { role: 'designer' });
    expect(chatSessionScope(chat, 'website', '/a', { role: 'designer' })).toBe(original);
    for (const scope of [
      chatSessionScope(chat, 'icon', '/a', { role: 'designer' }),
      chatSessionScope(chat, 'website', '/b', { role: 'designer' }),
      chatSessionScope(chat, 'website', '/a', { role: 'engineer' }),
      chatSessionScope({ ...chat, selection: { type: 'worker', name: 'ben' } }, 'website', '/a', { role: 'designer' }),
    ]) expect(scope).not.toBe(original);
  });
});
