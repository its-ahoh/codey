import { describe, expect, it } from 'vitest';
import type { AgentRequest, AgentResponse } from '@codey/core';
import {
  isOwnTimeoutFailure,
  planAgentRetry,
  rebaseForFallbackAgent,
  MAX_TIMEOUT_RESUMES,
} from './gateway';

const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  prompt: 'do the thing',
  agent: 'claude-code',
  ...over,
} as AgentRequest);

const failed = (error: string, over: Partial<AgentResponse> = {}): AgentResponse =>
  ({ success: false, output: '', error, ...over });

describe('own-timeout classification', () => {
  it.each(['Timeout after 15 minutes', 'timeout after 1 minute'])('recognises %s', text => {
    expect(isOwnTimeoutFailure(failed(text))).toBe(true);
  });

  it.each(['Request timed out', 'gateway timeout', '504 Gateway Timeout'])(
    'leaves provider failure alone: %s',
    text => {
      expect(isOwnTimeoutFailure(failed(text))).toBe(false);
    },
  );
});

describe('planAgentRetry', () => {
  it('resumes the started session after our own timeout instead of restarting', () => {
    const original = req({ newSessionId: 'sess-1' });
    const d = planAgentRetry(original, failed('Timeout after 15 minutes', { startedSessionId: 'sess-1' }), 0);
    expect(d.retry).toBe(true);
    expect(d.resumedAfterTimeout).toBe(true);
    expect(d.request.resumeSessionId).toBe('sess-1');
    expect(d.request.newSessionId).toBeUndefined();
    expect(d.request.prompt).not.toBe(original.prompt);
  });

  it('gives up on a timeout that never opened a session', () => {
    expect(planAgentRetry(req({ newSessionId: 'sess-1' }), failed('Timeout after 15 minutes'), 0).retry).toBe(false);
  });

  it('resumes after a timeout only once', () => {
    const r = failed('Timeout after 15 minutes', { startedSessionId: 'sess-1' });
    expect(planAgentRetry(req(), r, MAX_TIMEOUT_RESUMES).retry).toBe(false);
  });

  it('never re-pins a session id the CLI already opened', () => {
    const d = planAgentRetry(
      req({ newSessionId: 'sess-1' }),
      failed('fetch failed', { startedSessionId: 'sess-1' }),
      0,
    );
    expect(d.retry).toBe(true);
    expect(d.request.newSessionId).toBeUndefined();
    expect(d.request.resumeSessionId).toBe('sess-1');
    expect(d.request.prompt).toBe('do the thing');
  });

  it('keeps an unused pinned id on a network retry', () => {
    const d = planAgentRetry(req({ newSessionId: 'sess-1' }), failed('ECONNRESET'), 0);
    expect(d.retry).toBe(true);
    expect(d.request.newSessionId).toBe('sess-1');
    expect(d.request.resumeSessionId).toBeUndefined();
  });

  it('does not retry a permanent failure', () => {
    expect(planAgentRetry(req(), failed('Unknown model name'), 0).retry).toBe(false);
  });
});

describe('rebaseForFallbackAgent', () => {
  it('never hands one agent session id to another agent', () => {
    const out = rebaseForFallbackAgent(
      req({ resumeSessionId: 'claude-sess', newSessionId: undefined }),
      'claude-code',
      'codex',
      failed('boom'),
    );
    expect(out.resumeSessionId).toBeUndefined();
    expect(out.newSessionId).toBeUndefined();
  });

  it('mints a fresh id when retrying claude-code on another model', () => {
    const out = rebaseForFallbackAgent(
      req({ newSessionId: 'sess-1' }),
      'claude-code',
      'claude-code',
      failed('boom', { startedSessionId: 'sess-1' }),
    );
    expect(out.resumeSessionId).toBeUndefined();
    expect(out.newSessionId).toBeTruthy();
    expect(out.newSessionId).not.toBe('sess-1');
  });
});
