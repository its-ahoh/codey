import type { Chat, TaskBrief, TaskEvent } from '../types';

export type StatusTone = 'accent' | 'green' | 'yellow' | 'red';

/** A brief is stale when missing, or when the chat changed after it was generated. */
export function isTaskBriefStale(chat: Chat): boolean {
  if (!chat.taskBrief) return true;
  return chat.updatedAt > chat.taskBrief.generatedAt;
}

export function statusMeta(status: TaskBrief['state']['status']): { label: string; tone: StatusTone } {
  switch (status) {
    case 'waiting': return { label: '等你决定', tone: 'yellow' };
    case 'blocked': return { label: '受阻', tone: 'red' };
    case 'done':    return { label: '已完成', tone: 'green' };
    case 'working':
    default:        return { label: '进行中', tone: 'accent' };
  }
}

/** Relative time in Chinese buckets: 刚刚 / N 分钟前 / N 小时前 / N 天前. */
export function formatAgo(then: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - then);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

/** The newest entry (head, rendered expanded) vs. the collapsed history (rest). */
export function splitTimeline(timeline: TaskEvent[]): { head?: TaskEvent; rest: TaskEvent[] } {
  if (!timeline.length) return { head: undefined, rest: [] };
  return { head: timeline[0], rest: timeline.slice(1) };
}
