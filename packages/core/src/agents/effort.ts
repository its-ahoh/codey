import type { AgentRequest, AgentResponse, ThinkingEffort } from '../types';

/**
 * Per-agent argv for a reasoning-effort level.
 *
 * All three agents take the same five level strings, so these are verbatim
 * passthroughs that differ only in flag syntax:
 *
 *   claude-code  --effort <L>                      lenient (warns, uses default)
 *   codex        -c model_reasoning_effort="<L>"   STRICT (API rejects the run)
 *   opencode     --variant <L>                     lenient (silently ignored)
 *
 * None of that comes from published docs — it was probed directly. The versions
 * below are what those observations were made ON, not a minimum requirement:
 * nothing enforces them, and no lower bound has been tested. They are here only
 * so a future reader can tell how stale the observations are and re-probe when
 * something looks wrong.
 *
 *   observed on: claude-code 2.1.221, codex v0.145.0, opencode 1.14.18
 *
 * The leniency column is the load-bearing part. codex being the only strict one
 * is why the degrade-retry below exists and why the other two need no fallback.
 * If a future version makes claude-code or opencode strict, they need the same
 * treatment.
 *
 * opencode's variants are provider-specific (its help cites `high, max,
 * minimal`), so `low`/`xhigh` may not map on every provider. That is safe
 * precisely because it is lenient: an unmapped level is a no-op, not a failure.
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

/**
 * pi takes `--thinking <level>` with off, minimal, low, medium, high, xhigh,
 * max — a superset of ThinkingEffort, so every level we can pass is a level pi
 * documents. That is why this needs no degrade-retry: unlike codex's
 * server-side enum, there is no level we can send that pi has to reject.
 *
 *   pi           --thinking <L>                    documented enum, superset
 *
 * Read from pi's published CLI reference rather than probed, unlike the three
 * above; re-probe if a run ever fails on the flag itself.
 */
export function piEffortArgs(effort?: ThinkingEffort): string[] {
  return effort ? ['--thinking', effort] : [];
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

/** The only part of a request the degrade decision actually reads. */
export type EffortDegradable = Pick<AgentRequest, 'effort'> & EffortRetryable;

/**
 * Whether a finished codex run should be retried once without the effort flag.
 *
 * Three conditions, all required: an effort was actually passed, this isn't
 * already the retry, and the run output is a rejection of *that* level. The
 * type predicate narrows `effort` for the caller, so the retry path can read
 * the attempted level without a non-null assertion.
 */
export function shouldDegradeEffort(
  request: EffortDegradable,
  text: string,
): request is EffortDegradable & { effort: ThinkingEffort } {
  return !!request.effort
    && !request.__effortRetried
    && isEffortRejection(text, request.effort);
}

/**
 * Prepend the "we degraded your effort" notice to a successful retry.
 *
 * A FAILED retry is returned completely untouched: the retry's own error is
 * what the user needs to see, and claiming we reran successfully on top of a
 * failure would be actively misleading.
 */
export function withDegradeNotice(attempted: ThinkingEffort, retried: AgentResponse): AgentResponse {
  if (!retried.success) return retried;
  return {
    ...retried,
    output: `> Effort \`${attempted}\` isn't accepted by the current codex model — reran with the model's default effort.\n\n${retried.output}`,
  };
}
