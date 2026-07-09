import type { TaskBrief } from '../types';

type Status = TaskBrief['state']['status'];

/** Button visibility/enablement: visible when the agent has fulfilled the task
 *  (waiting on the user, or done); enabled only when there are commits to PR. */
export function createPrButtonState(status: Status, branchAhead: boolean): { show: boolean; enabled: boolean } {
  const show = status === 'waiting' || status === 'done';
  return { show, enabled: show && branchAhead };
}

/** Default PR title: trimmed commit subject, falling back to the branch name. */
export function defaultPrTitle(commitSubject: string | undefined, branch: string): string {
  const s = (commitSubject ?? '').trim();
  return s || branch;
}
