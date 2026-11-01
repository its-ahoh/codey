import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { C } from '../theme'
import type { ChatMessage } from '../types'

/** The rail appears once a chat has this many assistant replies (every bot
 * message counts) spread over at least CHAT_NAV_MIN_QUESTIONS user questions. */
export const CHAT_NAV_MIN_ITEMS = 5
export const CHAT_NAV_MIN_QUESTIONS = 2

export interface ChatNavigationItem {
  id: string
  title: string
  preview: string
  role: 'assistant' | 'team'
  /** Every transcript row this item covers; defaults to `[id]`. */
  rowIds?: string[]
  /** The user prompt this turn answers; the jump target when present. */
  questionId?: string
}

export const shouldShowNavigator = (items: ChatNavigationItem[]) =>
  items.reduce((sum, item) => sum + (item.rowIds?.length ?? 1), 0) >= CHAT_NAV_MIN_ITEMS
  && items.filter(item => item.questionId).length >= CHAT_NAV_MIN_QUESTIONS

/** Above this many items, neighbours share a tick so the rail never turns
 * into one solid bar. Fits the 380px rail cap at TICK_PITCH. */
export const CHAT_NAV_MAX_TICKS = 42

const plainText = (msg: ChatMessage) => (msg.content || msg.userQuestion?.question || '')
  .replace(/```[\s\S]*?```/g, ' Code block ')
  .replace(/[#>*_`~[\]]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

/** One item per user turn: a prompt answered by several bots plus a summary
 * is one stop on the rail, labelled by its final (or last non-empty) reply.
 * User prompts are short and sit right above their reply, so they are not
 * mapped on their own. */
export const navigationItemsFor = (messages: ChatMessage[]): ChatNavigationItem[] => {
  const turns: { questionId?: string; replies: ChatMessage[] }[] = []
  let questionId: string | undefined
  let current: ChatMessage[] | null = null
  for (const msg of messages) {
    if (msg.role === 'user') { questionId = msg.id; current = null; continue }
    if (!current) turns.push({ questionId, replies: current = [] })
    current.push(msg)
  }
  return turns.map(({ questionId, replies }) => {
    const labelled = replies.find(m => m.teamFinal && plainText(m))
      ?? [...replies].reverse().find(m => plainText(m))
    const plain = (labelled ? plainText(labelled) : '') || 'Agent update'
    const firstSentence = plain.split(/(?<=[.!?\u3002\uFF01\uFF1F])\s+|\n/)[0] || plain
    return {
      id: replies[0].id,
      title: firstSentence.slice(0, 48),
      preview: plain.slice(0, 180),
      role: replies.length > 1 ? 'team' : 'assistant',
      rowIds: replies.map(m => m.id),
      ...(questionId ? { questionId } : {}),
    }
  })
}

/** Split items into at most `max` consecutive ticks of near-equal size. */
export const ticksFor = (items: ChatNavigationItem[], max = CHAT_NAV_MAX_TICKS): ChatNavigationItem[][] => {
  if (items.length <= max) return items.map(item => [item])
  const ticks: ChatNavigationItem[][] = []
  for (let i = 0; i < max; i++) {
    const start = Math.floor(i * items.length / max)
    const end = Math.floor((i + 1) * items.length / max)
    ticks.push(items.slice(start, end))
  }
  return ticks
}

interface Props {
  containerRef: React.RefObject<HTMLDivElement>
  items: ChatNavigationItem[]
  revision: string
  onNavigate?: () => void
}

const RAIL_WIDTH = 22
/** Vertical distance between neighbouring ticks. */
const TICK_PITCH = 9
const RAIL_LEFT = 5
const TICK_BASE = 7
const TICK_MAX = 20
/** How far (px) the hover "wave" spreads to neighbouring ticks. */
const WAVE_SIGMA = 26

const rowsById = (container: HTMLDivElement) => new Map(
  Array.from(container.querySelectorAll<HTMLElement>('[data-chat-navigation-id]'))
    .map(row => [row.dataset.chatNavigationId, row] as const),
)

/** Ticks keep a fixed pitch, so a short chat gets a short rail. Only very long
 * transcripts hit the cap and squeeze closer together. */
const railHeightFor = (count: number) => Math.min(380, (count - 1) * TICK_PITCH)

/** Tick width for a marker `distance` px away from the pointer: the nearest
 * tick grows to TICK_MAX and neighbours fall off on a bell curve. */
export const tickWidthFor = (distance: number | null): number =>
  distance === null ? TICK_BASE : TICK_BASE + (TICK_MAX - TICK_BASE) * Math.exp(-((distance / WAVE_SIGMA) ** 2))

/** A compact message map for long transcripts. The native scrollbar still
 * handles free scrolling; these markers provide semantic, message-level jumps. */
export const ChatMessageNavigator: React.FC<Props> = ({ containerRef, items, revision, onNavigate }) => {
  const railRef = useRef<HTMLElement>(null)
  const [activeId, setActiveId] = useState<string | null>(() => items.at(-1)?.id ?? null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const visible = shouldShowNavigator(items)

  const updateActive = useCallback(() => {
    const container = containerRef.current
    if (!container || !visible) return
    const rows = rowsById(container)
    const viewport = container.getBoundingClientRect()
    const focusY = viewport.top + viewport.height * 0.38
    let closest: { id: string; distance: number } | null = null
    for (const item of items) {
      for (const rowId of item.rowIds ?? [item.id]) {
        const row = rows.get(rowId)
        if (!row) continue
        const rect = row.getBoundingClientRect()
        const distance = focusY < rect.top ? rect.top - focusY : focusY > rect.bottom ? focusY - rect.bottom : 0
        if (!closest || distance < closest.distance) closest = { id: item.id, distance }
      }
    }
    if (closest) setActiveId(current => current === closest.id ? current : closest.id)
  }, [containerRef, items, visible])

  useLayoutEffect(() => {
    updateActive()
    const frame = requestAnimationFrame(updateActive)
    return () => cancelAnimationFrame(frame)
  }, [revision, updateActive])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !visible) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateActive)
    }
    container.addEventListener('scroll', schedule, { passive: true })
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    resize?.observe(container)
    return () => {
      cancelAnimationFrame(frame)
      container.removeEventListener('scroll', schedule)
      resize?.disconnect()
    }
  }, [containerRef, visible, updateActive])

  if (!visible) return null

  const ticks = ticksFor(items)
  const railHeight = railHeightFor(ticks.length)
  const yFor = (index: number) => ticks.length === 1 ? railHeight / 2 : index / (ticks.length - 1) * railHeight

  let hoveredIndex = -1
  if (pointerY !== null) {
    let best = Infinity
    ticks.forEach((_, index) => {
      const d = Math.abs(yFor(index) - pointerY)
      if (d < best) { best = d; hoveredIndex = index }
    })
  }
  const hovered = hoveredIndex >= 0 ? ticks[hoveredIndex] : null

  const jumpTo = (item: ChatNavigationItem) => {
    // Land on the question that started the turn, at the top of the view,
    // so its replies read downward from there.
    const container = containerRef.current
    const rows = container ? rowsById(container) : undefined
    const row = (item.questionId ? rows?.get(item.questionId) : undefined) ?? rows?.get(item.id)
    if (!row) return
    setActiveId(item.id)
    setPointerY(null)
    onNavigate?.()
    row.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const previewPosition = () => {
    const rail = railRef.current?.getBoundingClientRect()
    if (!rail || hoveredIndex < 0) return { top: 0, left: 0 }
    const y = rail.top + yFor(hoveredIndex)
    return {
      top: Math.max(12, Math.min(window.innerHeight - 150, y - 34)),
      left: rail.left + RAIL_WIDTH + 10,
    }
  }

  return (
    <>
      <nav
        ref={railRef}
        style={{ ...styles.rail, height: railHeight }}
        aria-label="Conversation message navigation"
        onMouseMove={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          setPointerY(event.clientY - rect.top)
        }}
        onMouseLeave={() => setPointerY(null)}
      >
        {ticks.map((tick, index) => {
          const item = tick[0]
          const active = tick.some(t => t.id === activeId)
          const isHovered = index === hoveredIndex
          const distance = pointerY === null ? null : Math.abs(yFor(index) - pointerY)
          return (
            <button
              key={item.id}
              type="button"
              aria-label={tick.length > 1 ? `Jump to ${tick.length} turns from ${item.title}` : `Jump to ${item.title}`}
              aria-current={active ? 'location' : undefined}
              style={{ ...styles.markerButton, top: yFor(index) }}
              onClick={() => jumpTo(item)}
            >
              <span style={{
                ...styles.marker,
                width: tickWidthFor(distance),
                background: active ? C.fg : C.fg3,
                opacity: active ? 0.96 : isHovered ? 0.9 : 0.5,
              }} />
            </button>
          )
        })}
      </nav>
      {hovered && createPortal(
        <div style={{ ...styles.previewCard, ...previewPosition() }} role="tooltip">
          {hovered.length > 1 ? (
            <>
              <div style={styles.previewMeta}>{hovered.length} turns</div>
              {hovered.slice(0, 4).map(t => <div key={t.id} style={styles.previewLine}>{t.title}</div>)}
              {hovered.length > 4 && <div style={styles.previewMeta}>+{hovered.length - 4} more</div>}
            </>
          ) : (
            <>
              {(hovered[0].rowIds?.length ?? 1) > 1 && (
                <div style={styles.previewMeta}>{hovered[0].rowIds!.length} replies</div>
              )}
              <div style={styles.previewTitle}>{hovered[0].title}</div>
              {hovered[0].preview !== hovered[0].title && (
                <div style={styles.previewBody}>{hovered[0].preview}</div>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  rail: {
    position: 'absolute', zIndex: 18, left: RAIL_LEFT, top: '50%',
    width: RAIL_WIDTH, maxHeight: 'calc(100% - 48px)',
    transform: 'translateY(-50%)', cursor: 'pointer',
  },
  markerButton: {
    position: 'absolute', left: 0, width: RAIL_WIDTH, height: TICK_PITCH, padding: 0,
    border: 'none', background: 'transparent', cursor: 'pointer',
    display: 'flex', justifyContent: 'flex-start', alignItems: 'center',
    transform: 'translateY(-50%)',
  },
  marker: { height: 2, borderRadius: 1, transition: 'width 0.12s ease-out, opacity 0.12s ease-out, background 0.12s ease-out' },
  previewCard: {
    position: 'fixed', zIndex: 2000, width: 'min(320px, calc(100vw - 72px))',
    padding: '14px 16px', borderRadius: 12, pointerEvents: 'none',
    color: C.fg, background: C.surface2, border: `1px solid ${C.border2}`,
    boxShadow: '0 14px 36px rgba(0,0,0,0.34)',
  },
  previewMeta: { color: C.fg3, fontSize: 12, fontWeight: 600, marginBottom: 6 },
  previewLine: {
    color: C.fg, fontSize: 13, lineHeight: 1.45,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  previewTitle: { color: C.fg, fontSize: 14, fontWeight: 600, lineHeight: 1.35 },
  previewBody: {
    color: C.fg2, fontSize: 12, lineHeight: 1.55, marginTop: 7,
    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
}
