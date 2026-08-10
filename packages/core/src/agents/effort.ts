import type { ThinkingEffort } from '../types';

/**
 * Per-agent argv for a reasoning-effort level.
 *
 * All three agents take the same five level strings, so these are verbatim
 * passthroughs that differ only in flag syntax. Verified against claude-code
 * 2.1.221, codex v0.145.0 and opencode:
 *
 *   claude-code  --effort <L>                      lenient (warns, uses default)
 *   codex        -c model_reasoning_effort="<L>"   STRICT (API rejects the run)
 *   opencode     --variant <L>                     lenient (silently ignored)
 */
export function claudeEffortArgs(effort?: ThinkingEffort): string[] {
  return effort ? ['--effort', effort] : [];
}

export function codexEffortArgs(effort?: ThinkingEffort): string[] {
  return effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
}

export function opencodeEffortArgs(effort?: ThinkingEffort): string[] {
  return effort ? ['--variant', effort] : [];
}

/** Marker set on a retried request so a degrade can never loop. */
export interface EffortRetryable {
  __effortRetried?: boolean;
}

/**
 * True when a codex run failed *because of* the effort flag it was given.
 *
 * Requires all three markers: the enum-error code, the parameter path, and the
 * exact level this run passed out. The three-way AND is what stops a user
 * prompt that happens to quote this error text from being misread as a degrade
 * signal — all three appearing together, with our own value quoted, is not
 * something arbitrary output produces.
 */
export function isEffortRejection(text: string, passedEffort: string): boolean {
  if (!text) return false;
  return text.includes('invalid_enum_value')
    && text.includes('reasoning.effort')
    // Anchored to "Invalid value: '<L>'" — never a bare `'${passedEffort}'`
    // match. The same error also lists every valid level in a trailing
    // "Supported values are: 'none', 'minimal', 'low', ..." enumeration, so a
    // bare quoted-value check would match on 'low' being *listed as
    // supported* even when the run actually passed and got rejected for
    // 'max'. Caught this via TDD — keep the anchor.
    && text.includes(`Invalid value: '${passedEffort}'`);
}
