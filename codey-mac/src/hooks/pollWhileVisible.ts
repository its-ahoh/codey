/**
 * A `setInterval` that only fires while the window is visible, and catches up
 * the moment it becomes visible again.
 *
 * Codey is a long-lived desktop app that spends most of its life in the
 * background. Several of its polls are not free — a git refresh spawns ~7 `git`
 * subprocesses, a terminal title spawns two `ps` calls — so running them
 * against a hidden window burns battery to compute something nobody can read.
 *
 * Skipping ticks alone would leave stale data on the screen for up to one
 * interval after the user comes back, so visibility also triggers an immediate
 * run. Callers get the same "fresh on screen" guarantee they had before.
 *
 * @param fn        the poll body; run on visibility-restore and on each visible tick
 * @param intervalMs tick period, unchanged from the caller's original interval
 * @returns a cleanup function that clears the timer and removes the listener
 */
export function pollWhileVisible(fn: () => void, intervalMs: number): () => void {
  // `document.visibilityState` is absent in the node test environment and in
  // any non-DOM host; treat that as "always visible" so behaviour there matches
  // the old unconditional interval rather than silently never running.
  const hidden = () => typeof document !== 'undefined' && document.hidden

  const timer = setInterval(() => { if (!hidden()) fn() }, intervalMs)

  const onVisibility = () => { if (!hidden()) fn() }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  return () => {
    clearInterval(timer)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
