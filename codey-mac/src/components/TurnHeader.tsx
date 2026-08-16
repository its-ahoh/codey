import React from 'react'
import { C } from '../theme'
import { turnHeaderMeta } from './turnHeaderModel'
import type { ChatMessage } from '../types'
import { UIIcon } from './UIIcons'

/** Left inset applied to a whole message row. */
export const MESSAGE_ROW_INSET = 6
/** Width of the selection rail down the left of an assistant turn. */
export const TURN_RAIL_WIDTH = 3
/** Gap between the rail and the text. Chosen so the text column lands exactly
 *  where the old bubble put it: rail 3 + 12 == the bubble's border 1 + padding 14. */
export const TURN_TEXT_PADDING = 12

/** Left inset of an assistant turn's text column, measured from the messages
 *  container. Everything that belongs to the turn — the header, the reply, the
 *  timestamp footer, the status row — aligns to this one value. They used to
 *  carry independent numbers (21, 10 and 0), which read as three ragged left
 *  edges. */
export const TURN_TEXT_INSET = MESSAGE_ROW_INSET + TURN_RAIL_WIDTH + TURN_TEXT_PADDING

/** Horizontal padding inside the user bubble. A user turn is right-aligned, so
 *  its timestamp lines up on the right edge and needs this, not TURN_TEXT_INSET. */
export const USER_BUBBLE_PADDING_X = 14

/** Seconds since `since`, re-rendering once a second while `active`.
 *
 *  The agent only reports its own duration with the final result event, so a
 *  turn in flight has to count locally. Off while inactive: a finished turn
 *  must not keep a timer alive per message in the transcript. */
function useElapsedSeconds(active: boolean, since: number): number | undefined {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, since])
  if (!active || !Number.isFinite(since)) return undefined
  return Math.max(0, Math.floor((now - since) / 1000))
}

interface Props {
  msg: ChatMessage
  /** Rendered only when the turn has thinking to disclose. */
  hasThinking: boolean
  expanded: boolean
  onToggle: () => void
  turnComplete: boolean
}

/** Identifies an assistant turn and bounds it.
 *
 *  The bubble used to do both jobs. When it was removed, the boundary fell to
 *  spacing alone — an implicit signal competing with the reply's own paragraph
 *  spacing — and the turn's secondary chrome lost the surface that marked it as
 *  belonging to this turn. A rule is an explicit boundary that does not compete,
 *  and the header gives the thinking disclosure a permanent home instead of
 *  leaving it as an unanchored 11px line above the reply.
 *
 *  The rule always renders — including while the turn is still streaming, so
 *  the header keeps the same shape from the first token to the last instead of
 *  gaining a line when the turn lands. The metadata row renders only when there
 *  is something to put in it, so a turn with no metadata is a bare hairline
 *  rather than a blank row. */
export const TurnHeader: React.FC<Props> = ({ msg, hasThinking, expanded, onToggle, turnComplete }) => {
  const elapsedSec = useElapsedSeconds(!turnComplete, msg.timestamp)
  const meta = turnHeaderMeta(msg, { elapsedSec })
  const rule = <div style={styles.rule} />
  if (meta.isEmpty && !hasThinking) return rule

  return (
    <div>
      <div style={styles.row}>
        <div style={styles.left}>
          {hasThinking ? (
            <button
              type="button"
              style={styles.disclosure}
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} thinking${meta.identity ? ` for ${meta.identity}` : ''}`}
              title={expanded ? 'Hide thinking' : 'Show thinking'}
            >
              {meta.identity && (
                <span style={styles.identity} title={meta.identity}>{meta.identity}</span>
              )}
              <span style={{ ...styles.chevron, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                <UIIcon name="chevron" size={14} strokeWidth={2} />
              </span>
            </button>
          ) : meta.identity ? (
            <span style={styles.identity} title={meta.identity}>{meta.identity}</span>
          ) : null}
          {meta.fallback && <FallbackWarning fallback={meta.fallback} />}
        </div>
        <div style={styles.right}>
          {meta.stats.length > 0 && (
            <span style={styles.stats}>{meta.stats.join(' · ')}</span>
          )}
        </div>
      </div>
      {rule}
    </div>
  )
}

/** Marks a turn that a fallback agent answered.
 *
 *  The identity to its left already names the agent/model that actually
 *  replied — the header used to spell that same pair out again in a badge. All
 *  this has to add is that the turn took a detour, and a way to ask why; the
 *  reason itself is long and rare, so it belongs in a popup rather than in the
 *  metadata row. */
const FallbackWarning: React.FC<{ fallback: { from: string; to: string; reason?: string } }> = ({ fallback }) => {
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef<HTMLSpanElement>(null)

  // Dismiss like a menu: a click anywhere else, or Escape. Without this the
  // popup would survive scrolling away and opening another turn's popup.
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={wrapRef} style={styles.fallbackWrap}>
      <button
        type="button"
        style={styles.fallbackButton}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={`Answered by a fallback after ${fallback.from} failed`}
        title="Answered by a fallback — click for details"
      >
        <UIIcon name="alert" size={13} strokeWidth={1.8} />
      </button>
      {open && (
        <div role="dialog" style={styles.fallbackPopover}>
          <div style={styles.fallbackTitle}>Fallback used</div>
          <div style={styles.fallbackLine}>
            <span style={styles.fallbackLabel}>{fallback.from}</span> failed, so{' '}
            <span style={styles.fallbackLabel}>{fallback.to}</span> answered instead.
          </div>
          {fallback.reason && <div style={styles.fallbackReason}>{fallback.reason}</div>}
        </div>
      )}
    </span>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex', alignItems: 'center',
    gap: 10, fontSize: 11, color: C.fg3, marginBottom: 4,
  },
  left: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  right: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto' },
  identity: {
    fontFamily: 'SF Mono, Menlo, monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  disclosure: {
    appearance: 'none', border: 0, background: 'transparent', color: 'inherit',
    font: 'inherit', padding: '3px 2px', margin: '-3px -2px', minWidth: 0,
    display: 'inline-flex', alignItems: 'center', gap: 4,
    cursor: 'pointer', textAlign: 'left',
  },
  chevron: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, userSelect: 'none', transition: 'transform 0.15s ease',
  },
  stats: { fontVariantNumeric: 'tabular-nums', opacity: 0.55 },
  fallbackWrap: { position: 'relative', display: 'inline-flex', flexShrink: 0 },
  fallbackButton: {
    appearance: 'none', border: 0, background: 'transparent', color: C.warningFg,
    padding: '2px', margin: '-2px', display: 'inline-flex', alignItems: 'center',
    cursor: 'pointer', lineHeight: 0,
  },
  fallbackPopover: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40,
    width: 300, maxWidth: '70vw',
    background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 8,
    padding: '8px 10px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    fontSize: 11, color: C.fg2, whiteSpace: 'normal', textAlign: 'left', cursor: 'default',
  },
  fallbackTitle: { color: C.warningFg, fontSize: 10, letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 4 },
  fallbackLine: { lineHeight: 1.45 },
  fallbackLabel: { fontFamily: 'SF Mono, Menlo, monospace' },
  fallbackReason: {
    marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border2}`,
    fontFamily: 'SF Mono, Menlo, monospace', fontSize: 10, lineHeight: 1.45,
    color: C.fg3, maxHeight: 160, overflowY: 'auto', overflowWrap: 'anywhere',
  },
  rule: { borderTop: `1px solid ${C.border2}`, marginBottom: 8 },
}
