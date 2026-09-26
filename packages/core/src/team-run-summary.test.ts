import { describe, expect, it } from 'vitest';
import { buildTeamRunSummary, finalizeTeamRunSummary } from './team-run-summary';
import type { ChatMessage } from './types/chat';

const bot = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({
  id,
  role: 'assistant',
  content: '',
  timestamp: 1,
  teamTurnId: 'tt1',
  bot: 'bot',
  step: 1,
  ...extra,
});

describe('buildTeamRunSummary', () => {
  it('uses terminal fields instead of classifying prose', () => {
    const summary = buildTeamRunSummary([
      bot('done', { botStatus: 'done', content: 'Implemented the requested change.' }),
      bot('resolved-pause', { step: 4, botStatus: 'done', content: 'Choose a target', botSummaryExcluded: true }),
      bot('failed', { step: 2, botStatus: 'failed', content: 'This prose says success.', botFailureReason: 'Build exited with code 2' }),
      bot('ask', { step: 3, botStatus: 'askedUser', content: 'Unstructured output', botNextUserAction: { text: 'Choose a deployment target', options: ['A', 'B'] } }),
    ], 123);

    expect(summary.completed).toEqual([{ bot: 'bot', step: 1, text: 'Implemented the requested change.' }]);
    expect(summary.failures).toEqual([{ bot: 'bot', step: 2, text: 'Build exited with code 2' }]);
    expect(summary.nextUserActions).toEqual([{ bot: 'bot', step: 3, text: 'Choose a deployment target' }]);
    expect(summary.finalizedAt).toBe(123);
  });

  it('does not finalize running messages or infer actions from their content', () => {
    const messages = [
      bot('running', { botStatus: 'running', content: 'Please choose production.' }),
    ];
    const summary = buildTeamRunSummary(messages, 1);
    expect(summary.completed).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.nextUserActions).toEqual([]);
    expect(finalizeTeamRunSummary(messages, 1)).toBeNull();
  });

  it('finalizes only after all bots have terminal states', () => {
    const messages = [
      bot('done', { botStatus: 'done', content: 'Finished.' }),
      bot('failed', { step: 2, botStatus: 'failed', botFailureReason: 'Build failed' }),
    ];
    expect(finalizeTeamRunSummary(messages, 10)?.finalizedAt).toBe(10);
  });

  it('does not let unselected roster placeholders block finalization', () => {
    const messages = [
      bot('done', { botStatus: 'done', content: 'Finished.' }),
      bot('pending', { step: 2, botStatus: 'pending' }),
    ];
    expect(finalizeTeamRunSummary(messages, 10)?.completed).toEqual([
      { bot: 'bot', step: 1, text: 'Finished.' },
    ]);
  });
});
