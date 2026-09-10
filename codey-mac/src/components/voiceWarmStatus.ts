/**
 * Wording for the "the on-device model is still being prepared" state.
 *
 * Split out from the composer so the copy can be tested. Two different states
 * share the word "preparing": a WhisperKit warm blocks the control (minutes of
 * CoreML compile - recording into it would strand the user after they had
 * already spoken), while a streaming warm does not (seconds, so the recording
 * just waits). `warmBlocksPress` decides which, and the copy follows it.
 */

/** Roughly how long a first CoreML compile takes; measured at ~320s on an
 *  M-series Mac for the 632MB turbo variant. Used only for expectation
 *  setting, never as a deadline. */
const TYPICAL_WARM_SECONDS = 300

/** The streaming (Nemotron) models are far smaller and load in seconds, so
 *  quoting WhisperKit's five minutes for them would be its own kind of wrong.
 *  Identified by the id prefix the helper prints in `model:loading`. */
const STREAMING_WARM_SECONDS = 30
const STREAMING_ID_PREFIX = 'nemotron/'

function typicalWarmSeconds(model: string): number {
  return model.startsWith(STREAMING_ID_PREFIX) ? STREAMING_WARM_SECONDS : TYPICAL_WARM_SECONDS
}

/**
 * Whether a warm of this model should disable the voice controls.
 *
 * Mirrors `VoiceCoordinator.pressBlockedByLoad` on the helper side: the
 * streaming engine serves a press mid-load, WhisperKit does not. Keeping the
 * two in step is what stops the button from looking alive while the hotkey
 * refuses, or the reverse.
 */
export function warmBlocksPress(model: string): boolean {
  return !model.startsWith(STREAMING_ID_PREFIX)
}

/** "about 5 minutes" reads fine; "about 0 minutes" does not. */
function describeTypical(seconds: number): string {
  if (seconds < 60) return 'usually a few seconds'
  return `usually about ${Math.round(seconds / 60)} minutes`
}

export function formatWarmElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/**
 * Tooltip for a voice control while a warm is in progress.
 *
 * Busy rather than broken, and roughly how long. The typical duration is the
 * part that matters — without it a multi-minute wait reads as a hang. When the
 * warm does not block the press, say so, because a dimmed control otherwise
 * reads as "don't touch me".
 */
export function warmTooltip(elapsedSeconds: number, model = ''): string {
  const elapsed = formatWarmElapsed(elapsedSeconds)
  const typical = describeTypical(typicalWarmSeconds(model))
  const head = `Preparing the on-device model (${elapsed} so far, ${typical}).`
  return warmBlocksPress(model)
    ? head
    : `${head} You can start talking now — the text arrives once it finishes.`
}

/** Short label for the same state where there is no room for the tooltip. */
export function warmShortLabel(elapsedSeconds: number): string {
  return `Preparing model… ${formatWarmElapsed(elapsedSeconds)}`
}
