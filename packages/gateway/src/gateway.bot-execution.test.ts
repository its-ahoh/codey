import { describe, expect, it, vi } from 'vitest';
import { Codey } from './gateway';
import type { BotExecution, CodingAgent, ModelConfig } from '@codey/core';

/** Runs resolveBotExecution against a stub gateway: one bot with the given override. */
function resolve(execution: BotExecution | undefined, agent: CodingAgent, model: ModelConfig | undefined, catalog: Record<string, ModelConfig | Error> = {}) {
  const warn = vi.fn();
  const stub = {
    logger: { warn },
    workspaceManager: { getBotManager: () => ({ getBot: (name: string) => name === 'alice' ? { config: { tools: [], ...(execution ? { execution } : {}) } } : undefined }) },
    getModelConfig: (_agent: CodingAgent, name: string) => {
      const hit = catalog[name];
      if (hit instanceof Error) throw hit;
      return hit;
    },
    getDefaultModelConfig: (a: CodingAgent) => ({ provider: 'x', model: `${a}-default` }),
  };
  const result = (Codey.prototype as any).resolveBotExecution.call(stub, 'alice', agent, model);
  return { ...result, warn };
}

const chatModel: ModelConfig = { provider: 'anthropic', model: 'chat-model' };

describe('resolveBotExecution', () => {
  it('keeps the run settings when the bot has no override', () => {
    const r = resolve(undefined, 'claude-code', chatModel);
    expect(r.agent).toBe('claude-code');
    expect(r.model).toBe(chatModel);
  });

  it('uses both the bot agent and model when set', () => {
    const pinned = { provider: 'openai', model: 'pinned' };
    const r = resolve({ agent: 'codex', model: 'pinned' }, 'claude-code', chatModel, { pinned });
    expect(r.agent).toBe('codex');
    expect(r.model).toBe(pinned);
  });

  it('gives an agent-only override that agent\'s default model, not the chat model', () => {
    const r = resolve({ agent: 'codex' }, 'claude-code', chatModel);
    expect(r.agent).toBe('codex');
    expect(r.model?.model).toBe('codex-default');
  });

  it('keeps the chat model when the agent override equals the run agent', () => {
    const r = resolve({ agent: 'claude-code' }, 'claude-code', chatModel);
    expect(r.model).toBe(chatModel);
  });

  it('applies a model-only override to the run agent', () => {
    const pinned = { provider: 'anthropic', model: 'pinned' };
    const r = resolve({ model: 'pinned' }, 'claude-code', chatModel, { pinned });
    expect(r.agent).toBe('claude-code');
    expect(r.model).toBe(pinned);
  });

  it('falls back to the agent default and warns when the model cannot be used', () => {
    const missing = resolve({ agent: 'codex', model: 'gone' }, 'claude-code', chatModel);
    expect(missing.model?.model).toBe('codex-default');
    expect(missing.warn).toHaveBeenCalledOnce();
    const broken = resolve({ model: 'broken' }, 'claude-code', chatModel, { broken: new Error('key missing') });
    expect(broken.model?.model).toBe('claude-code-default');
    expect(broken.warn).toHaveBeenCalledOnce();
  });
});
