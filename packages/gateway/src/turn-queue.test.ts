import { describe, it, expect } from 'vitest';
import { TurnQueue, QueuedMessage } from './turn-queue';

describe('TurnQueue', () => {
  it('runs the first message alone and coalesces the ones that arrive while it is busy', async () => {
    const seen: string[][] = [];
    const q = new TurnQueue(async (chatId, batch: QueuedMessage[]) => {
      seen.push(batch.map(m => `${m.surface}:${m.text}`));
      await new Promise(r => setTimeout(r, 20));
      return { chatId };
    });

    q.submit('c1', { surface: 'mac', text: 'a', userId: 'u', timestamp: 1 });
    q.submit('c1', { surface: 'telegram', text: 'b', userId: 'u', timestamp: 2 });
    q.submit('c1', { surface: 'mac', text: 'c', userId: 'u', timestamp: 3 });

    await q.drain();

    expect(seen).toEqual([
      ['mac:a'],
      ['telegram:b', 'mac:c'],
    ]);
  });

  it('keeps a second chat on its own queue', async () => {
    const seen: string[][] = [];
    const q = new TurnQueue(async (chatId, batch: QueuedMessage[]) => {
      seen.push(batch.map(m => `${m.surface}:${m.text}`));
      await new Promise(r => setTimeout(r, 20));
      return { chatId };
    });

    q.submit('c1', { surface: 'mac', text: 'a', userId: 'u', timestamp: 1 });
    q.submit('c2', { surface: 'discord', text: 'x', userId: 'u', timestamp: 4 });
    await q.drain();

    expect(seen).toContainEqual(['discord:x']);
  });
});
