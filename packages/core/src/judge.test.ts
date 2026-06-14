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
