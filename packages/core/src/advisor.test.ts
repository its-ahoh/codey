import { describe, it, expect } from 'vitest';
import { runAdvisor, buildAdvisorPrompt, AdvisorInput, AdvisorRunner } from './advisor';
import { AgentRequest, AgentResponse } from './types';

function makeRunner(replies: string[]): AdvisorRunner {
  let i = 0;
  return async (_req: AgentRequest): Promise<AgentResponse> => {
    const output = replies[Math.min(i, replies.length - 1)];
    i++;
    return { success: true, output, agent: 'claude-code' } as AgentResponse;
  };
}

function failingRunner(error: string): AdvisorRunner {
  return async () => ({ success: false, output: '', error, agent: 'claude-code' } as AgentResponse);
}

const baseInput: AdvisorInput = {
  task: 'Audit and improve the auth flow',
  members: [
    { name: 'architect', hint: 'Designs systems' },
    { name: 'reviewer', hint: 'Critiques designs' },
  ],
  history: [],
  lastBot: null,
  lastOutput: null,
};

function reply(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    summary_of_last: '', next: null, instruction: '', reason: 'r', done: false, ...overrides,
  });
}

describe('runAdvisor routing', () => {
  it('picks the first bot on the opening turn', async () => {
    const runner = makeRunner([reply({
      next: 'architect', instruction: 'Draft the auth flow', reason: 'Architect should start',
    })]);

    const turn = await runAdvisor(baseInput, { agent: 'claude-code', runner });

    expect(turn.fallback).toBe(false);
    expect(turn.next).toBe('architect');
    expect(turn.done).toBe(false);
    expect(turn.instruction).toBe('Draft the auth flow');
    expect(turn.summary_of_last).toBe('');
  });

  it('hands off to the next bot mid-run and summarises the last one', async () => {
    const input: AdvisorInput = {
      ...baseInput,
      history: [{ bot: 'architect', summary: 'Drafted v1 of auth flow' }],
      lastBot: 'architect',
      lastOutput: 'Here is the v1 draft of the auth flow...',
    };
    const runner = makeRunner([reply({
      summary_of_last: 'Architect drafted v1.', next: 'reviewer', instruction: 'Critique v1',
    })]);

    const turn = await runAdvisor(input, { agent: 'claude-code', runner });

    expect(turn.next).toBe('reviewer');
    expect(turn.summary_of_last).toBe('Architect drafted v1.');
    expect(turn.done).toBe(false);
  });
});

describe('runAdvisor termination', () => {
  it('reports done with a final summary', async () => {
    const runner = makeRunner([reply({
      summary_of_last: 'Reviewer signed off.', done: true,
      final_summary: 'Architect drafted, reviewer approved.',
    })]);

    const turn = await runAdvisor(baseInput, { agent: 'claude-code', runner });

    expect(turn.done).toBe(true);
    expect(turn.next).toBeNull();
    expect(turn.final_summary).toBe('Architect drafted, reviewer approved.');
  });

  it('wraps up in finalize mode', async () => {
    const runner = makeRunner([reply({ reason: 'cap reached', done: true, final_summary: 'Final wrap-up.' })]);

    const turn = await runAdvisor({ ...baseInput, finalize: true }, { agent: 'claude-code', runner });

    expect(turn.done).toBe(true);
    expect(turn.final_summary).toBe('Final wrap-up.');
  });

  it('returns done immediately when the roster is empty', async () => {
    const turn = await runAdvisor(
      { ...baseInput, members: [] },
      { agent: 'claude-code', runner: makeRunner(['{}']) },
    );

    expect(turn.done).toBe(true);
    expect(turn.next).toBeNull();
    expect(turn.fallback).toBe(false);
  });
});

describe('runAdvisor fallback', () => {
  it('falls back when the Advisor names a bot outside the roster', async () => {
    const runner = makeRunner([reply({ next: 'designer', instruction: 'do design' })]);

    expect((await runAdvisor(baseInput, { agent: 'claude-code', runner })).fallback).toBe(true);
  });

  it('falls back with a reason on malformed JSON', async () => {
    const turn = await runAdvisor(baseInput, { agent: 'claude-code', runner: makeRunner(['not json at all']) });

    expect(turn.fallback).toBe(true);
    expect(turn.fallbackReason?.length).toBeGreaterThan(0);
  });

  it('falls back and surfaces the runner error', async () => {
    const turn = await runAdvisor(baseInput, { agent: 'claude-code', runner: failingRunner('boom') });

    expect(turn.fallback).toBe(true);
    expect(turn.fallbackReason).toContain('boom');
  });

  it('falls back on next:null without done — an invalid combination', async () => {
    const turn = await runAdvisor(baseInput, { agent: 'claude-code', runner: makeRunner([reply({})]) });

    expect(turn.fallback).toBe(true);
  });
});

