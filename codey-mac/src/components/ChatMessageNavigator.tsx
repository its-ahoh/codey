import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { C } from '../theme'

export const CHAT_NAV_MIN_ITEMS = 8

export interface ChatNavigationItem {
  id: string
  title: string
  preview: string
  role: 'user' | 'assistant' | 'team'
}

interface Props {
  containerRef: React.RefObject<HTMLDivElement>
  items: ChatNavigationItem[]
  revision: string
  onNavigate?: () => void
}

const rowFor = (container: HTMLDivElement, id: string): HTMLElement | undefined =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-chat-navigation-id]'))
    .find(row => row.dataset.chatNavigationId === id)

/** A compact message map for long transcripts. The native scrollbar still
 * handles free scrolling; these markers provide semantic, message-level jumps. */
export const ChatMessageNavigator: React.FC<Props> = ({ containerRef, items, revision, onNavigate }) => {
  const [activeId, setActiveId] = useState<string | null>(() => items.at(-1)?.id ?? null)
  const [hovered, setHovered] = useState<{ item: ChatNavigationItem; top: number; right: number } | null>(null)

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

  const jumpTo = (item: ChatNavigationItem) => {
    const container = containerRef.current
    const row = container ? rowFor(container, item.id) : undefined
    if (!row) return
    setActiveId(item.id)
    setHovered(null)
    onNavigate?.()
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <>
      <nav
        style={{ ...styles.rail, height: Math.min(420, Math.max(140, (items.length - 1) * 20)) }}
        aria-label="Conversation message navigation"
      >
        {items.map((item, index) => {
          const active = item.id === activeId
          const width = active ? 40 : Math.min(28, 8 + Math.round(item.preview.length / 18) * 4)
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Jump to ${item.title}`}
              aria-current={active ? 'location' : undefined}
              style={{
                ...styles.markerButton,
                top: items.length === 1 ? '50%' : `${index / (items.length - 1) * 100}%`,
              }}
              onClick={() => jumpTo(item)}
              onMouseEnter={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                setHovered({
                  item,
                  top: Math.max(12, Math.min(window.innerHeight - 150, rect.top - 42)),
                  right: Math.max(18, window.innerWidth - rect.left + 12),
                })
              }}
              onMouseLeave={() => setHovered(current => current?.item.id === item.id ? null : current)}
            >
              <span style={{
                ...styles.marker,
                width,
                background: active ? C.fg : C.fg3,
                opacity: active ? 0.96 : 0.55,
              }} />
            </button>
          )
        })}
      </nav>
      {hovered && createPortal(
        <div style={{ ...styles.previewCard, top: hovered.top, right: hovered.right }} role="tooltip">
          <div style={styles.previewMeta}>{hovered.item.role === 'user' ? 'You' : hovered.item.role === 'team' ? 'Team' : 'Codey'}</div>
          <div style={styles.previewTitle}>{hovered.item.title}</div>
          {hovered.item.preview !== hovered.item.title && (
            <div style={styles.previewBody}>{hovered.item.preview}</div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  rail: {
    position: 'absolute', zIndex: 18, right: 7, top: '50%',
    width: 46, maxHeight: 'calc(100% - 48px)', pointerEvents: 'none',
    transform: 'translateY(-50%)',
  },
  markerButton: {
    position: 'absolute', right: 0, width: 46, height: 18, padding: 0,
    border: 'none', background: 'transparent', cursor: 'pointer', pointerEvents: 'auto',
    display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
    transform: 'translateY(-50%)',
  },
  marker: { height: 3, borderRadius: 2, transition: 'width 0.14s ease, opacity 0.14s ease, background 0.14s ease' },
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
