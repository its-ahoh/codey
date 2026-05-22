import { describe, it, expect } from 'vitest';
import { buildAdvisorPrompt, runAdvisor } from './advisor';
import { AgentRequest, AgentResponse } from './types';

describe('buildAdvisorPrompt userClarification', () => {
  it('omits the section when not provided', () => {
    const out = buildAdvisorPrompt({
      task: 'do thing',
      members: [{ name: 'a', hint: 'hint' }],
      history: [],
      lastWorker: null,
      lastOutput: null,
    });
    expect(out).not.toContain('## User Clarification');
  });

  it('renders the section when provided', () => {
    const out = buildAdvisorPrompt({
      task: 'do thing',
      members: [{ name: 'a', hint: 'hint' }],
      history: [],
      lastWorker: 'a',
      lastOutput: '[ASK_USER]: which db?',
      userClarification: { worker: 'a', question: 'which db?', answer: 'postgres' },
    });
    expect(out).toContain('## User Clarification');
    expect(out).toContain('Worker a asked: which db?');
    expect(out).toContain('User answered: postgres');
  });
});

describe('buildAdvisorPrompt pendingQuestion', () => {
  it('renders Pending Question section when provided', () => {
    const out = buildAdvisorPrompt({
      task: 'do thing',
      members: [{ name: 'a', hint: 'hint' }, { name: 'b', hint: 'reviewer' }],
      history: [],
      lastWorker: 'a',
      lastOutput: '[ASK_USER]: should we bump the version?',
      pendingQuestion: { worker: 'a', question: 'should we bump the version?' },
    });
    expect(out).toContain('## Pending Question');
    expect(out).toContain('Worker a asked: should we bump the version?');
    expect(out).toContain('escalate_to_user');
  });
});

describe('runAdvisor escalation', () => {
  function makeRunner(reply: string) {
    return async (_req: AgentRequest): Promise<AgentResponse> =>
      ({ success: true, output: reply, agent: 'claude-code' } as AgentResponse);
  }

  it('returns escalateToUser when arbitrating and Manager sets escalate_to_user', async () => {
    const turn = await runAdvisor(
      {
        task: 't',
        members: [{ name: 'a', hint: 'h' }],
        history: [],
        lastWorker: 'a',
        lastOutput: '[ASK_USER]: q?',
        pendingQuestion: { worker: 'a', question: 'q?' },
      },
      {
        agent: 'claude-code',
        runner: makeRunner(
          JSON.stringify({
            summary_of_last: 'asked a question',
            next: null,
            instruction: '',
            reason: 'only the user can answer',
            done: true,
            escalate_to_user: true,
          }),
        ),
      },
    );
    expect(turn.fallback).toBe(false);
    expect(turn.escalateToUser).toBe(true);
    expect(turn.done).toBe(true);
  });

  it('routes to a teammate when arbitrating and Manager sets next', async () => {
    const turn = await runAdvisor(
      {
        task: 't',
        members: [{ name: 'a', hint: 'h' }, { name: 'b', hint: 'reviewer' }],
        history: [],
        lastWorker: 'a',
        lastOutput: '[ASK_USER]: did B finish?',
        pendingQuestion: { worker: 'a', question: 'did B finish?' },
      },
      {
        agent: 'claude-code',
        runner: makeRunner(
          JSON.stringify({
            summary_of_last: 'asked',
            next: 'b',
            instruction: 'did B finish?',
            reason: 'b can answer',
            done: false,
          }),
        ),
      },
    );
    expect(turn.fallback).toBe(false);
    expect(turn.escalateToUser).toBeFalsy();
    expect(turn.next).toBe('b');
    expect(turn.instruction).toBe('did B finish?');
  });
});
