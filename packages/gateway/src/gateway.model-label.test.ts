import { describe, expect, it, vi } from 'vitest';
import { AGENT_API_TYPE, CODING_AGENTS } from '@codey/core';
import { Codey, firstFittingModel, turnModelLabel } from './gateway';

const catalog = [
  { model: 'sonnet-x', apiType: 'anthropic' as const },
  { model: 'gpt-x', apiType: 'openai' as const },
  { model: 'grok-x', apiType: 'grok' as const },
];

describe('firstFittingModel', () => {
  it('skips models the agent cannot run', () => {
    expect(firstFittingModel('codex', catalog)).toBe('gpt-x');
    expect(firstFittingModel('grok', catalog)).toBe('grok-x');
  });

  it('is undefined when nothing fits, so the CLI uses its own default', () => {
    expect(firstFittingModel('cursor', catalog)).toBeUndefined();
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
    const run = vi.fn(async (_agent: string, _req: unknown) => ({ success: true, output: 'ok' }));
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
