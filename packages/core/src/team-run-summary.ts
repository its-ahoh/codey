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
    worker: message.worker ?? 'Team',
    step: message.step ?? 0,
    text,
  };
}

/**
 * Build a terminal team summary from structured worker states. Status,
 * failures, and user actions are never inferred from prose: callers must have
 * recorded them on the worker message before this function runs.
 */
export function buildTeamRunSummary(messages: ChatMessage[], now: number = Date.now()): TeamRunSummary {
  const workers = messages
    .filter(message => !!message.worker)
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0));

  const completed: TeamRunSummaryEntry[] = [];
  const failures: TeamRunSummaryEntry[] = [];
  const nextUserActions: TeamRunSummaryEntry[] = [];

  for (const message of workers) {
    if (message.workerStatus === 'done' && !message.workerSummaryExcluded) {
      const text = compactOutput(message.content);
      if (text) completed.push(entry(message, text));
    }
    if (message.workerStatus === 'failed') {
      failures.push(entry(message, message.workerFailureReason?.trim() || 'Worker failed without a structured reason'));
    }
    if (message.workerNextUserAction?.text.trim()) {
      nextUserActions.push(entry(message, message.workerNextUserAction.text.trim()));
    }
  }

  return { completed, failures, nextUserActions, finalizedAt: now };
}

/** Return a summary only when at least one worker exists and every worker has
 * a terminal status. This is the gate used before emitting `team_end`. */
export function finalizeTeamRunSummary(messages: ChatMessage[], now: number = Date.now()): TeamRunSummary | null {
  const workers = messages.filter(message => !!message.worker);
  if (workers.length === 0) return null;
  if (!workers.every(message => message.workerStatus === 'done' || message.workerStatus === 'failed')) return null;
  return buildTeamRunSummary(messages, now);
}
