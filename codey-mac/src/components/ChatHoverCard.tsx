import React, { useLayoutEffect, useRef, useState } from 'react'
import { C } from '../theme'
import {
  HOVER_CARD_WIDTH,
  hoverCardPosition,
  type HoverCard,
  type HoverCardAnchor,
  type HoverTone,
} from './chatHoverCardView'

interface Props {
  card: HoverCard
  anchor: HoverCardAnchor
}

const TONE_COLOR: Record<HoverTone, string> = {
  accent: C.accent,
  green: C.green,
  yellow: C.yellow,
  red: C.red,
  muted: C.fg3,
}

/** Read-only detail popover for a sidebar row. Deliberately pointer-events:none
 *  — it overlaps neighbouring rows, and a card that swallowed the click that
 *  was meant for the chat under it would be worse than no card at all. */
export const ChatHoverCard: React.FC<Props> = ({ card, anchor }) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(0)

  // Height depends on how many rows this particular chat has, so it is measured
  // after the first paint and the card is only placed once it is known.
  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight)
  }, [card, anchor])

  const placed = height > 0
  const pos = hoverCardPosition(
    anchor,
    { width: window.innerWidth, height: window.innerHeight },
    height,
  )
  const tone = TONE_COLOR[card.status.tone]

  return (
    <div
      ref={ref}
      role="tooltip"
      style={{ ...styles.card, left: pos.left, top: pos.top, opacity: placed ? 1 : 0 }}
    >
      <div style={styles.title}>{card.title}</div>
      <div style={styles.statusRow}>
        <span style={{ ...styles.pill, color: tone, background: `${tone}22` }}>{card.status.label}</span>
        {card.progress && (
          <span style={styles.progressText}>{card.progress.label ?? `${card.progress.percent}%`}</span>
        )}
      </div>
      {card.progress && (
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${card.progress.percent}%`, background: tone }} />
        </div>
      )}
      {card.detail && <div style={styles.detail}>{card.detail}</div>}
      <div style={styles.rows}>
        {card.rows.map(row => (
          <div key={row.label} style={styles.row}>
            <span style={styles.rowLabel}>{row.label}</span>
            <span style={styles.rowValue}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    position: 'fixed',
    zIndex: 900,
    width: HOVER_CARD_WIDTH,
    padding: '9px 11px',
    background: C.surface2 ?? C.surface,
    border: `1px solid ${C.border2 ?? C.border}`,
    borderRadius: 8,
    boxShadow: '0 14px 30px rgba(0,0,0,0.26)',
    pointerEvents: 'none',
    transition: 'opacity 90ms ease-out',
  },
  title: {
    fontSize: 12,
    fontWeight: 600,
    color: C.fg,
    marginBottom: 6,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: 6 },
  pill: { fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 5, whiteSpace: 'nowrap' },
  progressText: { fontSize: 10, color: C.fg3, marginLeft: 'auto' },
  progressTrack: { height: 3, borderRadius: 2, background: C.border, marginTop: 6, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
  detail: {
    fontSize: 11,
    color: C.fg2,
    marginTop: 6,
    lineHeight: 1.35,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  rows: { marginTop: 8, paddingTop: 7, borderTop: `1px solid ${C.border}`, display: 'grid', gap: 3 },
  row: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11 },
  rowLabel: { color: C.fg3, flex: '0 0 66px' },
  rowValue: { color: C.fg2, flex: 1, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}
