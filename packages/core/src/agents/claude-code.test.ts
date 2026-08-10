import { describe, it, expect } from 'vitest';
import { classifyClaudeRunResult } from './claude-code';

// The claude CLI reports API-level failures (402 Insufficient Balance, session
// limits, unknown models) as a stream-json `result` event with `is_error: true`
// and the message in `result`. Some of those (session limits, billing errors)
// still exit with code 0, so the adapter must treat the `is_error` flag as the
// authoritative failure signal — otherwise the gateway's runWithFallback chain
// never engages and the user just sees the raw API error as a "success".

describe('classifyClaudeRunResult', () => {
  it('classifies an API error result as failure even when the CLI exits 0', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: 'API Error: 402 Insufficient Balance',
      streamedText: '',
      stderr: '',
      resultIsError: true,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(false);
    expect(cls.error).toContain('402 Insufficient Balance');
  });

  it('keeps a clean result a success', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: 'ok',
      streamedText: '',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(true);
    expect(cls.output).toBe('ok');
  });

  it('falls back to streamed text when there is no result event', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: '',
      streamedText: 'ok',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(true);
    expect(cls.output).toBe('ok');
  });

  it('prefers the API error message over stderr noise for a flagged error', () => {
    const cls = classifyClaudeRunResult({
      code: 1,
      result: 'API Error: 402 Insufficient Balance',
      streamedText: '',
      stderr: '⚠ claude.ai connectors are disabled…',
      resultIsError: true,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(false);
    expect(cls.error).toContain('402 Insufficient Balance');
    expect(cls.error).not.toContain('connectors');
  });

  it('still treats a non-zero exit without an is_error flag as a failure', () => {
    const cls = classifyClaudeRunResult({
      code: 2,
      result: 'partial output',
      streamedText: '',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(false);
    expect(cls.error).toContain('code 2');
  });

  it('keeps an AskUserQuestion result a success', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: '{"question":"Continue?"}',
      streamedText: '',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: true,
    });

    expect(cls.success).toBe(true);
  });
});
