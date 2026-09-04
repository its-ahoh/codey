import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { C } from '../theme'

/** Assistant replies (team runs count once) before the rail appears. */
export const CHAT_NAV_MIN_ITEMS = 5

export interface ChatNavigationItem {
  id: string
  title: string
  preview: string
  role: 'assistant' | 'team'
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

const rowFor = (container: HTMLDivElement, id: string): HTMLElement | undefined =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-chat-navigation-id]'))
    .find(row => row.dataset.chatNavigationId === id)

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

  const updateActive = useCallback(() => {
    const container = containerRef.current
    if (!container || items.length < CHAT_NAV_MIN_ITEMS) return
    const viewport = container.getBoundingClientRect()
    const focusY = viewport.top + viewport.height * 0.38
    let closest: { id: string; distance: number } | null = null
    for (const item of items) {
      const row = rowFor(container, item.id)
      if (!row) continue
      const rect = row.getBoundingClientRect()
      const distance = focusY < rect.top ? rect.top - focusY : focusY > rect.bottom ? focusY - rect.bottom : 0
      if (!closest || distance < closest.distance) closest = { id: item.id, distance }
    }
    if (closest) setActiveId(current => current === closest.id ? current : closest.id)
  }, [containerRef, items])

  useLayoutEffect(() => {
    updateActive()
    const frame = requestAnimationFrame(updateActive)
    return () => cancelAnimationFrame(frame)
  }, [revision, updateActive])

  useEffect(() => {
    const container = containerRef.current
    if (!container || items.length < CHAT_NAV_MIN_ITEMS) return
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
  }, [containerRef, items.length, updateActive])

  if (items.length < CHAT_NAV_MIN_ITEMS) return null

  const railHeight = railHeightFor(items.length)
  const yFor = (index: number) => items.length === 1 ? railHeight / 2 : index / (items.length - 1) * railHeight

  let hoveredIndex = -1
  if (pointerY !== null) {
    let best = Infinity
    items.forEach((_, index) => {
      const d = Math.abs(yFor(index) - pointerY)
      if (d < best) { best = d; hoveredIndex = index }
    })
  }
  const hovered = hoveredIndex >= 0 ? items[hoveredIndex] : null

  const jumpTo = (item: ChatNavigationItem) => {
    const container = containerRef.current
    const row = container ? rowFor(container, item.id) : undefined
    if (!row) return
    setActiveId(item.id)
    setPointerY(null)
    onNavigate?.()
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
        {items.map((item, index) => {
          const active = item.id === activeId
          const isHovered = index === hoveredIndex
          const distance = pointerY === null ? null : Math.abs(yFor(index) - pointerY)
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Jump to ${item.title}`}
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
          <div style={styles.previewMeta}>{hovered.role === 'team' ? 'Team' : 'Codey'}</div>
          <div style={styles.previewTitle}>{hovered.title}</div>
          {hovered.preview !== hovered.title && (
            <div style={styles.previewBody}>{hovered.preview}</div>
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
  previewMeta: { color: C.fg3, fontSize: 10, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 },
  previewTitle: { color: C.fg, fontSize: 14, fontWeight: 700, lineHeight: 1.35 },
  previewBody: {
    color: C.fg2, fontSize: 12, lineHeight: 1.55, marginTop: 7,
    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
}
