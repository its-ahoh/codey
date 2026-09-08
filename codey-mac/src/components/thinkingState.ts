/** Default expanded state for a ThinkingBlock (user toggle overrides this).
 *  One rule for every assistant turn, worker or not: a team member's reply is
 *  an ordinary reply, so it must not get its own thinking behaviour. */
export function defaultThinkingExpanded(args: { hasAnswer: boolean; isComplete: boolean }): boolean {
  // Live thinking is visible; the moment answer text starts (or the turn ends),
  // collapse it so the answer is what the eye lands on.
  return !args.hasAnswer && !args.isComplete
}
