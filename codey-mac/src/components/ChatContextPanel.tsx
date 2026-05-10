import React from 'react'
import type { Chat, ChatMessage } from '../types'
import { C } from '../theme'

interface Props {
  chat: Chat
  selectedTurnId: string | null
  followLatest: boolean
  /** 1-based index of the selected assistant turn in the chat (for "Turn N" display). */
  selectedTurnIndex: number | null
  /** Effective agent for this chat (resolved by ChatTab from override/worker/default). */
  effectiveAgent: string
  /** Effective model for this chat. May be undefined when no model is resolvable. */
  effectiveModel?: string
  /** Worker name actively bound to the selected turn, when chat selection is a worker. */
  workerName?: string
  /** Team name actively bound, when chat selection is a team. */
  teamName?: string
  width: number
  onFollowLatest: () => void
  onClose: () => void
  onResize: (next: number) => void
  onRevealFile: (absPath: string) => void
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const formatTokens = (n: number): string | null => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export const ChatContextPanel: React.FC<Props> = ({
  chat, selectedTurnId, followLatest, selectedTurnIndex,
  effectiveAgent, effectiveModel, workerName, teamName,
  width, onFollowLatest, onClose, onResize, onRevealFile,
}) => {
  const turn: ChatMessage | undefined = selectedTurnId
    ? chat.messages.find(m => m.id === selectedTurnId && m.role === 'assistant')
    : undefined

  // Resize drag handler
  const onResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (mv: MouseEvent) => {
      const next = Math.max(260, Math.min(520, startW + (startX - mv.clientX)))
      onResize(next)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div style={{ ...styles.root, width }}>
      <div style={styles.resizer} onMouseDown={onResizerMouseDown} title="Drag to resize" />
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerMeta}>
          {turn ? (
            <>
              <span style={styles.headerTitle}>Turn {selectedTurnIndex ?? '?'}</span>
              <span style={styles.headerDot}>·</span>
              <span style={styles.headerSub}>{fmtTime(turn.timestamp)}</span>
              {turn.durationSec != null && Number.isFinite(turn.durationSec) && (
                <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{turn.durationSec}s</span></>
              )}
              {(() => {
                const t = turn.tokens != null ? formatTokens(turn.tokens) : null
                return t ? <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{t} tok</span></> : null
              })()}
            </>
          ) : (
            <span style={styles.headerSub}>No turn selected</span>
          )}
        </div>
        {!followLatest && (
          <button style={styles.followPill} onClick={onFollowLatest} title="Follow live updates">Follow latest ↓</button>
        )}
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close panel">×</button>
      </div>

      <div style={styles.body}>
        {/* Run target */}
        <Section title="Run target">
          <div style={styles.runTargetRow}>
            {teamName ? `Team: ${teamName}` : workerName ? `Worker: ${workerName}` : 'Direct chat'}
          </div>
          <div style={styles.runTargetSub}>
            {effectiveAgent}{effectiveModel ? ` · ${effectiveModel}` : ''}
          </div>
        </Section>

        {/* Tool timeline + Files touched + Attachments + Pending team are
            added in later tasks. Placeholder for now: */}
        {!turn && <div style={styles.emptyHint}>Send a message to see run context.</div>}
      </div>
    </div>
  )
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={styles.section}>
    <div style={styles.sectionTitle}>{title}</div>
    <div>{children}</div>
  </div>
)

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    height: '100%',
    background: C.surface2,
    borderLeft: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  resizer: {
    position: 'absolute',
    left: -3, top: 0, bottom: 0, width: 6,
    cursor: 'col-resize',
    zIndex: 5,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px', borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  headerMeta: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' },
  headerTitle: { color: C.fg, fontSize: 12, fontWeight: 600 },
  headerSub: { color: C.fg3, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  headerDot: { color: C.fg3, fontSize: 11, opacity: 0.5 },
  followPill: {
    background: C.accent, color: '#fff', border: 'none',
    borderRadius: 10, fontSize: 10, padding: '2px 8px', cursor: 'pointer',
  },
  closeBtn: {
    background: 'transparent', border: 'none', color: C.fg2,
    fontSize: 18, lineHeight: 1, padding: '0 4px', cursor: 'pointer',
  },
  body: { flex: 1, overflowY: 'auto', padding: '8px 12px' },
  section: { marginBottom: 14 },
  sectionTitle: {
    color: C.fg3, fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
    textTransform: 'uppercase', marginBottom: 6,
  },
  runTargetRow: { color: C.fg, fontSize: 12 },
  runTargetSub: { color: C.fg3, fontSize: 11, marginTop: 2 },
  emptyHint: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '12px 0' },
}
