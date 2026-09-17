import { describe, expect, it, vi } from 'vitest';
import type { Chat } from '@codey/core';
import { matchAutomaticChatTask } from './automatic-chat-task';
const chat: Chat = { id: 'chat', title: 'Alice', workspaceName: 'main', selection: { type: 'none' }, createdAt: 1, updatedAt: 1,
  tasks: [{ id: 'site', title: 'Website', createdAt: 1, updatedAt: 1 }, { id: 'icon', title: 'Icon', createdAt: 1, updatedAt: 1 }],
  messages: [{ id: 'm1', role: 'user', taskId: 'site', content: 'Build homepage', timestamp: 1 }, { id: 'm2', role: 'user', taskId: 'icon', content: 'Draw app icon', timestamp: 2 }] };
describe('automatic task matching', () => {
  it('matches older tasks by meaning and supplies task-local excerpts', async () => {
    const classify = vi.fn(async (_prompt: string) => ({ kind: 'existing', taskId: 'site' }));
    expect(await matchAutomaticChatTask(chat, 'Make the homepage blue', undefined, classify)).toEqual({ taskId: 'site' });
    expect(classify.mock.calls[0]?.[0]).toContain('Build homepage');
  });
  it('creates new goals, reuses duplicate titles, and separates general chat', async () => {
    expect(await matchAutomaticChatTask(chat, 'Make a trailer', undefined, async () => ({ kind: 'new', title: 'Trailer' }))).toEqual({ newTitle: 'Trailer' });
    expect(await matchAutomaticChatTask(chat, 'Homepage', undefined, async () => ({ kind: 'new', title: 'website' }))).toEqual({ taskId: 'site' });
    expect(await matchAutomaticChatTask(chat, 'Hello', undefined, async () => ({ kind: 'general' }))).toEqual({});
  });
  it('falls back to the last task on unavailable or invalid classifier output', async () => {
    for (const result of [null, { kind: 'existing', taskId: 'foreign' }, { kind: 'new', title: '' }]) {
      expect(await matchAutomaticChatTask(chat, 'Continue', undefined, async () => result)).toEqual({ taskId: 'icon' });
    }
    expect(await matchAutomaticChatTask(chat, 'Continue', undefined, async () => { throw new Error('timeout'); })).toEqual({ taskId: 'icon' });
    expect(await matchAutomaticChatTask(chat, 'Website changes', undefined)).toEqual({ taskId: 'site' });
  });
  it('preserves explicit replies and retries without calling the classifier', async () => {
    const classify = vi.fn();
    expect(await matchAutomaticChatTask(chat, 'Continue', { replyToMessageId: 'm1' }, classify)).toEqual({ taskId: 'site' });
    expect(await matchAutomaticChatTask(chat, 'Hello', { taskId: null }, classify)).toEqual({ taskId: undefined });
    expect(classify).not.toHaveBeenCalled();
    await expect(matchAutomaticChatTask(chat, 'Continue', { taskId: 'foreign' })).rejects.toThrow('does not belong');
  });
});
