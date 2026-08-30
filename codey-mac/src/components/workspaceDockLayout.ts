export interface WorkspaceDockLayout {
  overlay: boolean
  width: number
}

const MIN_MIDDLE_WIDTH = 360
const MIN_DOCK_WIDTH = 320
const OVERLAY_REVEAL_WIDTH = 72

/**
 * Size the workspace dock against the space it actually lives in. Using the
 * Electron window width here lets an overlay extend behind the app sidebar;
 * that is especially visible for the native BrowserView, which is composited
 * above normal DOM content and cannot be clipped with z-index.
 */
export function resolveWorkspaceDockLayout(
  containerWidth: number,
  preferredWidth: number,
): WorkspaceDockLayout {
  const safeContainerWidth = Math.max(0, containerWidth)
  const safePreferredWidth = Math.max(0, preferredWidth)
  const availableBesideChat = safeContainerWidth - MIN_MIDDLE_WIDTH
  const overlay = availableBesideChat < MIN_DOCK_WIDTH
  const widthLimit = overlay
    ? Math.max(0, safeContainerWidth - OVERLAY_REVEAL_WIDTH)
    : availableBesideChat

  return {
    overlay,
    width: Math.min(safePreferredWidth, widthLimit),
  }
}
