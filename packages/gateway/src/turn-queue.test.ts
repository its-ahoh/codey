// Run: npx ts-node packages/gateway/src/turn-queue.test.ts
import * as assert from 'assert';
import { TurnQueue, QueuedMessage } from './turn-queue';

async function run() {
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

  assert.deepStrictEqual(seen, [
    ['mac:a'],
    ['telegram:b', 'mac:c'],
  ]);

  q.submit('c2', { surface: 'discord', text: 'x', userId: 'u', timestamp: 4 });
  await q.drain();
  assert.deepStrictEqual(seen[2], ['discord:x']);

  console.log('turn-queue.test ok');
}

run().catch(e => { console.error(e); process.exit(1); });
