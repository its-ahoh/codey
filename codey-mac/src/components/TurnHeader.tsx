import React from 'react'
import { C } from '../theme'
import { turnHeaderMeta } from './turnHeaderModel'
import type { ChatMessage } from '../types'

interface Props {
  msg: ChatMessage
  /** Rendered only when the turn has thinking to disclose. */
  hasThinking: boolean
  expanded: boolean
  onToggle: () => void
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
export const TurnHeader: React.FC<Props> = ({ msg, hasThinking, expanded, onToggle }) => {
  const meta = turnHeaderMeta(msg)
  if (meta.isEmpty && !hasThinking) return <div style={styles.rule} />

  return (
    <div>
      <div style={styles.row}>
        <div style={styles.left}>
          {meta.identity && (
            <span style={styles.identity} title={meta.identity}>{meta.identity}</span>
          )}
          {hasThinking && (
            <span
              style={styles.chevron}
              onClick={onToggle}
              role="button"
              aria-expanded={expanded}
              title={expanded ? 'Hide thinking' : 'Show thinking'}
            >
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </div>
        <div style={styles.right}>
          {meta.fallback && (
            <span
              style={styles.fallback}
              title={`Primary ${meta.fallback.from} failed — answered by fallback ${meta.fallback.to}`}
            >
              ⤷ {meta.fallback.to}
            </span>
          )}
          {meta.stats.length > 0 && (
            <span style={styles.stats}>{meta.stats.join(' · ')}</span>
          )}
        </div>
      </div>
      <div style={styles.rule} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, fontSize: 11, color: C.fg3, marginBottom: 4,
  },
  left: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  right: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  identity: {
    fontFamily: 'SF Mono, Menlo, monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  chevron: { cursor: 'pointer', fontSize: 9, userSelect: 'none', flexShrink: 0 },
  stats: { fontVariantNumeric: 'tabular-nums', opacity: 0.55 },
  fallback: {
    color: C.warningFg, background: C.warningBg,
    borderRadius: 6, padding: '1px 6px', fontSize: 10,
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  rule: { borderTop: `1px solid ${C.border2}`, marginBottom: 8 },
}
