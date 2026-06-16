import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, runJudge, JudgeInput } from './judge';
import { AgentResponse } from './types';

function input(): JudgeInput {
  return {
    task: 'Add a feature',
    worker: 'reviewer',
    workerOutput: 'I checked the code; tests fail.',
    blackboardSummary: '',
    edges: [
      { id: 'e3', condition: 'work incomplete', targetWorker: 'coder' },
      { id: 'e4', condition: undefined, targetWorker: '(end)' },
    ],
  };
}

describe('buildJudgePrompt', () => {
  it('lists each edge with its id, condition and target', () => {
    const p = buildJudgePrompt(input());
    expect(p).toContain('e3');
    expect(p).toContain('work incomplete');
    expect(p).toContain('coder');
  });
});

describe('buildJudgePrompt — decision question', () => {
  it('renders the decision question and yes/no edges', () => {
    const prompt = buildJudgePrompt({
      task: 'ship it',
      worker: 'coder',
      workerOutput: 'all green',
      blackboardSummary: '',
      question: 'Did the tests pass?',
      edges: [
        { id: 'yes', condition: 'yes', targetWorker: '(end)' },
        { id: 'no', condition: 'no', targetWorker: 'coder' },
      ],
    });
    expect(prompt).toContain('Did the tests pass?');
    expect(prompt).toContain('id="yes"');
    expect(prompt).toContain('id="no"');
  });

  it('omits the decision section when no question is given', () => {
    const prompt = buildJudgePrompt({
      task: 't', worker: 'w', workerOutput: 'o', blackboardSummary: '',
      edges: [{ id: 'e1', condition: 'tests pass', targetWorker: 'reviewer' }],
    });
    expect(prompt).not.toContain('## Decision');
  });
});

describe('runJudge', () => {
  it('returns the chosen edge id and reason from JSON output', async () => {
    const runner = async (): Promise<AgentResponse> =>
      ({ success: true, output: '{"edge_id":"e3","reason":"tests fail"}' } as AgentResponse);
    const d = await runJudge(input(), { agent: 'claude-code', runner });
    expect(d.edgeId).toBe('e3');
    expect(d.reason).toBe('tests fail');
    expect(d.fallback).toBe(false);
  });

  it('falls back when the runner fails', async () => {
    const runner = async (): Promise<AgentResponse> =>
      ({ success: false, output: '', error: 'boom' } as AgentResponse);
    const d = await runJudge(input(), { agent: 'claude-code', runner });
    expect(d.fallback).toBe(true);
    expect(d.edgeId).toBeNull();
  });
});
