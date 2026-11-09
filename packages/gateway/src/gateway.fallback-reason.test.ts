import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@codey/core';
import { failedTurnText, summarizeFailure } from './gateway';

describe('failed chat turn text', () => {
  it('shows the error when the agent failed before streaming anything', () => {
    expect(failedTurnText({ success: false, output: '', error: 'Authentication required' }, ''))
      .toBe('❌ Error: Authentication required');
  });

  it('does not repeat an "Error:" the agent already wrote', () => {
    expect(failedTurnText({ success: false, output: '', error: 'Error: Authentication required' }, ''))
      .toBe('❌ Error: Authentication required');
  });

  it('keeps what the agent already streamed and still says it failed', () => {
    expect(failedTurnText({ success: false, output: '', error: 'timeout' }, 'partial answer'))
      .toBe('partial answer\n\n❌ Error: timeout');
  });

  it('shows a reply that came with no error in full, not as the error', () => {
    const answer = 'x'.repeat(1000);
    expect(failedTurnText({ success: false, output: answer }, ''))
      .toBe(`${answer}\n\n❌ The agent stopped before finishing.`);
  });

  it('does not repeat an error that the adapter also put in output', () => {
    expect(failedTurnText({ success: false, output: 'Error: Authentication required', error: 'Error: Authentication required' }, ''))
      .toBe('❌ Error: Authentication required');
  });

  it('never leaves the reply blank', () => {
    expect(failedTurnText(undefined, '')).toBe('❌ The agent stopped before finishing.');
    expect(failedTurnText({ success: false, output: '' }, '')).toBe('❌ The agent stopped before finishing.');
  });

  it('lists why each fallback failed', () => {
    expect(failedTurnText({
      success: false, output: '', error: 'missing field version',
      fallbackFailures: [{ agent: 'cursor(auto)', reason: 'Authentication required' }, { agent: 'codex(gpt-5)' }],
    }, '')).toBe('❌ Error: missing field version\n\nFallbacks also failed:\n- cursor(auto): Authentication required\n- codex(gpt-5)');
  });
});

describe('fallback reason summary', () => {
  it('prefers the adapter error over the raw output', () => {
    const response: AgentResponse = { success: false, output: 'noisy stdout', error: 'model overloaded' };
    expect(summarizeFailure(response)).toBe('model overloaded');
  });

  it('falls back to the output when there is no error field', () => {
    expect(summarizeFailure({ success: false, output: '  exited with code 1  ' })).toBe('exited with code 1');
  });

  it('has nothing to report when the failure carried no text', () => {
    expect(summarizeFailure({ success: false, output: '' })).toBeUndefined();
  });

  it('truncates a long failure so the popup stays readable', () => {
    const reason = summarizeFailure({ success: false, output: 'x'.repeat(900) })!;
    expect(reason.length).toBeLessThanOrEqual(401);
    expect(reason.endsWith('…')).toBe(true);
  });
});
