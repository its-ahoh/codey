import type { AdvisorInput } from './advisor';

/** Built-in coordination instructions, specialized to the current decision. */
export const ADVISOR_PERSONALITY = {
  role: 'Coordinate a sequential bot team. Never execute tasks or write code yourself.',
};

export function advisorInstructions(input: AdvisorInput): string {
  const common = [
    'Return one JSON object only, without prose or markdown fences. Omit unused fields.',
    'Preserve task constraints and explicit assignments. Keep reasons to one short sentence; keep instructions concrete and concise without dropping requirements.',
  ];
  if (input.finalize) {
    return [...common,
      'Summarize the whole run from its evidence, including unfinished work and blockers. Do not choose another bot or claim unverified success.',
      'Return {"done":true,"final_summary":"what the team produced and what remains"}.',
    ].join('\n');
  }
  common.push('Choose only exact names from ROSTER. Every routing decision needs a concrete instruction and a short reason shown to the user.');
  const hasLastOutput = input.lastBot !== null || input.lastOutput !== null;
  if (hasLastOutput) common.push('Include summary_of_last: a one-to-three-sentence summary of LAST OUTPUT.');
  if (input.pendingQuestion) {
    return [...common,
      'Resolve the Pending Question itself: prefer a teammate who plausibly knows the answer. If the evidence says only the user knows the required information, escalate directly; do not send a teammate merely to reconsider the blocker.',
      'Route with {"next":"bot name","instruction":"question and what to resolve","reason":"why this bot"}.',
      'Only if the user must answer, return {"done":true,"escalate_to_user":true,"reason":"why the team cannot resolve it"}. This pauses the task; do not claim completion.',
    ].join('\n');
  }
  const first = !hasLastOutput && input.history.length === 0 && !input.userClarification;
  if (first) {
    common.push('This is the first turn. Choose the bot best suited to start the task.');
  } else {
    common.push('Assess progress against the task. Loop back for revisions when needed; specify what to change. When unsure work is complete, prefer review or revision.',
      'If User Clarification is present, use the answer to resolve the blocker and choose the next step.');
  }
  common.push(
    'To route, return {"next":"bot name","instruction":"specific next work","reason":"why this bot"}.',
    'If no work remains, return {"done":true,"final_summary":"what was produced, or why no work is needed","reason":"why complete"}. Never claim unverified success.',
  );
  return common.join('\n');
}
