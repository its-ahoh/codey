import { PendingTeamState } from '@codey/core';

/** User-visible message rendered when a team pauses on a worker question. */
export function renderQuestionMessage(
  workerName: string,
  preamble: string,
  question: string,
  truncate = 500,
): string {
  const head = preamble.trim();
  const trimmedHead = head.length > truncate ? head.substring(0, truncate) + '…' : head;
  const intro = `❓ **${workerName}** needs your input:`;
  const body = `${question}`;
  const footer = '_Reply with your answer to continue, or send a slash command to cancel._';
  return [trimmedHead, intro, body, footer].filter(Boolean).join('\n\n');
}

/** Notice shown when a slash command arrives while a team is paused. */
export function renderCancelNotice(pending: PendingTeamState): string {
  return `Cancelled paused team \`${pending.teamName}\` (was waiting on: ${pending.question}).`;
}
