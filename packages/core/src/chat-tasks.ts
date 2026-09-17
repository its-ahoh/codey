import type { Chat, ChatTaskRoute } from './types/chat';

export type TaskResolution =
  | { kind: 'resolved'; taskId?: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'invalid'; message: string };

/** Conservative, deterministic routing. No guessed semantic task boundaries. */
export function resolveChatTask(chat: Chat, text: string, route: ChatTaskRoute = {}): TaskResolution {
  if (route.replyToMessageId) {
    const message = chat.messages.find(m => m.id === route.replyToMessageId);
    if (!message) return { kind: 'invalid', message: 'The replied-to message no longer exists.' };
    if (message.taskId && !chat.tasks?.some(t => t.id === message.taskId)) {
      return { kind: 'invalid', message: 'The replied-to task no longer exists.' };
    }
    return { kind: 'resolved', taskId: message.taskId };
  }
  if (route.taskId !== undefined) {
    if (route.taskId === null) return { kind: 'resolved' };
    return chat.tasks?.some(t => t.id === route.taskId)
      ? { kind: 'resolved', taskId: route.taskId }
      : { kind: 'invalid', message: 'This task does not belong to this chat.' };
  }
  const tasks = chat.tasks ?? [];
  if (!tasks.length) return { kind: 'resolved' };
  const mentioned = tasks.filter(t => {
    const escaped = t.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = /^[a-z0-9]/i.test(t.title) ? '(?:^|[^\\p{L}\\p{N}_])' : '';
    const after = /[a-z0-9]$/i.test(t.title) ? '(?:$|[^\\p{L}\\p{N}_])' : '';
    return new RegExp(before + escaped + after, 'iu').test(text);
  });
  if (mentioned.length === 1) return { kind: 'resolved', taskId: mentioned[0].id };
  // General conversation remains distinct. The gateway resolves ambiguous
  // cases automatically using Aide and recent conversation context.
  return { kind: 'ambiguous', candidates: (mentioned.length ? mentioned : tasks).map(t => t.id) };
}

/** A task-local transcript. Never expose global summary or sidecar offsets here. */
export function chatTaskContext(chat: Chat, taskId?: string): Chat {
  if (!chat.tasks?.length) return chat;
  const task = taskId ? chat.tasks.find(t => t.id === taskId) : undefined;
  if (taskId && !task) throw new Error('Task not found in this chat.');
  return {
    ...chat,
    messages: chat.messages.filter(m => m.taskId === taskId),
    compaction: task ? task.compaction : chat.compaction,
  };
}

export function chatSessionScope(chat: Chat, taskId: string | undefined, workingDir: string, botProfile?: unknown): string {
  return JSON.stringify([taskId ?? null, chat.selection, workingDir, botProfile ?? null]);
}
