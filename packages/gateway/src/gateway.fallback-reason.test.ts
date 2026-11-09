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

  it('keeps what the agent already streamed', () => {
    expect(failedTurnText({ success: false, output: '', error: 'timeout' }, 'partial answer')).toBe('partial answer');
  });

  it('stays empty with no response and no reason', () => {
    expect(failedTurnText(undefined, '')).toBe('');
    expect(failedTurnText({ success: false, output: '' }, '')).toBe('');
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
