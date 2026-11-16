import { Chat } from '@codey/core';

/**
 * A short, local catch-up for a channel user who just connected to a chat
 * (Mac-side link, or /start on an already-linked channel). Deterministic — no
 * LLM call — and deliberately tiny: one header line plus the last exchange.
 */
export function summarizePriorHistory(
  chat: Chat,
  opts?: { maxMessages?: number; perMessageChars?: number; defaultAgent?: string; defaultModel?: string },
): string {
  const max = opts?.maxMessages ?? 2;
  const cap = opts?.perMessageChars ?? 120;

  const sel = chat.selection;
  const mode =
    sel?.type === 'team' ? `team:${sel.name ?? 'default'}`
    : sel?.type === 'bot' ? `bot:${sel.name ?? '?'}`
    : undefined;
  const header = [
    `🔗 "${chat.title}"`,
    chat.agent ?? opts?.defaultAgent,
    chat.model ?? opts?.defaultModel,
    chat.workspaceName,
    mode,
  ].filter(Boolean).join(' · ');

  const lines = chat.messages.slice(-max).map(m => {
    const who = m.role === 'user' ? 'You' : 'Agent';
    const text = m.content.replace(/\s+/g, ' ').trim();
    return `${who}: ${text.length <= cap ? text : text.slice(0, cap) + '…'}`;
  });
  return [header, ...lines].join('\n');
}
