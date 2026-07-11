// packages/core/src/aide-automation.test.ts
import { describe, it, expect } from 'vitest';
import { renderBrief, automationChatTurn } from './aide-automation';
import type { AideOptions } from './aide';
import type { AgentRequest, AgentResponse } from './types';

const aide = (output: string): AideOptions => ({
  agent: 'claude-code',
  runner: async (_req: AgentRequest): Promise<AgentResponse> =>
    ({ success: true, output } as AgentResponse),
});

describe('renderBrief', () => {
  it('substitutes placeholders and appends leftovers as a Parameters block', () => {
    const out = renderBrief('Post {{count}} items to {{account}}.', {
      count: '5', account: '@jack', tone: 'dry',
    });
    expect(out).toContain('Post 5 items to @jack.');
    expect(out).toContain('Parameters:\n- tone: dry');
  });
  it('does not resolve placeholders from Object.prototype', () => {
    expect(renderBrief('Hi {{constructor}}', { who: 'you' }))
      .toBe('Hi {{constructor}}\n\nParameters:\n- who: you');
  });
  it('leaves unknown placeholders intact and skips the block when all used', () => {
    expect(renderBrief('Hi {{who}}', {})).toBe('Hi {{who}}');
    expect(renderBrief('Hi {{who}}', { who: 'you' })).toBe('Hi you');
  });
});

describe('automationChatTurn', () => {
  const ctx = {
    workspaces: ['default', 'blog'], teams: ['news'],
    tz: 'Asia/Shanghai', nowIso: 'Fri Jul 11 2026 10:00:00 GMT+0800', mode: 'create' as const,
  };
  const msgs = [{ role: 'user' as const, text: 'post AI news daily' }];

  it('parses a full turn', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"Which workspace?","draftPatch":{"name":"AI news"},"suggestions":["default","blog"],"ready":false}'));
    expect(t).toEqual({
      reply: 'Which workspace?', draftPatch: { name: 'AI news' },
      suggestions: ['default', 'blog'], ready: false,
    });
  });

  it('defaults optional fields', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide('{"reply":"ok"}'));
    expect(t.draftPatch).toEqual({});
    expect(t.suggestions).toEqual([]);
    expect(t.ready).toBe(false);
  });

  it('keeps null patch values (they mean "clear the field") and drops unknown keys', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":null,"bogus":1}}'));
    expect(t.draftPatch).toEqual({ schedule: null });
  });

  it('drops non-string suggestions', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide('{"reply":"ok","suggestions":["a",1,""]}'));
    expect(t.suggestions).toEqual(['a']);
  });

  it('throws on malformed JSON and on an empty reply', async () => {
    await expect(automationChatTurn(msgs, {}, ctx, aide('not json'))).rejects.toThrow();
    await expect(automationChatTurn(msgs, {}, ctx, aide('{"reply":"  "}'))).rejects.toThrow();
  });

  it('drops a malformed schedule patch but keeps a valid one and null', async () => {
    const bad = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":{"hour":"9","minute":0,"tz":"UTC"}}}'));
    expect(bad.draftPatch).toEqual({});
    const good = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":{"hour":9,"minute":0,"tz":"UTC","daysOfWeek":[1,2]}}}'));
    expect(good.draftPatch).toEqual({ schedule: { hour: 9, minute: 0, tz: 'UTC', daysOfWeek: [1, 2] } });
  });

  it('drops a malformed target patch', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"target":{"kind":"team","workspaceName":"w"}}}'));
    expect(t.draftPatch).toEqual({});
  });
});
