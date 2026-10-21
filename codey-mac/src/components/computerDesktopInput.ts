export function windowPoint(rect: { left: number; top: number; width: number; height: number }, videoWidth: number, videoHeight: number, x: number, y: number) {
  if (videoWidth <= 0 || videoHeight <= 0 || rect.width <= 0 || rect.height <= 0) return null
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
  const width = videoWidth * scale, height = videoHeight * scale
  const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2
  if (x < left || y < top || x >= left + width || y >= top + height) return null
  return { x: (x - left) / width, y: (y - top) / height }
}
const namedKeys: Record<string, string> = { Enter: 'Return', Backspace: 'Delete', Delete: 'ForwardDelete', Escape: 'Escape',
  Tab: 'Tab', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' }
export function desktopKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) {
  if (['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null
  // Paste comes from the user's paste event, not an unrestricted clipboard API.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return null
  const key = namedKeys[event.key] ?? event.key.toLowerCase()
  if (event.metaKey || event.ctrlKey || (event.altKey && namedKeys[event.key]) || (event.shiftKey && namedKeys[event.key])) {
    return { tool: 'hotkey', keys: [...(event.metaKey ? ['cmd'] : []), ...(event.ctrlKey ? ['ctrl'] : []),
      ...(event.altKey ? ['alt'] : []), ...(event.shiftKey ? ['shift'] : []), key] }
  }
  return namedKeys[event.key] ? { tool: 'press_key', key } : null
}
