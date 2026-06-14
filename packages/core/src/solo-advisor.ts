export interface SoloAdvisorInput {
  /** The user's request for the current turn. */
  task: string;
  /** The stuck agent's reply text (preamble before the [ASK_ADVISOR] marker). */
  stuckOutput: string;
  /** The reason the agent gave after [ASK_ADVISOR]:. */
  reason: string;
}

export interface SoloAdvisorFollowupInput {
  /** The user's request for the current turn. */
  task: string;
  /** The stuck agent's reply text (preamble before the [ASK_ADVISOR] marker). */
  stuckOutput: string;
  /** The reason the agent gave after [ASK_ADVISOR]:. */
  reason: string;
  /** The advisor model's plain-text guidance. */
  guidance: string;
}

/**
 * Prompt for the stronger advisor model when a single agent is stuck. The
 * advisor gives plain-text guidance only — it never writes code (the original
 * agent stays in the driver's seat and applies the advice).
 */
export function buildSoloAdvisorPrompt(input: SoloAdvisorInput): string {
  return [
    '# Advisor (single-agent escalation)',
    '## Role',
    'You are a senior advisor. Another coding agent got stuck on a task and needs your guidance.',
    'Give concrete, actionable guidance to unblock it. Do NOT write code or full solutions — the other agent will implement. Be specific about the approach, what to check, and likely causes.',
    '## Task the agent is working on',
    input.task,
    "## The agent's latest attempt",
    input.stuckOutput || '(no output captured)',
    '## Where it says it is stuck',
    input.reason,
    '## Your guidance',
    'Respond with a short, direct set of next steps (a few sentences or a tight bullet list). No preamble.',
  ].join('\n\n');
}

/**
 * Follow-up prompt that re-runs the original agent with the advisor's guidance
 * injected. Bootstraps fresh (no session resume) so it works for every agent;
 * the agent's prior attempt and the guidance are both included inline.
 */
export function buildSoloAdvisorFollowupPrompt(input: SoloAdvisorFollowupInput): string {
  return [
    `[Respond to this new user message]\n${input.task}`,
    `[Your previous attempt]\n${input.stuckOutput || '(none)'}`,
    `[You reported being stuck: ${input.reason}]`,
    `[A senior advisor reviewed your situation and gave this guidance — follow it to continue and complete the task]\n${input.guidance}`,
    'Continue the task now. Only emit `[ASK_ADVISOR]: <reason>` again if you are still genuinely blocked after applying this guidance.',
  ].join('\n\n');
}
