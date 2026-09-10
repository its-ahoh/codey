import React from 'react'
import { C } from '../theme'
import { fallbackErrorText, turnHeaderMeta } from './turnHeaderModel'
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
  /** Hands the fallback failure text to a fresh chat. Omitted where no such
   *  surface exists, which hides the "Ask Agent" action rather than offering a
   *  button that does nothing. */
  onAskAgentAboutFallback?: (detail: string, fallback: { from: string; to: string }) => void
  /** A worker turn's avatar, rendered at the start of this row and centered
   *  against it — unlike the name/identity text, it's tall enough that
   *  baseline-aligning it against them reads as misplaced. */
  leftAvatar?: React.ReactNode
  /** A worker turn's name, rendered right before the identity so the two sit
   *  in the same baseline-aligned text group instead of the identity landing
   *  on a second, mostly-empty row of its own. */
  leftLabel?: React.ReactNode
  /** Whether the containing assistant message is hovered. The header also
   *  tracks focus/hover locally for standalone keyboard and pointer access,
   *  but the parent owns the full-turn hit area (reply, tools and footer). */
  messageHovered?: boolean
}

/** An `agent · model` label, invisible until the row it lives in is hovered.
 *
 *  It's noise on every turn but useful on demand, so it reserves its layout
 *  space (no reflow on reveal) and dims in at the same tone as the stats on
 *  the other end of the row rather than declaring its own. The hover/focus
 *  state lives outside this label, so pointing anywhere in the assistant turn
 *  reveals it, not just the exact pixels of the text itself. */
