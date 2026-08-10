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

interface Props {
  msg: ChatMessage
  /** Rendered only when the turn has thinking to disclose. */
  hasThinking: boolean
  expanded: boolean
  onToggle: () => void
  /** The rule closes a finished turn. While one is still streaming there is
   *  nothing below it to bound, and a line drawn under a growing reply reads as
   *  a separator in the wrong place. */
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
 *  The rule always renders; the metadata row renders only when there is
 *  something to put in it, so a turn with no metadata is a bare hairline rather
 *  than a blank row. */
export const TurnHeader: React.FC<Props> = ({ msg, hasThinking, expanded, onToggle, turnComplete }) => {
  const meta = turnHeaderMeta(msg)
  const rule = turnComplete ? <div style={styles.rule} /> : null
  if (meta.isEmpty && !hasThinking) return rule

  return (
    <div>
      {/* Without the rule below it, the row supplies its own bottom gap. */}
      <div style={{ ...styles.row, marginBottom: turnComplete ? 4 : 12 }}>
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
          {meta.fallback && (
            <span
              style={styles.fallback}
              title={`Primary ${meta.fallback.from} failed — answered by fallback ${meta.fallback.to}`}
            >
              ⤷ {meta.fallback.to}
            </span>
          )}
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
  fallback: {
    color: C.warningFg, background: C.warningBg,
    borderRadius: 6, padding: '1px 6px', fontSize: 10,
    minWidth: 0, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  rule: { borderTop: `1px solid ${C.border2}`, marginBottom: 8 },
}
