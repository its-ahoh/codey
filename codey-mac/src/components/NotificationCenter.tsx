import React, { useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { useChats } from '../hooks/useChats'
import { deriveNotifications, type InFlightLike } from './notificationData'

const STATUS_LABEL: Record<InFlightLike['agentStatus'], string> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  working: 'Working…',
  writing: 'Writing…',
}

export const NotificationCenter: React.FC = () => {
  const { state, selectChat } = useChats()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const { inProgress, completed, unreadCount } = deriveNotifications(
    state.chats,
    state.inFlight as Record<string, InFlightLike>,
    state.unreadChats,
  )
  const hasInProgress = inProgress.length > 0

  // Close the panel on any click outside its root.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (chatId: string) => {
    selectChat(chatId)
    setOpen(false)
  }

  return (
    <div ref={rootRef} style={styles.root}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Notifications"
        aria-label="Notifications"
        style={styles.bellButton}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {hasInProgress && <span style={styles.pulseDot} />}
        {unreadCount > 0 && (
          <span style={styles.badge}>{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div style={styles.panel}>
          {inProgress.length === 0 && completed.length === 0 && (
            <div style={styles.empty}>No updates</div>
          )}

          {inProgress.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>In progress</div>
              {inProgress.map(item => (
                <div key={item.chatId} style={styles.item} onClick={() => pick(item.chatId)}>
                  <span style={styles.itemPulse} />
                  <div style={styles.itemBody}>
                    <div style={styles.itemTitle}>{item.title}</div>
                    <div style={styles.itemMeta}>
                      {item.workspaceName} · {STATUS_LABEL[item.agentStatus]}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {completed.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Completed</div>
              {completed.map(item => (
                <div key={item.chatId} style={styles.item} onClick={() => pick(item.chatId)}>
                  <span style={styles.unreadDot} />
                  <div style={styles.itemBody}>
                    <div style={styles.itemTitle}>{item.title}</div>
                    <div style={styles.itemMeta}>
                      {item.workspaceName} · {formatTime(item.updatedAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatTime(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    // @ts-ignore Electron
    WebkitAppRegion: 'no-drag',
  },
  bellButton: {
    position: 'relative',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: C.fg3,
    padding: 4,
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseDot: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: C.green,
    animation: 'codey-pulse 1.4s ease-in-out infinite',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 14,
    height: 14,
    padding: '0 3px',
    borderRadius: 7,
    background: '#E5484D',
    color: '#fff',
    fontSize: 9,
    fontWeight: 700,
    lineHeight: '14px',
    textAlign: 'center',
  },
  panel: {
    position: 'absolute',
    top: 30,
    right: 0,
    width: 300,
    maxHeight: 420,
    overflowY: 'auto',
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    padding: 6,
    zIndex: 1000,
  },
  empty: {
    padding: '18px 10px',
    textAlign: 'center',
    color: C.fg3,
    fontSize: 12,
  },
  section: { marginBottom: 4 },
  sectionTitle: {
    padding: '6px 8px 4px',
    color: C.fg3,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '8px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  itemPulse: {
    marginTop: 5,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: C.green,
    flexShrink: 0,
    animation: 'codey-pulse 1.4s ease-in-out infinite',
  },
  unreadDot: {
    marginTop: 5,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#E5484D',
    flexShrink: 0,
  },
  itemBody: { minWidth: 0, flex: 1 },
  itemTitle: {
    color: C.fg,
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  itemMeta: {
    color: C.fg3,
    fontSize: 11,
    marginTop: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
}
