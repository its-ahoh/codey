import { describe, it, expect } from 'vitest';
import { buildParallelManagerPrompt, parseParallelManagerTurn } from './parallel-advisor';

describe('buildParallelManagerPrompt', () => {
  it('includes topic, opinions, pending asks, and the word JSON', () => {
    const prompt = buildParallelManagerPrompt({
      topic: 'choose-stack',
      summary: 'so far we lean rust',
      opinions: [
        { name: 'alice', text: 'rust is fast' },
        { name: 'bob', text: 'go is simple' },
      ],
      pendingAsks: [{ worker: 'alice', question: 'what budget?' }],
      idleMs: 1234,
      revision: 3,
    });
    expect(prompt).toContain('choose-stack');
    expect(prompt).toContain('rust is fast');
    expect(prompt).toContain('go is simple');
    expect(prompt).toContain('what budget?');
    expect(prompt).toContain('alice');
    expect(prompt).toContain('JSON');
  });
});

describe('parseParallelManagerTurn', () => {
  it('parses a continue action with summary_update and directive', () => {
    const out = parseParallelManagerTurn(
      '{"action":"continue","summary_update":"new sum","directive":"focus on cost","reason":"continuing"}',
    );
    expect(out).toEqual({
      action: 'continue',
      summary_update: 'new sum',
      directive: 'focus on cost',
      reason: 'continuing',
    });
  });

  it('parses ask_user with user_question_choices', () => {
    const out = parseParallelManagerTurn(
      JSON.stringify({
        action: 'ask_user',
        user_question: 'pick one',
        user_question_choices: ['a', 'b'],
        reason: 'pending_question',
      }),
    );
    expect(out).toEqual({
      action: 'ask_user',
      user_question: 'pick one',
      user_question_choices: ['a', 'b'],
      reason: 'pending_question',
    });
  });

  it('parses finalize with final_message', () => {
    const out = parseParallelManagerTurn(
      '{"action":"finalize","final_message":"we agreed","reason":"consensus"}',
    );
    expect(out?.action).toBe('finalize');
    expect(out?.final_message).toBe('we agreed');
    expect(out?.reason).toBe('consensus');
  });

  it('parses terminate with final_message', () => {
    const out = parseParallelManagerTurn(
      '{"action":"terminate","final_message":"off topic","reason":"drift"}',
    );
    expect(out?.action).toBe('terminate');
    expect(out?.final_message).toBe('off topic');
  });

  it('returns null on non-JSON garbage', () => {
    expect(parseParallelManagerTurn('not json at all')).toBeNull();
  });

  it('returns null on unknown action', () => {
    expect(
      parseParallelManagerTurn('{"action":"explode","reason":"continuing"}'),
    ).toBeNull();
  });

  it('returns null when ask_user is missing user_question', () => {
    expect(
      parseParallelManagerTurn('{"action":"ask_user","reason":"pending_question"}'),
    ).toBeNull();
  });

  it('returns null when terminate is missing final_message', () => {
    expect(
      parseParallelManagerTurn('{"action":"terminate","reason":"drift"}'),
    ).toBeNull();
  });
});
