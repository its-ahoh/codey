import type { TaskBrief } from '../types';

type Status = TaskBrief['state']['status'];

/** Button visibility/enablement: visible when the agent has fulfilled the task
 *  (waiting on the user, or done); enabled only when there are commits to PR. */
export function createPrButtonState(status: Status, branchAhead: boolean): { show: boolean; enabled: boolean } {
  const show = status === 'waiting' || status === 'done';
  return { show, enabled: show && branchAhead };
}
