import { PendingTeamState, parseAsk } from '@codey/core';

export function stripAskMarker(output: string): string {
  const ask = parseAsk(output);
  return ask ? ask.preamble : output;
}

export interface QuestionRender {
  text: string;
  choices?: string[];
}

export function renderQuestion(
  workerName: string,
  preamble: string,
  question: string,
  options?: string[],
  truncate = 500,
): QuestionRender {
  const head = preamble.trim();
  const trimmedHead = head.length > truncate ? head.substring(0, truncate) + '…' : head;
  const intro = `❓ **${workerName}** needs your input:`;
  const body = `${question}`;
  const footer = options && options.length > 0
    ? '_Tap an option below, or type your own answer._'
    : '_Reply with your answer to continue, or send a slash command to cancel._';
  const text = [trimmedHead, intro, body, footer].filter(Boolean).join('\n\n');
  return options && options.length > 0 ? { text, choices: options } : { text };
}

/** Legacy string-returning helper kept for callers that don't yet pass choices through. */
export function renderQuestionMessage(
  workerName: string,
  preamble: string,
  question: string,
  truncate = 500,
): string {
  return renderQuestion(workerName, preamble, question, undefined, truncate).text;
}

/** Notice shown when a slash command arrives while a team is paused. */
export function renderCancelNotice(pending: PendingTeamState): string {
  return `Cancelled paused team \`${pending.teamName}\` (was waiting on: ${pending.question}).`;
}
