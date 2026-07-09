import { parseAskUser } from '@codey/core';
import type { Chat, Automation } from '@codey/core';

export interface ParkedInfo { question: string; options?: string[] }

/**
 * Decide whether a finished headless turn actually parked. Team targets park
 * via the persisted chat.pendingTeam (the existing pause machinery); prompt
 * targets park when the single agent emitted an [ASK_USER] marker.
 */
export function detectParked(
  chat: Chat | undefined,
  target: Automation['target'],
  response: string,
): ParkedInfo | null {
  const pending = chat?.pendingTeam;
  if (pending) return { question: pending.question, options: pending.options };
  if (target.kind === 'prompt') {
    const ask = parseAskUser(response);
    if (ask) return { question: ask.question, options: ask.options };
  }
  return null;
}
