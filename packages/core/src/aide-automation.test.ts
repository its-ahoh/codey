// packages/core/src/aide-automation.test.ts
import { describe, it, expect } from 'vitest';
import {
  renderBrief, automationChatTurn, buildDryRunPrompt, classifyDryRun,
  formatTranscript, MAX_CHAT_HISTORY,
} from './aide-automation';
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

  it('coerces near-miss schedule patches instead of dropping them', async () => {
    // Numeric-string hour in the legacy single shape: coerced, not lost.
    const legacy = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":{"hour":"9","minute":0,"tz":"UTC"}}}'));
    expect(legacy.draftPatch).toEqual({ schedule: { slots: [{ hour: 9, minute: 0 }], tz: 'UTC' } });
    // Missing tz falls back to the user's zone; times are sorted.
    const noTz = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":{"times":[{"hour":18,"minute":30},{"hour":9,"minute":0}]}}}'));
    expect(noTz.draftPatch).toEqual({
      schedule: { slots: [{ hour: 9, minute: 0 }, { hour: 18, minute: 30 }], tz: 'Asia/Shanghai' },
    });
    const good = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":{"times":[{"hour":9,"minute":0}],"tz":"UTC","daysOfWeek":[1,2]}}}'));
    expect(good.draftPatch).toEqual({ schedule: { slots: [{ hour: 9, minute: 0, daysOfWeek: [1, 2] }], tz: 'UTC' } });
  });

  it('drops an unusable schedule patch', async () => {
    const bad = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":{"hour":99,"minute":0,"tz":"UTC"}}}'));
    expect(bad.draftPatch).toEqual({});
  });

  it('drops a malformed target patch', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"target":{"kind":"team","workspaceName":"w"}}}'));
    expect(t.draftPatch).toEqual({});
  });

  it('merges targeted model and parameter edits with the existing draft', async () => {
    const draft = {
      target: { kind: 'prompt' as const, workspaceName: 'default', agent: 'codex' as const },
      params: { account: '@codey', count: '5' },
    };
    const t = await automationChatTurn(msgs, draft, ctx, aide(
      '{"reply":"Updated.","draftPatch":{"target":{"model":"gpt-5.6"},"params":{"tone":"brief","count":null}},"ready":true}'));
    expect(t.draftPatch).toEqual({
      target: { kind: 'prompt', workspaceName: 'default', agent: 'codex', model: 'gpt-5.6' },
      params: { account: '@codey', tone: 'brief' },
    });
  });
});

describe('CHAT_TURN_PROMPT readiness gate', () => {
  const ctx = {
    workspaces: ['default'], teams: [],
    tz: 'UTC', nowIso: 'now', mode: 'create' as const,
  };

  it('does not require scheduling discussion for ready=true', async () => {
    let captured = '';
    const opts: AideOptions = {
      agent: 'claude-code',
      runner: async (req: AgentRequest): Promise<AgentResponse> => {
        captured = req.prompt;
        return { success: true, output: '{"reply":"ok"}' } as AgentResponse;
      },
    };
    await automationChatTurn([{ role: 'user', text: 'hi' }], {}, ctx, opts);
    expect(captured).not.toMatch(/scheduling has been explicitly discussed/i);
    expect(captured).toMatch(/scheduling is NOT required for ready/i);
    expect(captured).not.toMatch(/and eventually scheduling/i);
    expect(captured).not.toMatch(/dry-run findings/i);
    expect(captured).toMatch(/clearly scoped change/i);
    expect(captured).toMatch(/DO NOT restart the setup interview/i);
    expect(captured).toMatch(/Ask a follow-up only when the requested edit itself is ambiguous/i);
  });
});

describe('buildDryRunPrompt', () => {
  it('renders params into the brief and wraps it in a no-act preamble', () => {
    const p = buildDryRunPrompt('Post {{count}} items.', { count: '5' });
    expect(p).toContain('Post 5 items.');
    expect(p).toMatch(/DRY RUN/);
    expect(p).toMatch(/do not perform any real actions/i);
    expect(p).not.toContain('{{count}}');
  });

  it('inlines team context when provided', () => {
    const p = buildDryRunPrompt('b', {}, '{"members":["a","b"]}');
    expect(p).toContain('{"members":["a","b"]}');
    expect(p).toMatch(/normally executed by a team/i);
  });

  it('omits the team section when absent', () => {
    expect(buildDryRunPrompt('b', {})).not.toMatch(/normally executed by a team/i);
  });
});

describe('classifyDryRun', () => {
  it('parses a clean verdict', async () => {
    await expect(classifyDryRun('all good', aide('{"verdict":"clean"}')))
      .resolves.toEqual({ status: 'clean' });
  });

  it('parses gaps with questions, dropping non-strings', async () => {
    await expect(classifyDryRun('out', aide('{"verdict":"gaps","questions":["Which repo?",1,""]}')))
      .resolves.toEqual({ status: 'gaps', questions: ['Which repo?'] });
  });

  it('treats gaps without questions and unknown verdicts as errors', async () => {
    await expect(classifyDryRun('out', aide('{"verdict":"gaps","questions":[]}'))).rejects.toThrow();
    await expect(classifyDryRun('out', aide('{"verdict":"maybe"}'))).rejects.toThrow();
    await expect(classifyDryRun('out', aide('not json'))).rejects.toThrow();
  });
});

describe('formatTranscript', () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `m${i}`,
  }));

  it('renders every message when under the cap', () => {
    expect(formatTranscript(msgs(2))).toBe('User: m0\nYou: m1');
  });

  it('keeps the newest MAX_CHAT_HISTORY and marks the elision', () => {
    const out = formatTranscript(msgs(30));
    const lines = out.split('\n');
    expect(lines[0]).toBe('[earlier turns omitted]');
    expect(lines).toHaveLength(MAX_CHAT_HISTORY + 1);
    expect(lines[1]).toBe('User: m6');
    expect(lines[lines.length - 1]).toBe('You: m29');
    expect(out).not.toContain('m5');
  });
});

describe('automationChatTurn budget', () => {
  const ctx2 = {
    workspaces: ['default'], teams: [], tz: 'Asia/Shanghai',
    nowIso: 'Fri Jul 11 2026 10:00:00 GMT+0800', mode: 'create' as const,
  };

  it('asks for a 90s budget and one retry, and survives one transient failure', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const runner = async (req: AgentRequest): Promise<AgentResponse> => {
      seen.push(req.signal);
      if (++calls === 1) throw new Error('socket hang up');
      return { success: true, output: '{"reply":"ok"}' } as AgentResponse;
    };
    const t = await automationChatTurn([{ role: 'user', text: 'hi' }], {}, ctx2, {
      agent: 'claude-code', runner, retryDelayMs: 0,
    });
    expect(t.reply).toBe('ok');
    expect(calls).toBe(2);
  });

  it('lets an explicit caller budget win', async () => {
    let calls = 0;
    const runner = async (_req: AgentRequest): Promise<AgentResponse> => {
      calls++;
      throw new Error('socket hang up');
    };
    await expect(automationChatTurn([{ role: 'user', text: 'hi' }], {}, ctx2, {
      agent: 'claude-code', runner, retries: 0,
    })).rejects.toThrow('socket hang up');
    expect(calls).toBe(1);
  });
});
