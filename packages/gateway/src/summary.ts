import { Chat } from '@codey/core';

/**
 * Summarize prior chat history into 3–5 sentences. Used when a chat is first linked to a channel,
 * so the channel user gets a brief catch-up message.
 *
 * v1 implementation is intentionally local and deterministic: take the last 6 messages, truncate
 * each, and stitch them. We can swap in an LLM call later without changing call sites.
 */
export function summarizePriorHistory(chat: Chat, opts?: { maxMessages?: number; perMessageChars?: number }): string {
  const max = opts?.maxMessages ?? 6;
  const cap = opts?.perMessageChars ?? 160;
  const tail = chat.messages.slice(-max);
  if (tail.length === 0) {
    return `📋 Picking up chat "${chat.title}" (no prior history).`;
  }
  const lines = tail.map(m => {
    const who = m.role === 'user' ? 'You' : 'Agent';
    const text = m.content.replace(/\s+/g, ' ').trim();
    const cut = text.length <= cap ? text : text.slice(0, cap) + '…';
    return `${who}: ${cut}`;
  });
  return `📋 Picking up chat "${chat.title}". Recent context:\n${lines.join('\n')}`;
}
