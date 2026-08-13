import { describe, it, expect, vi } from 'vitest';
import { runAide, runAideJson, isConfigError } from './aide';
import type { AideOptions } from './aide';
import type { AgentRequest, AgentResponse } from './types';

/** Aide options whose runner is a caller-supplied mock. Retries are instant
 *  so tests never wait on the real 1s backoff. */
const opts = (runner: AideOptions['runner'], over: Partial<AideOptions> = {}): AideOptions => ({
  agent: 'claude-code', runner, retryDelayMs: 0, ...over,
});

const ok = (output: string): AgentResponse => ({ success: true, output } as AgentResponse);

describe('isConfigError', () => {
  it('flags configuration failures a retry cannot fix', () => {
    expect(isConfigError('Request failed with status 402')).toBe(true);
    expect(isConfigError('unknown model: deepseek-v4-pro')).toBe(true);
    expect(isConfigError('Invalid API key provided')).toBe(true);
  });
  it('does not flag transient failures', () => {
    expect(isConfigError('The operation was aborted')).toBe(false);
    expect(isConfigError('socket hang up')).toBe(false);
  });
});

describe('runAide retries', () => {
  it('does not retry by default', async () => {
    const runner = vi.fn(async (_r: AgentRequest) => { throw new Error('socket hang up'); });
    await expect(runAide('p', opts(runner))).rejects.toThrow('socket hang up');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the second attempt', async () => {
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(ok('  second  '));
    const out = await runAide('p', opts(runner as any, { retries: 1 }));
    expect(out).toBe('second');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('does not retry a configuration failure', async () => {
    const runner = vi.fn(async (_r: AgentRequest) => { throw new Error('HTTP 402 payment required'); });
    await expect(runAide('p', opts(runner, { retries: 3 }))).rejects.toThrow('402');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the caller aborts', async () => {
    const ac = new AbortController();
    const runner = vi.fn(async (_r: AgentRequest): Promise<AgentResponse> => {
      ac.abort();
      throw new Error('socket hang up');
    });
    await expect(runAide('p', opts(runner, { retries: 2, signal: ac.signal }))).rejects.toThrow();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not wait out the backoff when the caller aborts mid-gap', async () => {
    const ac = new AbortController();
    const runner = vi.fn(async (_r: AgentRequest): Promise<AgentResponse> => {
      throw new Error('socket hang up');
    });
    const BACKOFF_MS = 500;
    setTimeout(() => ac.abort(), 20);
    const started = Date.now();
    await expect(
      runAide('p', opts(runner, { retries: 1, retryDelayMs: BACKOFF_MS, signal: ac.signal }))
    ).rejects.toThrow();
    const elapsed = Date.now() - started;
    expect(runner).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(BACKOFF_MS - 100);
  });
});

describe('runAideJson', () => {
  it('retries unparseable output, then returns the parsed object', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(ok('sorry, no JSON here'))
      .mockResolvedValueOnce(ok('{"reply":"hi"}'));
    const res = await runAideJson('p', opts(runner as any, { retries: 1 }));
    expect(res).toEqual({ reply: 'hi' });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('still returns null when every attempt is unparseable', async () => {
    const runner = vi.fn(async (_r: AgentRequest) => ok('nope'));
    expect(await runAideJson('p', opts(runner, { retries: 1 }))).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
