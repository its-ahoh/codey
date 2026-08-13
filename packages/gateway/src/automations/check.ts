// packages/gateway/src/automations/check.ts
import { executionFingerprint } from '@codey/core';
import type { AutomationCheck, AutomationTarget, DryRunVerdict } from '@codey/core';

/** Just enough of an automation (or draft) to know what would execute. */
export interface Executable {
  target?: AutomationTarget;
  brief?: string;
  params?: Record<string, string>;
}

/** A background dry run costs a real agent process, so it is warranted only
 *  when what executes actually changed. `prev` absent = freshly created. */
export function needsRecheck(prev: Executable | undefined, next: Executable): boolean {
  if (!prev) return true;
  return executionFingerprint(prev) !== executionFingerprint(next);
}

/** Map a dry-run verdict onto the automation's persisted advisory field. */
export function verdictToCheck(verdict: DryRunVerdict, at: number): AutomationCheck {
  if (verdict.status === 'clean') return { status: 'clean', at };
  if (verdict.status === 'gaps') return { status: 'gaps', questions: verdict.questions, at };
  return { status: 'error', detail: verdict.message, at };
}
