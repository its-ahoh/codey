import { describe, it, expect } from 'vitest';
import { isTaskBriefStale, statusMeta, formatAgo, splitTimeline } from './taskHudView';
import type { Chat, TaskBrief } from '../types';

const brief = (over: Partial<TaskBrief> = {}): TaskBrief => ({
  goal: 'g', state: { progress: 0, status: 'working' }, timeline: [], generatedAt: 100, ...over,
});
const chat = (over: Partial<Chat> = {}): Chat =>
  ({ id: 'c', title: 't', workspaceName: 'w', selection: {} as any, messages: [],
     createdAt: 0, updatedAt: 100, ...over } as Chat);

describe('isTaskBriefStale', () => {
  it('is stale when there is no brief', () => {
    expect(isTaskBriefStale(chat({ taskBrief: undefined }))).toBe(true);
  });
  it('is stale when the chat changed after the brief was generated', () => {
    expect(isTaskBriefStale(chat({ updatedAt: 200, taskBrief: brief({ generatedAt: 100 }) }))).toBe(true);
  });
  it('is fresh when the brief is at least as new as the chat', () => {
    expect(isTaskBriefStale(chat({ updatedAt: 100, taskBrief: brief({ generatedAt: 100 }) }))).toBe(false);
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
