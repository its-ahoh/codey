/** Default expanded state for a ThinkingBlock (user toggle overrides this). */
export function defaultThinkingExpanded(args: { hasAnswer: boolean; isComplete: boolean }): boolean {
  // Live thinking is visible; the moment answer text starts (or the turn ends),
  // collapse it so the answer is what the eye lands on.
  return !args.hasAnswer && !args.isComplete
}
