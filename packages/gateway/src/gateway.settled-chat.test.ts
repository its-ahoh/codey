import { expect, it, vi } from 'vitest';
import { Codey } from './gateway';

it('withholds snapshots throughout overlapping turns, including preparation and errors', async () => {
  const chat = { id: 'c1', messages: [] };
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const gateway = Object.assign(Object.create(Codey.prototype), {
    pendingChatTurns: new Map(),
    chatManager: { get: () => chat },
    sendToChatWithMemoryTrace: vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; })),
  }) as Codey;
  const first = gateway.sendToChat('c1', 'first', () => {});
  const second = gateway.sendToChat('c1', 'second', () => {});
  expect(gateway.getSettledChat('c1')).toBeNull();
  finish();
  await first;
  expect(gateway.getSettledChat('c1')).toBeNull();
  const rejected = expect(second).rejects.toThrow('interrupted');
  fail(new Error('interrupted'));
  await rejected;
  expect(gateway.getSettledChat('c1')).toBe(chat);
});
