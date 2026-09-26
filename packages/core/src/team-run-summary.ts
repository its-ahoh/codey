import type { ChatMessage, TeamRunSummary, TeamRunSummaryEntry } from './types/chat';

const MAX_ENTRY_CHARS = 320;
const WHITEBOARD_MARKER = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?\[(?:FACT|DECISION|OPEN|HANDOFF(?:\s*:\s*[^\]]+)?)\]\s*:\s*.+$/i;

function compactOutput(text: string): string {
  const cleaned = text.split(/\r?\n/).filter(line => !WHITEBOARD_MARKER.test(line)).join('\n').trim();
  if (!cleaned) return '';
  const paragraphs = cleaned.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  const candidate = paragraphs[paragraphs.length - 1] ?? cleaned;
  return candidate.length > MAX_ENTRY_CHARS
    ? `${candidate.slice(0, MAX_ENTRY_CHARS - 1).trimEnd()}…`
    : candidate;
}

function entry(message: ChatMessage, text: string): TeamRunSummaryEntry {
  return {
    bot: message.bot ?? 'Team',
    step: message.step ?? 0,
    text,
  };
}

/**
 * Build a terminal team summary from structured bot states. Status,
 * failures, and user actions are never inferred from prose: callers must have
 * recorded them on the bot message before this function runs.
 */
export function buildTeamRunSummary(messages: ChatMessage[], now: number = Date.now()): TeamRunSummary {
  const bots = messages
    .filter(message => !!message.bot && !message.builtinMember)
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0));

  const completed: TeamRunSummaryEntry[] = [];
  const failures: TeamRunSummaryEntry[] = [];
  const nextUserActions: TeamRunSummaryEntry[] = [];

  for (const message of bots) {
    if (message.botStatus === 'done' && !message.botSummaryExcluded) {
      const text = compactOutput(message.content);
      if (text) completed.push(entry(message, text));
    }
    if (message.botStatus === 'failed') {
      failures.push(entry(message, message.botFailureReason?.trim() || 'Bot failed without a structured reason'));
    }
    if (message.botNextUserAction?.text.trim()) {
      nextUserActions.push(entry(message, message.botNextUserAction.text.trim()));
    }
  }

  return { completed, failures, nextUserActions, finalizedAt: now };
}

/** Return a summary only when at least one bot exists and every bot has
 * a terminal status. This is the gate used before emitting `team_end`. */
export function finalizeTeamRunSummary(messages: ChatMessage[], now: number = Date.now()): TeamRunSummary | null {
  // Pending messages are roster placeholders for members the router did not
  // select. They should remain visible in the UI without blocking completion.
  const bots = messages.filter(message => !!message.bot && !message.builtinMember && message.botStatus !== 'pending');
  if (bots.length === 0) return null;
  if (!bots.every(message => message.botStatus === 'done' || message.botStatus === 'failed')) return null;
  return buildTeamRunSummary(messages, now);
}
