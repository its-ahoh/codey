// codey-mac/electron/zoom.ts
//
// UI scale ("Zoom") shared by the main window and the View menu. The
// window is scaled with Chromium's zoom factor rather than a
// CSS font-size cascade: the app's type sizes are hard-coded px inside inline
// styles, so only a real zoom moves all of them together without reflowing
// each component by hand.

/** Selectable zoom factors, ascending. 1 (100%) is always one of them. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6]

export const DEFAULT_ZOOM = 1

const MIN_ZOOM = ZOOM_STEPS[0]
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/**
 * Coerces a persisted/IPC value to a usable zoom factor. Unknown, non-finite,
 * or out-of-range input falls back to the nearest listed step rather than
 * leaving a window at an unreadable scale. Snapping also keeps ⌘+/⌘− landing
 * on listed values when the stored config was hand-edited.
 */
export function clampZoom(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ZOOM
  if (n <= MIN_ZOOM) return MIN_ZOOM
  if (n >= MAX_ZOOM) return MAX_ZOOM
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - n) < Math.abs(best - n) ? step : best, DEFAULT_ZOOM)
}

/** Next step up; stays put at the maximum. */
export function zoomIn(current: unknown): number {
  const index = ZOOM_STEPS.indexOf(clampZoom(current))
  return ZOOM_STEPS[Math.min(index + 1, ZOOM_STEPS.length - 1)]
}

/** Next step down; stays put at the minimum. */
export function zoomOut(current: unknown): number {
  const index = ZOOM_STEPS.indexOf(clampZoom(current))
  return ZOOM_STEPS[Math.max(index - 1, 0)]
}

/** "110%" — the label shown in Settings and the View menu. */
export function formatZoom(value: unknown): string {
  return `${Math.round(clampZoom(value) * 100)}%`
}
