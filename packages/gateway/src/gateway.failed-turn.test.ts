import { describe, expect, it, vi } from 'vitest';
import { Codey } from './gateway';

describe('runWithFallback when every agent fails', () => {
  it('returns the primary error plus why each fallback failed', async () => {
    const responses: Record<string, any> = {
      grok: { success: false, output: '', error: 'missing field version' },
      cursor: { success: false, output: '', error: 'Authentication required' },
    };
    const gateway = Object.assign(Object.create(Codey.prototype), {
      getDefaultEffort: () => undefined,
      runAgentWithNetworkRetry: vi.fn(async (agent: string) => ({ ...responses[agent] })),
      configManager: { getFallback: () => ({ enabled: true, order: [{ agent: 'cursor' }] }) },
      resolveFallbackModel: () => ({ model: 'auto' }),
      logger: { error: () => {}, warn: () => {} },
    }) as Codey;
    const res = await (gateway as any).runWithFallback('grok', { prompt: 'hi', agent: 'grok', model: { model: 'grok-4' } });
    expect(res.error).toBe('missing field version');
    expect(res.fallbackFailures).toEqual([{ agent: 'cursor(auto)', reason: 'Authentication required' }]);
  });
});

describe('automation turn that fails', () => {
  it('reports the run as failed instead of success', async () => {
    const chat = { id: 'auto-chat', messages: [] };
    const gateway = Object.assign(Object.create(Codey.prototype), {
      chatManager: { reload: () => {}, get: () => chat, setPendingTeam: () => {} },
      ensureAutomationChat: async () => 'auto-chat',
      sendToChat: async () => ({ response: '❌ Error: Authentication required', chatId: 'auto-chat', error: 'Authentication required' }),
      logger: { info: () => {} },
    }) as Codey;
    const automation = { id: 'a1', name: 'Nightly', chatId: 'auto-chat', target: { kind: 'prompt' } };
    const res = await (gateway as any).runAutomationTurn(automation, 'Run it');
    expect(res).toEqual({ output: '❌ Error: Authentication required', error: 'Authentication required' });
  });
});
