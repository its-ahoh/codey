import { PendingTeamState, parseAsk } from '@codey/core';

export function stripAskMarker(output: string): string {
  const ask = parseAsk(output);
  return ask ? ask.preamble : output;
}

export interface QuestionRender {
  text: string;
  choices?: string[];
}

/** The question card a paused worker sends. It carries only the question
 *  and its options: a worker's reasoning before the question is that
 *  worker's own message, not part of the card. */
export function renderQuestion(
  workerName: string,
  question: string,
  options?: string[],
): QuestionRender {
  const intro = `❓ **${workerName}** needs your input:`;
  const footer = options && options.length > 0
    ? '_Tap an option below, or type your own answer._'
    : '_Reply with your answer to continue, or send a slash command to cancel._';
  const text = [intro, question, footer].join('\n\n');
  return options && options.length > 0 ? { text, choices: options } : { text };
}

/** Notice shown when a slash command arrives while a team is paused. */
export function renderCancelNotice(pending: PendingTeamState): string {
  return `Cancelled paused team \`${pending.teamName}\` (was waiting on: ${pending.question}).`;
}
