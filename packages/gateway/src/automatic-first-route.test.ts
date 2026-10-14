import { describe, it, expect, vi } from 'vitest';
import { type AdvisorInput } from '@codey/core';
import { canUseAideForFirstRoute, routeAutomaticFirst } from './automatic-first-route';

const input: AdvisorInput = { task: 'Explain a hash table.', members: [
  { name: 'coder', hint: 'Programming explanations' }, { name: 'writer', hint: 'Translations' },
], history: [], lastBot: null, lastOutput: null };

describe('automatic first-route admission', () => {
  it.each(['Explain a hash table.', 'Please translate this phrase: hello.', '请解释哈希表', '什么是闭包？'])('admits simple requests: %s', task => { // lint-allow-non-english: Chinese routing patterns and synthetic multilingual cases.
    expect(canUseAideForFirstRoute({ ...input, task })).toBe(true);
  });
  it.each(['Implement search.', 'Explain the cache, then fix it.', '请解释问题然后修复', // lint-allow-non-english: Chinese routing patterns and synthetic multilingual cases.
    'Review the schema.', 'Compare database options.', 'Explain this to the whole team.',
    'Explain this\nand edit the file.', 'Explain ' + 'x'.repeat(500), '@writer explain closures'])('keeps complex/unknown requests on Advisor: %s', task => {
    expect(canUseAideForFirstRoute({ ...input, task })).toBe(false);
  });
  it('does not admit later turns, questions, resume, or finalization', () => {
    for (const extra of [{ history: [{ bot: 'coder', summary: 'Done' }] }, { lastBot: 'coder' },
      { lastOutput: '' }, { pendingQuestion: { bot: 'coder', question: 'Where?' } },
      { userClarification: { bot: 'coder', question: 'Where?', answer: 'Here' } }, { finalize: true }]) {
      expect(canUseAideForFirstRoute({ ...input, ...extra })).toBe(false);
    }
  });
});

describe('Aide first-route response', () => {
  it('preserves the original request verbatim as the worker instruction', async () => {
    const runner = vi.fn().mockResolvedValue({ success: true, output: '{"next":"coder","reason":"Knows programming"}' });
    expect(await routeAutomaticFirst(input, { agent: 'codex', runner })).toMatchObject({
      next: 'coder', instruction: input.task, reason: 'Knows programming', done: false, fallback: false,
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it.each(['{"route":"advisor"}', '{"next":"unknown","reason":"r"}',
    '{"next":"coder"}', '{"next":"coder","reason":" "}', 'not json'])('returns to Advisor without retry for %s', async output => {
    const runner = vi.fn().mockResolvedValue({ success: true, output });
    expect(await routeAutomaticFirst(input, { agent: 'codex', runner })).toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('does not invoke Aide on a complex task or after cancellation', async () => {
    const runner = vi.fn();
    expect(await routeAutomaticFirst({ ...input, task: 'Fix the cache.' }, { agent: 'codex', runner })).toBeNull();
    expect(await routeAutomaticFirst(input, { agent: 'codex', runner, signal: AbortSignal.abort() })).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
  it('returns to Advisor after a runner failure', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await routeAutomaticFirst(input, { agent: 'codex', runner })).toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
