import { describe, expect, it, vi } from 'vitest';
import type { Chat, TaskBrief } from '@codey/core';
import { generateTaskBrief } from '@codey/core';
import { TaskBriefCache } from './task-brief-cache';

const brief: TaskBrief = { goal: 'Review', state: { status: 'working', progress: 0 }, timeline: [], generatedAt: 100 };
const chat = () => ({ title: 'Notes', messages: [{ id: 'm', role: 'user', content: 'Prepare notes', timestamp: 1 }] } as Chat);

describe('Task overview cache', () => {
  it('retries malformed model output instead of caching a display fallback', async () => {
    const current = chat();
    const runner = vi.fn().mockResolvedValueOnce({ success: true, output: 'not json' })
      .mockResolvedValue({ success: true, output: JSON.stringify(brief) });
    const cache = new TaskBriefCache();
    const save = (value: TaskBrief) => { current.taskBrief = value; };
    const generate = (snapshot: Chat) => generateTaskBrief(snapshot, { agent: 'codex', runner }, true);
    await expect(cache.get('c', () => current, save, generate)).rejects.toThrow('invalid task brief');
    expect(current.taskBrief).toBeUndefined();
    expect(await cache.get('c', () => current, save, generate)).toMatchObject({ goal: 'Review' });
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it('coalesces requests and reuses the persisted result after restart', async () => {
    const current = chat();
    const save = (value: TaskBrief) => { current.taskBrief = value; };
    const generate = vi.fn().mockResolvedValue(brief);
    const cache = new TaskBriefCache();
    await Promise.all([cache.get('c', () => current, save, generate), cache.get('c', () => current, save, generate)]);
    current.updatedAt = 12345;
    await new TaskBriefCache().get('c', () => current, save, generate);
    expect(generate).toHaveBeenCalledOnce();
    current.messages[0].content = 'Review notes';
    await cache.get('c', () => current, save, generate);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite new evidence with a late result', async () => {
    const current = chat();
    let finish!: (value: TaskBrief) => void;
    const save = vi.fn();
    const cache = new TaskBriefCache();
    const first = cache.get('c', () => current, save, () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    current.messages[0].content = 'Changed request';
    await cache.get('c', () => current, save, async () => ({ ...brief, goal: 'Updated' }));
    finish(brief);
    expect(await first).toBeNull();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].goal).toBe('Updated');
  });

  it('retries a failed request', async () => {
    const current = chat();
    const cache = new TaskBriefCache();
    const generate = vi.fn().mockRejectedValueOnce(new Error('Temporary')).mockResolvedValue(brief);
    await expect(cache.get('c', () => current, vi.fn(), generate)).rejects.toThrow('Temporary');
    expect(await cache.get('c', () => current, vi.fn(), generate)).toMatchObject({ goal: 'Review' });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('invalidates when a message status changes without a new timestamp', async () => {
    const current = chat();
    const generate = vi.fn().mockResolvedValue(brief);
    const save = (value: TaskBrief) => { current.taskBrief = value; };
    const cache = new TaskBriefCache();
    await cache.get('c', () => current, save, generate);
    current.messages[0].botStatus = 'failed';
    await cache.get('c', () => current, save, generate);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
