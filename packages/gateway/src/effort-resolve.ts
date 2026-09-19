import type { ThinkingEffort } from '@codey/core';

/**
 * Reasoning-effort precedence: chat override > per-agent
 * global default. Mirrors the model chain in ChatTab's `effectiveModel`.
 * `undefined` propagates as "pass no flag".
 */
export function resolveEffort(tiers: {
  chat?: ThinkingEffort;
  global?: ThinkingEffort;
}): ThinkingEffort | undefined {
  return tiers.chat ?? tiers.global;
}
