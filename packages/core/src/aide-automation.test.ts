// packages/core/src/aide-automation.test.ts
import { describe, it, expect } from 'vitest';
import {
  generateAutomationQuestions, generateAutomationFollowup,
  synthesizeAutomationBrief, renderBrief,
} from './aide-automation';
import type { AideOptions } from './aide';
import type { AgentRequest, AgentResponse } from './types';

const aide = (output: string): AideOptions => ({
  agent: 'claude-code',
  runner: async (_req: AgentRequest): Promise<AgentResponse> =>
    ({ success: true, output } as AgentResponse),
});

describe('generateAutomationQuestions', () => {
  it('parses questions from Aide JSON', async () => {
    const qs = await generateAutomationQuestions('post AI news daily', 'target: prompt',
      aide('{"questions":[{"id":"q1","question":"Which X account?","why":"needed to post"}]}'));
    expect(qs).toEqual([{ id: 'q1', question: 'Which X account?', why: 'needed to post' }]);
  });
  it('returns [] on malformed output', async () => {
    expect(await generateAutomationQuestions('g', 't', aide('not json'))).toEqual([]);
  });
});

describe('generateAutomationFollowup', () => {
  it('returns the follow-up question or null', async () => {
    expect(await generateAutomationFollowup('g', 'Which account?', 'the usual',
      aide('{"followup":"Which one is \\"the usual\\"?"}'))).toBe('Which one is "the usual"?');
    expect(await generateAutomationFollowup('g', 'q', 'a', aide('{"followup":null}'))).toBeNull();
  });
});

describe('synthesizeAutomationBrief', () => {
  it('returns brief + params from Aide JSON', async () => {
    const out = await synthesizeAutomationBrief('g', [{ question: 'q', answer: 'a' }],
      aide('{"brief":"Post to {{account}}.","params":{"account":"@jack"}}'));
    expect(out.brief).toBe('Post to {{account}}.');
    expect(out.params).toEqual({ account: '@jack' });
  });
  it('throws when the Aide returns no brief', async () => {
    await expect(synthesizeAutomationBrief('g', [], aide('{}'))).rejects.toThrow();
  });
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
