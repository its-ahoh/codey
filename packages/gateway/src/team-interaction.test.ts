import { describe, expect, it } from 'vitest';
import { parseAskUser } from '@codey/core';
import { Codey } from './gateway';
import { teamInteractionResponse } from './team-interaction';

describe('team interaction responses', () => {
  it('turns a structured question into a resumable team question', () => {
    const response = teamInteractionResponse({ success: true, output: 'Need input', userQuestion: {
      question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }],
    } } as any);
    expect(parseAskUser(response.output)).toMatchObject({ question: 'Which database?', options: ['SQLite', 'Postgres'] });
  });
  it('pauses on denied tools even when the agent reports failure', () => {
    const response = teamInteractionResponse({ success: false, output: 'Blocked', error: 'Denied',
      permissionDenials: [{ toolName: 'Read' }] } as any);
    expect(response.success).toBe(true);
    expect(parseAskUser(response.output)?.question).toContain('Read');
    expect(response.permissionDenials).toEqual([{ toolName: 'Read' }]);
    expect(response.output).not.toContain('[ASK_USER:choice]');
  });
  it('leaves ordinary failures untouched', () => {
    const response = { success: false, output: '', error: 'crashed' } as any;
    expect(teamInteractionResponse(response)).toBe(response);
  });
});

it('does not fall back to another agent after a permission denial', async () => {
  const denied = { success: false, output: '', permissionDenials: [{ toolName: 'Read' }] };
  const gateway = Object.assign(Object.create(Codey.prototype), {
    getDefaultEffort: () => undefined,
    runAgentWithNetworkRetry: async () => denied,
    getEnabledAgents: () => { throw new Error('Must not start fallback'); },
  });
  expect(await gateway.runWithFallback('claude-code', {})).toBe(denied);
});
