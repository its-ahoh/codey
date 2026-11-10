import { describe, expect, it, vi } from 'vitest';
import { AGENT_API_TYPE, CODING_AGENTS, isCliDefaultModelConfig } from '@codey/core';
import { Codey, turnModelLabel } from './gateway';

const catalog = [
  { model: 'sonnet-x', apiType: 'anthropic' as const },
  { model: 'gpt-x', apiType: 'openai' as const },
  { model: 'grok-x', apiType: 'grok' as const },
];

describe('no model chosen', () => {
  const gatewayWith = (order: Array<{ agent: string; model?: string }>) => Object.assign(Object.create(Codey.prototype), {
    configManager: {
      getFallback: () => ({ enabled: true, order }),
      listModels: () => catalog,
      getModel: (name: string) => catalog.find(m => m.model === name),
      getApiKey: () => undefined,
    },
    warnUnwiredAllModel: () => {},
  }) as Codey;

  it('never guesses a catalog model, so the CLI uses its own default', () => {
    expect(gatewayWith([]).getDefaultModelConfig('claude-code')).toBeUndefined();
    expect(gatewayWith([]).getDefaultModelConfig('cursor')).toBeUndefined();
  });

  it('uses the model pinned in Settings', () => {
    expect(gatewayWith([{ agent: 'codex', model: 'gpt-x' }]).getDefaultModelConfig('codex')?.model).toBe('gpt-x');
  });

  it('covers every agent', () => {
    for (const agent of CODING_AGENTS) expect(AGENT_API_TYPE[agent]).toBeDefined();
  });
});

describe('turnModelLabel', () => {
  it('says default when no model was passed', () => {
    expect(turnModelLabel('cursor', undefined)).toBe('default');
  });

  it('says default for a model a dedicated agent ignores', () => {
    expect(turnModelLabel('cursor', { model: 'sonnet-x', apiType: 'anthropic' })).toBe('default');
  });

  it('names a model the agent really uses', () => {
    expect(turnModelLabel('cursor', { model: 'gpt-5', apiType: 'cursor' })).toBe('gpt-5');
    expect(turnModelLabel('claude-code', { model: 'sonnet-x', apiType: 'anthropic' })).toBe('sonnet-x');
  });
});

describe('fallback entry with no model that fits', () => {
  it('runs the agent on its own default instead of skipping it', async () => {
    const run = vi.fn(async (_agent: string, _req: any) => ({ success: true, output: 'ok' }));
    const gateway = Object.assign(Object.create(Codey.prototype), {
      getDefaultEffort: () => undefined,
      runAgentWithNetworkRetry: vi.fn(async (agent: string, req: any) => agent === 'codex'
        ? { success: false, output: '', error: 'down' }
        : run(agent, req)),
      configManager: { getFallback: () => ({ enabled: true, order: [{ agent: 'cursor' }] }) },
      resolveFallbackModel: () => undefined,
      logger: { error: () => {}, warn: () => {} },
    }) as Codey;
    const res = await (gateway as any).runWithFallback('codex', { prompt: 'hi', agent: 'codex', model: { model: 'gpt-x', apiType: 'openai' } });
    expect(run).toHaveBeenCalledWith('cursor', expect.objectContaining({ model: undefined }));
    expect(res.fallback).toMatchObject({ from: 'codex(gpt-x)', to: 'cursor(default)' });
  });
});

describe('"default" model choice', () => {
  it('resolves to a marker config, not undefined, so it is never read as "nothing chosen"', () => {
    const gateway = Object.create(Codey.prototype) as Codey;
    const model = gateway.getModelConfig('cursor', 'default');
    expect(isCliDefaultModelConfig(model)).toBe(true);
    expect(turnModelLabel('cursor', model)).toBe('default');
  });

  it('survives the `chosen ?? pinned` fallback team and voice code uses', () => {
    const gateway = Object.assign(Object.create(Codey.prototype), {
      configManager: {
        getFallback: () => ({ enabled: true, order: [{ agent: 'codex', model: 'gpt-x' }] }),
        getModel: (name: string) => catalog.find(m => m.model === name),
        getApiKey: () => undefined,
      },
      warnUnwiredAllModel: () => {},
    }) as Codey;
    const chosen = gateway.getModelConfig('codex', 'default');
    expect((chosen ?? gateway.getDefaultModelConfig('codex'))?.model).toBe('default');
  });

  it('still uses a catalog model that is actually named "default"', () => {
    const gateway = Object.assign(Object.create(Codey.prototype), {
      configManager: {
        getModel: (name: string) => name === 'default' ? { model: 'default', apiType: 'openai' as const } : undefined,
        getApiKey: () => undefined,
      },
      warnUnwiredAllModel: () => {},
    }) as Codey;
    const model = gateway.getModelConfig('codex', 'default');
    expect(isCliDefaultModelConfig(model)).toBe(false);
    expect(model).toMatchObject({ model: 'default', apiType: 'openai' });
  });

  it('runs a fallback entry pinned to default instead of skipping it', async () => {
    const run = vi.fn(async (_agent: string, _req: any) => ({ success: true, output: 'ok' }));
    const gateway = Object.assign(Object.create(Codey.prototype), {
      getDefaultEffort: () => undefined,
      runAgentWithNetworkRetry: vi.fn(async (agent: string, req: any) => agent === 'codex'
        ? { success: false, output: '', error: 'down' }
        : run(agent, req)),
      configManager: { getFallback: () => ({ enabled: true, order: [{ agent: 'grok', model: 'default' }] }), getModel: () => undefined },
      logger: { error: () => {}, warn: () => {} },
    }) as Codey;
    const res = await (gateway as any).runWithFallback('codex', { prompt: 'hi', agent: 'codex', model: { model: 'gpt-x', apiType: 'openai' } });
    expect(isCliDefaultModelConfig(run.mock.calls[0][1].model)).toBe(true);
    expect(res.fallback).toMatchObject({ to: 'grok(default)' });
  });
});
