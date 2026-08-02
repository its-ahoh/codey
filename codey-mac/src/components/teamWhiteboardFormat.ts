export type WhiteboardMarker = {
  kind: 'fact' | 'decision' | 'handoff' | 'open'
  text: string
  to?: string | null
}

const MARKER_RE = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?\[(FACT|DECISION|OPEN|HANDOFF(?:\s*:\s*[^\]]+)?)\]\s*:\s*(.+?)\s*$/i

/** UI-side counterpart to the gateway marker parser. Keeping this tiny parser
 * local avoids exposing the CommonJS core barrel through Vite. */
export function splitWhiteboardMarkers(text: string): { stripped: string; markers: WhiteboardMarker[] } {
  const kept: string[] = []
  const markers: WhiteboardMarker[] = []
  for (const line of (text ?? '').split(/\r?\n/)) {
    const match = line.match(MARKER_RE)
    if (!match) { kept.push(line); continue }
    const raw = match[1].trim()
    const tag = raw.split(/\s*:\s*/, 1)[0].toUpperCase()
    const body = match[2].trim()
    if (tag === 'FACT') markers.push({ kind: 'fact', text: body })
    else if (tag === 'DECISION') markers.push({ kind: 'decision', text: body })
    else if (tag === 'OPEN') markers.push({ kind: 'open', text: body })
    else {
      const colon = raw.indexOf(':')
      markers.push({ kind: 'handoff', to: colon >= 0 ? raw.slice(colon + 1).trim() || null : null, text: body })
    }
  }
  return { stripped: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), markers }
}
