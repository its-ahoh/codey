import { describe, expect, it, vi } from 'vitest';
import { Codey, NO_AGENT_MESSAGE } from './gateway';

function gatewayWith(chat: { agent?: string }, order: Array<{ agent: string }>) {
  const after = vi.fn(() => { throw new Error('reached the run'); });
  const gateway = Object.assign(Object.create(Codey.prototype), {
    configManager: { getFallback: () => ({ enabled: true, order }), hasDefaultAgent: () => order.length > 0 },
    chatManager: {
      get: () => ({ id: 'c1', messages: [], selection: { type: 'agent' }, ...chat }),
      // First call past the agent check; stands in for the rest of the turn.
      getTaskState: after,
    },
    pendingChatTurns: new Map(),
  }) as Codey;
  return gateway;
}

const send = (gateway: Codey) => gateway.sendToChat('c1', 'hi', () => {});

describe('a turn with no agent picked', () => {
  it('stops with a clear message instead of running a guessed agent', async () => {
    await expect(send(gatewayWith({}, []))).rejects.toThrow(NO_AGENT_MESSAGE);
  });

  it('runs when the chat picked its own agent', async () => {
    await expect(send(gatewayWith({ agent: 'codex' }, []))).rejects.not.toThrow(NO_AGENT_MESSAGE);
  });

  it('runs when a default agent is set', async () => {
    await expect(send(gatewayWith({}, [{ agent: 'pi' }]))).rejects.not.toThrow(NO_AGENT_MESSAGE);
  });
});
