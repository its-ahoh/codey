import type { Chat, TaskBrief, TaskEvent } from '../types';

export type StatusTone = 'accent' | 'green' | 'yellow' | 'red';

/**
 * A brief is stale when missing, or when a new message arrived after it was
 * generated. Keyed off the last message's timestamp (not chat.updatedAt) so
 * unrelated chat mutations — e.g. toggling the panel — don't trigger a refresh.
 */
export function isTaskBriefStale(chat: Chat): boolean {
  if (!chat.taskBrief) return true;
  const last = chat.messages[chat.messages.length - 1];
  return !!last && last.timestamp > chat.taskBrief.generatedAt;
}

export function statusMeta(status: TaskBrief['state']['status']): { label: string; tone: StatusTone } {
  switch (status) {
    case 'waiting': return { label: 'Waiting on you', tone: 'yellow' };
    case 'blocked': return { label: 'Blocked', tone: 'red' };
    case 'done':    return { label: 'Done', tone: 'green' };
    case 'working':
    default:        return { label: 'In progress', tone: 'accent' };
  }
}

/** Relative time in short buckets: just now / Nm ago / Nh ago / Nd ago. */
export function formatAgo(then: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - then);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** The newest entry (head, rendered expanded) vs. the collapsed history (rest). */
export function splitTimeline(timeline: TaskEvent[]): { head?: TaskEvent; rest: TaskEvent[] } {
  if (!timeline.length) return { head: undefined, rest: [] };
  return { head: timeline[0], rest: timeline.slice(1) };
}