export const IdentityLabel: React.FC<{ identity: string; visible: boolean }> = ({ identity, visible }) => (
  <span style={{ ...styles.identity, opacity: visible ? 0.55 : 0 }} title={identity}>
    {identity}
  </span>
)

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
export const TurnHeader: React.FC<Props> = ({ msg, hasThinking, expanded, onToggle, turnComplete, onAskAgentAboutFallback, leftAvatar, leftLabel, messageHovered = false }) => {
  const elapsedSec = useElapsedSeconds(!turnComplete, msg.timestamp)
  const meta = turnHeaderMeta(msg, { elapsedSec })
  // Keep a local state for focus and direct header hover, while ChatTab passes
  // the containing assistant turn's hover state to cover the reply body too.
  const [headerActive, setHeaderActive] = React.useState(false)
  const identityVisible = messageHovered || headerActive
  // The thinking chevron is part of the same on-demand metadata as the
  // identity, so it hides with the name instead of dangling alone on an
  // un-hovered turn. With no identity to reveal it stays visible — it is then
  // the only affordance for the thinking it discloses.
  const chevronOpacity = meta.identity && !identityVisible ? 0 : 1
  // A worker's avatar/name makes the row worth drawing even when there's
  // otherwise nothing to show.
  const isEmpty = (leftAvatar || leftLabel) ? false : meta.isEmpty
  const rule = <div style={styles.rule} />
  if (isEmpty && !hasThinking) return rule

  return (
    <div>
      <div
        style={styles.row}
        onMouseEnter={() => setHeaderActive(true)}
        onMouseLeave={() => setHeaderActive(false)}
        onFocus={() => setHeaderActive(true)}
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeaderActive(false)
        }}
      >
        <div style={styles.left}>
          {leftAvatar}
          <div style={styles.leftText}>
            {leftLabel}
            {hasThinking ? (
              <button
                type="button"
                style={styles.disclosure}
                onClick={onToggle}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Hide' : 'Show'} thinking${meta.identity ? ` for ${meta.identity}` : ''}`}
                title={expanded ? 'Hide thinking' : 'Show thinking'}
              >
                {meta.identity && <IdentityLabel identity={meta.identity} visible={identityVisible} />}
                <span style={{ ...styles.chevron, opacity: chevronOpacity, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                  <UIIcon name="chevron" size={14} strokeWidth={2} />
                </span>
              </button>
            ) : meta.identity ? (
              <IdentityLabel identity={meta.identity} visible={identityVisible} />
            ) : null}
          </div>
          {meta.fallback && (
            <FallbackWarning fallback={meta.fallback} onAskAgent={onAskAgentAboutFallback} visible={identityVisible} />
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

/** Marks a turn that a fallback agent answered.
 *
 *  The identity to its left already names the agent/model that actually
 *  replied, so the only thing worth surfacing here is *why* the first agent
 *  dropped out — the failure itself, verbatim. It rides in a hover popover: the
 *  reason is long and rare, and asking for a click to read an error the user
 *  never chose to trigger is a toll on the common case.
 *
 *  Reading the error is rarely the end of it, so the popover carries the two
 *  things a user does next — take the text elsewhere, or hand it straight to an
 *  agent. That makes the layer interactive, so it can no longer opt out of the
 *  pointer: it stays open while the pointer is anywhere inside the wrapper
 *  (popover included), and the 6px gap under the icon is padding *inside* the
 *  layer rather than empty space that would close it mid-travel. */
const FallbackWarning: React.FC<{
  fallback: { from: string; to: string; reason?: string }
  onAskAgent?: (detail: string, fallback: { from: string; to: string }) => void
  /** Same reveal-on-hover gate as the identity label beside it, so the two
   *  read as one piece of on-demand metadata instead of the triangle
   *  permanently drawing the eye on every fallback turn. */
  visible: boolean
}> = ({ fallback, onAskAgent, visible }) => {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const detail = fallbackErrorText(fallback)

  // Reset so a re-open never shows a stale "Copied" from the last visit.
  React.useEffect(() => {
    if (open) return
    setCopied(false)
  }, [open])

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail)
      setCopied(true)
    } catch { /* clipboard denied — leave the label alone */ }
  }

  return (
    <span
      style={styles.fallbackWrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      // Focus/blur mirror the hover pair so the popover and its actions are
      // reachable without a pointer. Blur bubbles in React, so the containment
      // check keeps it open while focus moves between the icon and the buttons.
      onFocus={() => setOpen(true)}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
    >
      <span
        tabIndex={0}
        role="button"
        style={{ ...styles.fallbackButton, opacity: visible ? 1 : 0, transition: 'opacity 0.1s ease' }}
        aria-label={`Fallback warning. Failed agent and model: ${fallback.from}. Fallback agent and model: ${fallback.to}. Error: ${detail}`}
      >
        <UIIcon name="alert" size={13} strokeWidth={1.8} />
      </span>
      {open && (
        <div style={styles.fallbackLayer}>
          <div role="tooltip" style={styles.fallbackPopover}>
            <div style={styles.fallbackIdentityGrid}>
              <span style={styles.fallbackLabel}>Failed agent/model</span>
              <span style={styles.fallbackIdentity}>{fallback.from}</span>
            </div>
            <div style={styles.fallbackErrorLabel}>Error</div>
            <div style={styles.fallbackReason}>{detail}</div>
            <div style={styles.fallbackActions}>
              <button type="button" style={styles.fallbackAction} onClick={copy}>
                <UIIcon name="copy" size={11} strokeWidth={1.8} />
                {copied ? 'Copied' : 'Copy'}
              </button>
              {onAskAgent && (
                <button
                  type="button"
                  style={styles.fallbackAction}
                  onClick={() => { setOpen(false); onAskAgent(detail, fallback) }}
                >
                  <UIIcon name="chat" size={11} strokeWidth={1.8} />
                  Ask Agent
                </button>
              )}
            </div>
          </div>
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
  left: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  // Baseline, not center: the worker's bold name and the monospace identity
  // sit at different font sizes, and centering them left the smaller text
  // looking like it floated above where it should sit. Kept separate from
  // `left` above so the (much taller) avatar still centers normally instead
  // of baseline-aligning against text and landing near the bottom.
  leftText: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 },
  right: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto' },
  identity: {
    fontFamily: 'SF Mono, Menlo, monospace', color: C.fg3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    transition: 'opacity 0.1s ease',
  },
  disclosure: {
    appearance: 'none', border: 0, background: 'transparent', color: 'inherit',
    font: 'inherit', padding: '3px 2px', margin: '-3px -2px', minWidth: 0,
    display: 'inline-flex', alignItems: 'center', gap: 4,
    cursor: 'pointer', textAlign: 'left',
  },
  chevron: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, userSelect: 'none',
    transition: 'transform 0.15s ease, opacity 0.1s ease',
  },
  stats: { fontVariantNumeric: 'tabular-nums', opacity: 0.55 },
  fallbackWrap: { position: 'relative', display: 'inline-flex', flexShrink: 0 },
  fallbackButton: {
    color: C.warningFg, padding: '2px', margin: '-2px',
    display: 'inline-flex', alignItems: 'center', lineHeight: 0,
  },
  // The layer starts flush against the icon and pays the 6px offset as its own
  // padding, so travelling from the icon to the buttons never crosses a dead
  // strip that would close the popover.
  fallbackLayer: {
    position: 'absolute', top: '100%', left: 0, zIndex: 40, paddingTop: 6,
  },
  fallbackPopover: {
    width: 300, maxWidth: '70vw',
    background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 8,
    padding: '8px 10px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    textAlign: 'left',
  },
  fallbackIdentityGrid: {
    display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: 8, rowGap: 4, alignItems: 'baseline', marginBottom: 8,
  },
  fallbackLabel: { color: C.fg3, fontSize: 10.5 },
  fallbackIdentity: {
    color: C.fg, fontFamily: 'SF Mono, Menlo, monospace', fontSize: 10.5,
    overflowWrap: 'anywhere', userSelect: 'text', cursor: 'text',
  },
  fallbackErrorLabel: {
    color: C.fg3, fontSize: 10.5, marginBottom: 3,
    borderTop: `1px solid ${C.border2}`, paddingTop: 8,
  },
  fallbackReason: {
    fontFamily: 'SF Mono, Menlo, monospace', fontSize: 10.5, lineHeight: 1.45,
    color: C.fg2, whiteSpace: 'pre-wrap',
    maxHeight: 200, overflowY: 'auto', overflowWrap: 'anywhere',
    userSelect: 'text', cursor: 'text',
  },
  fallbackActions: {
    display: 'flex', gap: 6, marginTop: 8,
    borderTop: `1px solid ${C.border2}`, paddingTop: 8,
  },
  fallbackAction: {
    appearance: 'none', background: 'transparent', color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 6,
    padding: '3px 7px', fontSize: 10.5, lineHeight: 1.2,
    display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  },
  rule: { borderTop: `1px solid ${C.border2}`, marginBottom: 8 },
}
