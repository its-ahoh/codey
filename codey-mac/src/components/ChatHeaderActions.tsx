import React, { useEffect, useRef, useState } from 'react'
import { UIIcon } from './UIIcons'
import './chatHeaderActions.css'

/** The same controls move into a disclosure; their handlers are not duplicated. */
export function ChatHeaderActions({ compact, children, onDismiss }: {
  compact: boolean; children: React.ReactNode; onDismiss: () => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => { setOpen(false); dismiss.current() }, [compact])
  useEffect(() => {
    if (!open) return
    content.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false); dismiss.current(); trigger.current?.focus()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open])
  return <div className={`chat-header-actions${compact ? ' chat-header-actions--compact' : ''}`}>
    {compact && <button ref={trigger} type="button" className="chat-header-actions-trigger" aria-label="Chat actions" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => { setOpen(value => !value); if (open) dismiss.current() }}><UIIcon name="more" size={17} /></button>}
    {compact && open && <div className="chat-header-actions-backdrop" onClick={() => { setOpen(false); dismiss.current(); trigger.current?.focus() }} />}
    <div ref={content} className="chat-header-actions-content" hidden={compact && !open} role={compact ? 'dialog' : undefined} aria-label={compact ? 'Chat actions' : undefined}>
      {children}
    </div>
  </div>
}