describe('scenario-specific JSON', () => {
  it('normalizes a compact routing response without default fields', async () => {
    const turn = await runAdvisor(baseInput, { agent: 'claude-code', runner: makeRunner([
      JSON.stringify({ next: 'architect', instruction: 'Draft a migration plan', reason: 'Design first' }),
    ]) });
    expect(turn).toMatchObject({ next: 'architect', instruction: 'Draft a migration plan',
      reason: 'Design first', done: false, summary_of_last: '', fallback: false });
  });

  it('retains revision evidence and concrete instructions', async () => {
    const turn = await runAdvisor({ ...baseInput, lastBot: 'reviewer', lastOutput: 'Migration loses data.' }, {
      agent: 'claude-code', runner: makeRunner([JSON.stringify({ next: 'architect',
        instruction: 'Fix migration data loss and verify rollback.', reason: 'Revision needed',
        summary_of_last: 'Reviewer found migration data loss.' })]),
    });
    expect(turn).toMatchObject({ done: false, fallback: false, next: 'architect',
      summary_of_last: 'Reviewer found migration data loss.', instruction: 'Fix migration data loss and verify rollback.' });
  });

  it('distinguishes compact escalation from task completion', async () => {
    const turn = await runAdvisor({ ...baseInput,
      pendingQuestion: { bot: 'architect', question: 'Which private tenant?' } }, {
      agent: 'claude-code', runner: makeRunner(['{"done":true,"escalate_to_user":true,"reason":"Only the user knows"}']),
    });
    expect(turn).toMatchObject({ done: true, escalateToUser: true, next: null, fallback: false });
    expect(turn.final_summary).toBeUndefined();
  });

  it('routes a pending question to a teammate with compact fields', async () => {
    const turn = await runAdvisor({ ...baseInput,
      pendingQuestion: { bot: 'architect', question: 'Does the migration pass review?' } }, {
      agent: 'claude-code', runner: makeRunner(['{"next":"reviewer","instruction":"Verify the migration","reason":"Reviewer can check"}']),
    });
    expect(turn).toMatchObject({ done: false, next: 'reviewer', fallback: false });
    expect(turn.escalateToUser).not.toBe(true);
  });

  it('accepts a final summary without routing placeholders', async () => {
    const turn = await runAdvisor({ ...baseInput, finalize: true }, {
      agent: 'claude-code', runner: makeRunner(['{"done":true,"final_summary":"Draft prepared; review still pending."}']),
    });
    expect(turn).toMatchObject({ done: true, next: null, instruction: '', fallback: false,
      final_summary: 'Draft prepared; review still pending.' });
  });
});


describe('Advisor prompt scope', () => {
  it('omits irrelevant response fields on the opening turn', () => {
    const prompt = buildAdvisorPrompt(baseInput);
    expect(prompt).not.toContain('summary_of_last');
    expect(prompt).not.toContain('escalate_to_user');
    expect(prompt).toContain('instruction');
    expect(prompt).toContain('reason');
    expect(prompt).toContain('explicit assignments');
  });

  it('preserves revision, clarification, and evidence rules after a worker runs', () => {
    const prompt = buildAdvisorPrompt({ ...baseInput, lastBot: 'architect', lastOutput: '',
      userClarification: { bot: 'architect', question: 'Which tenant?', answer: 'Staging' } });
    expect(prompt).toContain('summary_of_last');
    expect(prompt).toContain('Loop back for revisions');
    expect(prompt).toContain('User answered: Staging');
    expect(prompt).not.toContain('escalate_to_user');
  });

  it('does not invite completion while a question is pending', () => {
    const prompt = buildAdvisorPrompt({ ...baseInput,
      pendingQuestion: { bot: 'architect', question: 'Which tenant?' } });
    expect(prompt).toContain('escalate_to_user');
    expect(prompt).not.toContain('final_summary');
    expect(prompt).toContain('This pauses the task');
    expect(prompt).toContain('only the user knows the required information, escalate directly');
  });
});
