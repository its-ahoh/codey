import { describe, expect, it, vi } from 'vitest';
import { Codey } from './gateway';

function gatewayWith(opts: {
  responses: Record<string, any>;
  auth: 'signed-out' | 'ok' | 'unknown';
  fallback?: { enabled: boolean; order: Array<{ agent: string }> };
}) {
  const checkAuth = vi.fn(async () => opts.auth);
  const gateway = Object.assign(Object.create(Codey.prototype), {
    getDefaultEffort: () => undefined,
    runAgentWithNetworkRetry: vi.fn(async (agent: string) => ({ ...opts.responses[agent] })),
    configManager: { getFallback: () => opts.fallback ?? { enabled: false, order: [] } },
    resolveFallbackModel: () => ({ model: 'auto' }),
    agentFactory: { checkAuth },
    logger: { error: () => {}, warn: () => {} },
  }) as Codey;
  return { gateway, checkAuth };
}

const run = (gateway: Codey, agent: string, extra: object = {}) =>
  (gateway as any).runWithFallback(agent, { prompt: 'hi', agent, ...extra });

describe('runWithFallback when the agent is signed out', () => {
  it('marks the failed response', async () => {
    const { gateway } = gatewayWith({
      responses: { 'claude-code': { success: false, output: '', error: 'Not logged in · Please run /login' } },
      auth: 'signed-out',
    });
    const res = await run(gateway, 'claude-code');
    expect(res.success).toBe(false);
    expect(res.authRequired).toEqual({ agent: 'claude-code' });
  });

  it('does not mark a failure that is not about sign-in', async () => {
    const { gateway } = gatewayWith({
      responses: { 'claude-code': { success: false, output: '', error: 'Rate limit reached' } },
      auth: 'ok',
    });
    expect((await run(gateway, 'claude-code')).authRequired).toBeUndefined();
  });

  it('never asks when the run succeeded', async () => {
    const { gateway, checkAuth } = gatewayWith({ responses: { codex: { success: true, output: 'ok' } }, auth: 'signed-out' });
    await run(gateway, 'codex');
    expect(checkAuth).not.toHaveBeenCalled();
  });

  it('never asks when the user stopped the turn', async () => {
    const { gateway, checkAuth } = gatewayWith({ responses: { codex: { success: false, output: '', error: 'aborted' } }, auth: 'signed-out' });
    const controller = new AbortController();
    controller.abort();
    const res = await run(gateway, 'codex', { signal: controller.signal });
    expect(checkAuth).not.toHaveBeenCalled();
    expect(res.authRequired).toBeUndefined();
  });

  it('delivers the fallback answer and puts the sign-in on the badge', async () => {
    const { gateway } = gatewayWith({
      responses: {
        'claude-code': { success: false, output: '', error: 'Not logged in · Please run /login' },
        codex: { success: true, output: 'answer' },
      },
      auth: 'signed-out',
      fallback: { enabled: true, order: [{ agent: 'codex' }] },
    });
    const res = await run(gateway, 'claude-code');
    expect(res.output).toBe('answer');
    expect(res.authRequired).toBeUndefined();
    expect(res.fallback.authRequired).toEqual({ agent: 'claude-code' });
  });

  it('keeps the mark when every fallback also fails', async () => {
    const { gateway } = gatewayWith({
      responses: {
        'claude-code': { success: false, output: '', error: 'Not logged in · Please run /login' },
        codex: { success: false, output: '', error: 'boom' },
      },
      auth: 'signed-out',
      fallback: { enabled: true, order: [{ agent: 'codex' }] },
    });
    const res = await run(gateway, 'claude-code');
    expect(res.authRequired).toEqual({ agent: 'claude-code' });
    expect(res.fallbackFailures).toEqual([{ agent: 'codex(auto)', reason: 'boom' }]);
  });

  it('a check that throws changes nothing', async () => {
    const { gateway, checkAuth } = gatewayWith({ responses: { codex: { success: false, output: '', error: 'boom' } }, auth: 'ok' });
    checkAuth.mockRejectedValueOnce(new Error('spawn failed'));
    const res = await run(gateway, 'codex');
    expect(res.error).toBe('boom');
    expect(res.authRequired).toBeUndefined();
  });
});
import { channelTextFor } from './gateway';

describe('what a channel is told', () => {
  const hint = 'Claude Code is signed out. Open Codey on your Mac and choose Sign in, or run `claude auth login`.';

  it('gets the one-line hint instead of the raw error', () => {
    expect(channelTextFor('❌ Error: Not logged in · Please run /login', { agent: 'claude-code' })).toBe(hint);
  });
  it('gets the normal text otherwise', () => {
    expect(channelTextFor('hello', undefined)).toBe('hello');
  });
  it('formatAgentResponse uses the hint too', () => {
    const gateway = Object.create(Codey.prototype) as Codey;
    const text = (gateway as any).formatAgentResponse({ success: false, output: '', error: 'x', authRequired: { agent: 'claude-code' } });
    expect(text).toBe(hint);
  });
});
