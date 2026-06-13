import { describe, it, expect } from 'vitest';
import { isTaskBriefStale, statusMeta, formatAgo, splitTimeline, extractSidecarBrief } from './taskHudView';
import type { Chat, TaskBrief } from '../types';

const brief = (over: Partial<TaskBrief> = {}): TaskBrief => ({
  goal: 'g', state: { progress: 0, status: 'working' }, timeline: [], generatedAt: 100, ...over,
});
const msg = (timestamp: number): any => ({ id: 'm' + timestamp, role: 'assistant', content: 'x', timestamp });
const chat = (over: Partial<Chat> = {}): Chat =>
  ({ id: 'c', title: 't', workspaceName: 'w', selection: {} as any, messages: [],
     createdAt: 0, updatedAt: 100, ...over } as Chat);

describe('isTaskBriefStale', () => {
  it('is stale when there is no brief', () => {
    expect(isTaskBriefStale(chat({ taskBrief: undefined }))).toBe(true);
  });
  it('is stale when a new message arrived after the brief was generated', () => {
    expect(isTaskBriefStale(chat({ messages: [msg(200)], taskBrief: brief({ generatedAt: 100 }) }))).toBe(true);
  });
  it('is fresh when no message is newer than the brief', () => {
    expect(isTaskBriefStale(chat({ messages: [msg(100)], taskBrief: brief({ generatedAt: 100 }) }))).toBe(false);
  });
  it('is fresh when an unrelated mutation bumped updatedAt but no new message', () => {
    expect(isTaskBriefStale(chat({ updatedAt: 999, messages: [msg(50)], taskBrief: brief({ generatedAt: 100 }) }))).toBe(false);
  });
});

describe('statusMeta', () => {
  it('maps each status to a label + tone', () => {
    expect(statusMeta('waiting').tone).toBe('yellow');
    expect(statusMeta('blocked').tone).toBe('red');
    expect(statusMeta('done').tone).toBe('green');
    expect(statusMeta('working').tone).toBe('accent');
    expect(statusMeta('waiting').label.length).toBeGreaterThan(0);
  });
});

describe('formatAgo', () => {
  it('formats relative time buckets', () => {
    const now = 10_000_000;
    expect(formatAgo(now, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('splitTimeline', () => {
  it('separates the newest entry (head) from the rest', () => {
    const tl = [{ kind: 'progress', text: 'a' }, { kind: 'decision', text: 'b' }] as TaskBrief['timeline'];
    const { head, rest } = splitTimeline(tl);
    expect(head?.text).toBe('a');
    expect(rest.map(e => e.text)).toEqual(['b']);
  });
  it('handles an empty timeline', () => {
    expect(splitTimeline([])).toEqual({ head: undefined, rest: [] });
  });
});

describe('extractSidecarBrief', () => {
  const tl = (text: string, when?: number) => ({ kind: 'progress' as const, text, when });

  it('passes through goal, status, progress and next action text', () => {
    const v = extractSidecarBrief(brief({
      goal: 'Ship sidecar',
      state: { progress: 42, status: 'waiting' },
      nextAction: { text: 'Answer the question', detail: 'ignored', messageId: 'm1' },
    }));
    expect(v.goal).toBe('Ship sidecar');
    expect(v.status).toBe('waiting');
    expect(v.progress).toBe(42);
    expect(v.nextActionText).toBe('Answer the question');
  });

  it('omits nextActionText when there is no next action', () => {
    const v = extractSidecarBrief(brief({ nextAction: undefined }));
    expect(v.nextActionText).toBeUndefined();
  });

  it('keeps the 3 newest timeline entries, newest first', () => {
    const v = extractSidecarBrief(brief({
      timeline: [tl('a', 5), tl('b', 4), tl('c', 3), tl('d', 2)],
    }));
    expect(v.recent.map(r => r.text)).toEqual(['a', 'b', 'c']);
    expect(v.recent[0].when).toBe(5);
  });

  it('handles an empty timeline', () => {
    const v = extractSidecarBrief(brief({ timeline: [] }));
    expect(v.recent).toEqual([]);
  });
});
