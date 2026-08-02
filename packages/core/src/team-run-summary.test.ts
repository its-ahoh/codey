import { describe, expect, it } from 'vitest';
import { buildTeamRunSummary, finalizeTeamRunSummary } from './team-run-summary';
import type { ChatMessage } from './types/chat';

const worker = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({
  id,
  role: 'assistant',
  content: '',
  timestamp: 1,
  teamTurnId: 'tt1',
  worker: 'worker',
  step: 1,
  ...extra,
});

describe('buildTeamRunSummary', () => {
  it('uses terminal fields instead of classifying prose', () => {
    const summary = buildTeamRunSummary([
      worker('done', { workerStatus: 'done', content: 'Implemented the requested change.' }),
      worker('resolved-pause', { step: 4, workerStatus: 'done', content: 'Choose a target', workerSummaryExcluded: true }),
      worker('failed', { step: 2, workerStatus: 'failed', content: 'This prose says success.', workerFailureReason: 'Build exited with code 2' }),
      worker('ask', { step: 3, workerStatus: 'askedUser', content: 'Unstructured output', workerNextUserAction: { text: 'Choose a deployment target', options: ['A', 'B'] } }),
    ], 123);

    expect(summary.completed).toEqual([{ worker: 'worker', step: 1, text: 'Implemented the requested change.' }]);
    expect(summary.failures).toEqual([{ worker: 'worker', step: 2, text: 'Build exited with code 2' }]);
    expect(summary.nextUserActions).toEqual([{ worker: 'worker', step: 3, text: 'Choose a deployment target' }]);
    expect(summary.finalizedAt).toBe(123);
  });

  it('does not finalize running messages or infer actions from their content', () => {
    const messages = [
      worker('running', { workerStatus: 'running', content: 'Please choose production.' }),
    ];
    const summary = buildTeamRunSummary(messages, 1);
    expect(summary.completed).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.nextUserActions).toEqual([]);
    expect(finalizeTeamRunSummary(messages, 1)).toBeNull();
  });

  it('finalizes only after all workers have terminal states', () => {
    const messages = [
      worker('done', { workerStatus: 'done', content: 'Finished.' }),
      worker('failed', { step: 2, workerStatus: 'failed', workerFailureReason: 'Build failed' }),
    ];
    expect(finalizeTeamRunSummary(messages, 10)?.finalizedAt).toBe(10);
  });
});
