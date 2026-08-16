import React, { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { C } from '../theme'
import { UIIcon } from './UIIcons'
import { clampCardTop, type ChatHoverCardView } from './chatHoverCardView'
import type { StatusTone } from './taskHudView'

interface Props {
  view: ChatHoverCardView
  /** Viewport coordinates of the hovered row, from getBoundingClientRect(). */
  anchor: { top: number; right: number }
}

const TONE: Record<StatusTone, string> = {
  accent: C.accent,
  green: C.green,
  yellow: C.yellow,
  red: C.red,
}

/** Read-only peek at a chat, shown while the pointer rests on its row in the
 *  sidebar. Measured after mount so a tall card near the bottom of the list
 *  slides up instead of being clipped. */
export const ChatHoverCard: React.FC<Props> = ({ view, anchor }) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [top, setTop] = useState(anchor.top)

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0
    setTop(clampCardTop(anchor.top, height, window.innerHeight))
  }, [anchor.top, anchor.right, view])

  const tone = TONE[view.status.tone]
  // Portalled to <body>: the sidebar root paints through a backdrop-filter,
  // which makes it the containing block AND the stacking context for fixed
  // descendants — a card left inside it renders behind the chat view and gets
  // measured against the sidebar's box instead of the viewport.
  return createPortal(
    <div ref={ref} role="tooltip" style={{ ...styles.card, top, left: anchor.right + 8 }}>
      <div style={styles.title}>{view.title}</div>
      <div style={{ ...styles.status, color: tone }}>
        <span style={{ ...styles.statusDot, background: tone }} />
        {view.status.label}
      </div>
      {view.goal && (
        <div style={styles.goalBlock}>
          <div style={styles.goal}>{view.goal}</div>
          {typeof view.progress === 'number' && (
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${Math.min(100, Math.max(0, view.progress))}%`, background: tone }} />
            </div>
          )}
        </div>
      )}
      <div style={styles.rows}>
        {view.rows.map(row => (
          <div key={row.label} style={styles.row}>
            <span style={styles.rowIcon} title={row.label} aria-label={row.label}>
              <UIIcon name={row.icon} size={13} />
            </span>
            <span style={{ ...styles.rowValue, ...(row.monospace ? styles.monospace : null) }}>{row.value}</span>
          </div>
        ))}
      </div>
      {view.channels.length > 0 && (
        <div style={styles.channels}>
          <UIIcon name="link" size={12} />
          {view.channels.join(' · ')}
        </div>
      )}
    </div>,
    document.body,
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    position: 'fixed', zIndex: 1100, width: 280, padding: 11,
    background: C.surface2 ?? C.surface,
    border: `1px solid ${C.border2}`,
    borderRadius: 10,
    boxShadow: '0 10px 30px rgba(0,0,0,0.38)',
    display: 'flex', flexDirection: 'column', gap: 8,
    // Purely informational: never steal the pointer from the row underneath.
    pointerEvents: 'none',
  },
  title: { color: C.fg, fontSize: 12.5, fontWeight: 700, lineHeight: 1.3, wordBreak: 'break-word' },
  status: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 650 },
  statusDot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  goalBlock: { display: 'flex', flexDirection: 'column', gap: 5 },
  goal: { color: C.fg2, fontSize: 11.5, lineHeight: 1.4 },
  progressTrack: { height: 3, borderRadius: 2, background: C.surface3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
  rows: { display: 'flex', flexDirection: 'column', gap: 3, borderTop: `1px solid ${C.border}`, paddingTop: 7 },
  row: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, minHeight: 16 },
  rowIcon: { color: C.fg3, width: 15, height: 15, flexShrink: 0, display: 'grid', placeItems: 'center' },
  rowValue: { color: C.fg2, minWidth: 0, flex: 1, lineHeight: 1.35, wordBreak: 'break-word' },
  monospace: { fontFamily: 'SF Mono, Menlo, monospace', fontSize: 10.5 },
  channels: { display: 'flex', alignItems: 'center', gap: 5, color: C.fg3, fontSize: 10.5 },
}
