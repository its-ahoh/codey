const DEFAULT_MARGIN = 12

/** The embedded browser is an Electron WebContentsView, so it always paints
 * above renderer DOM. Treat its left edge as the renderer's usable right edge
 * when positioning floating UI. */
export function floatingViewportRight(viewportWidth = window.innerWidth): number {
  const browserHost = document.querySelector<HTMLElement>('[data-codey-browser-host]')
  if (!browserHost) return viewportWidth
  const rect = browserHost.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? Math.min(viewportWidth, rect.left) : viewportWidth
}

/** Prefer right-aligning a floating layer to its anchor, then slide it back
 * into the visible renderer region when either edge would be obscured. */
export function clampFloatingLeft(
  anchorRight: number,
  layerWidth: number,
  boundaryRight: number,
  margin = DEFAULT_MARGIN,
): number {
  const preferred = anchorRight - layerWidth
  const maxLeft = boundaryRight - layerWidth - margin
  return Math.max(margin, Math.min(preferred, maxLeft))
}

/** Keep a top-left-anchored floating layer (a context menu) fully inside the
 * visible renderer region: prefer the requested point, slide it back when it
 * would spill past an edge. Degrades to the margin when the layer is larger
 * than the available space. */
export function clampFloatingPoint(
  x: number,
  y: number,
  layerWidth: number,
  layerHeight: number,
  boundaryRight: number,
  boundaryBottom: number,
  margin = DEFAULT_MARGIN,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, boundaryRight - layerWidth - margin)
  const maxTop = Math.max(margin, boundaryBottom - layerHeight - margin)
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop)),
  }
}
