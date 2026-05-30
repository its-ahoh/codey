/**
 * Cheap, dependency-free token estimator.
 *
 * ~4 chars per token is a reasonable approximation across English and code.
 * Used by memory + context managers for budget tracking — not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
