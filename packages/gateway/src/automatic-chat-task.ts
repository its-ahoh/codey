import { type Chat, type ChatTaskRoute, resolveChatTask } from '@codey/core';

/**
 * Which task a direct-chat message belongs to. No model sorts messages into
 * tasks: the agent reads the conversation and judges relevance itself. Only an
 * explicit reply/retry route picks a task; otherwise the message continues
 * wherever the conversation last was, so context is never split off.
 */
export function chatTaskForMessage(chat: Chat, text: string, route: ChatTaskRoute | undefined): string | undefined {
  if (route?.taskId !== undefined || route?.replyToMessageId) {
    const exact = resolveChatTask(chat, text, route);
    if (exact.kind === 'invalid') throw new Error(exact.message);
    return exact.kind === 'resolved' ? exact.taskId : undefined;
  }
  const latest = [...chat.messages].reverse().find(message => message.role === 'user');
  return latest?.taskId && chat.tasks?.some(task => task.id === latest.taskId) ? latest.taskId : undefined;
}
