import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@codey/core';
import { isRetryableNetworkFailure, MAX_NETWORK_RETRIES } from './gateway';

const failed = (error: string): AgentResponse => ({ success: false, output: '', error });

describe('network retry classification', () => {
  it('caps retries at five', () => {
    expect(MAX_NETWORK_RETRIES).toBe(5);
  });

  it.each([
    'timeout',
    'Request timed out',
    'read ECONNRESET',
    'getaddrinfo ENOTFOUND api.example.com',
    'fetch failed',
    '503 Service Unavailable',
    '429 Too Many Requests',
  ])('retries transient failure: %s', error => {
    expect(isRetryableNetworkFailure(failed(error))).toBe(true);
  });

  it.each([
    'Permission denied for tool Bash',
    'Unknown model name',
    'API key is missing',
    'Invalid request payload',
  ])('does not retry permanent failure: %s', error => {
    expect(isRetryableNetworkFailure(failed(error))).toBe(false);
  });

  it('never retries a successful response', () => {
    expect(isRetryableNetworkFailure({ success: true, output: 'ok' })).toBe(false);
  });
});
