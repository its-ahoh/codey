import { describe, it, expect } from 'vitest';
import { runAdvisor, AdvisorInput, AdvisorRunner } from './advisor';
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
  lastWorker: null,
  lastOutput: null,
};

function reply(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    summary_of_last: '', next: null, instruction: '', reason: 'r', done: false, ...overrides,
  });
}

describe('runAdvisor routing', () => {
  it('picks the first worker on the opening turn', async () => {
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

  it('hands off to the next worker mid-run and summarises the last one', async () => {
    const input: AdvisorInput = {
      ...baseInput,
      history: [{ worker: 'architect', summary: 'Drafted v1 of auth flow' }],
      lastWorker: 'architect',
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
  it('falls back when the Advisor names a worker outside the roster', async () => {
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
