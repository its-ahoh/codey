/**
 * Wording for the "the on-device model is still being prepared" state.
 *
 * Split out from the composer so the copy can be tested, because it is the
 * only explanation the user gets for a control that has gone dead for several
 * minutes. Getting it wrong reads as a broken app.
 */

/** Roughly how long a first CoreML compile takes; measured at ~320s on an
 *  M-series Mac for the 632MB turbo variant. Used only for expectation
 *  setting, never as a deadline. */
const TYPICAL_WARM_SECONDS = 300

export function formatWarmElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/**
 * Tooltip for a voice control disabled by a warm in progress.
 *
 * Busy rather than broken, and roughly how long. The typical duration is the
 * part that matters — without it a multi-minute wait reads as a hang.
 */
export function warmTooltip(elapsedSeconds: number): string {
  const elapsed = formatWarmElapsed(elapsedSeconds)
  const mins = Math.round(TYPICAL_WARM_SECONDS / 60)
  return `Preparing the on-device model (${elapsed} so far, usually about ${mins} minutes).`
}

/** Short label for the same state where there is no room for the tooltip. */
export function warmShortLabel(elapsedSeconds: number): string {
  return `Preparing model… ${formatWarmElapsed(elapsedSeconds)}`
}
