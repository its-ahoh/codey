import { Chat } from '@codey/core';

/**
 * Summarize prior chat history into 3–5 sentences. Used when a chat is first linked to a channel,
 * so the channel user gets a brief catch-up message.
 *
 * v1 implementation is intentionally local and deterministic: take the last 6 messages, truncate
 * each, and stitch them. We can swap in an LLM call later without changing call sites.
 */
export function summarizePriorHistory(
  chat: Chat,
  opts?: { maxMessages?: number; perMessageChars?: number; defaultAgent?: string; defaultModel?: string },
): string {
  const max = opts?.maxMessages ?? 6;
  const cap = opts?.perMessageChars ?? 160;

  // Header reflects the chat's actual run-time settings — workspace, agent,
  // model, and team selection — so the channel user sees what they're talking
  // to instead of a generic "Picking up chat" line. Each field falls back to
  // the gateway default when the chat itself doesn't override.
  const agent = chat.agent ?? opts?.defaultAgent ?? 'default';
  const model = chat.model ?? opts?.defaultModel ?? 'default';
  const sel = chat.selection;
  const selectionLabel =
    sel?.type === 'team' ? `team:${sel.name ?? '(workspace default)'}`
    : sel?.type === 'worker' ? `worker:${sel.name ?? '?'}`
    : 'solo';
  const header =
    `📋 Linked to chat "${chat.title}"\n` +
    `• workspace: ${chat.workspaceName}\n` +
    `• agent: ${agent}\n` +
    `• model: ${model}\n` +
    `• mode: ${selectionLabel}`;

  const tail = chat.messages.slice(-max);
  if (tail.length === 0) return `${header}\n(no prior history)`;

  const lines = tail.map(m => {
    const who = m.role === 'user' ? 'You' : 'Agent';
    const text = m.content.replace(/\s+/g, ' ').trim();
    const cut = text.length <= cap ? text : text.slice(0, cap) + '…';
    return `${who}: ${cut}`;
  });
  return `${header}\n\nRecent context:\n${lines.join('\n')}`;
}
