import React, { useEffect, useRef, useState } from 'react'
import { UIIcon } from './UIIcons'
import './chatHeaderActions.css'

/** The `⋯` menu in the chat header. Children are the controls themselves, each
 *  labelled by `data-action-label`; a child that is itself a labelled button
 *  closes the menu when clicked. */
export function ChatHeaderActions({ children, onDismiss }: {
  children: React.ReactNode; onDismiss: () => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
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
  return <div className="chat-header-actions">
    <button ref={trigger} type="button" className="chat-header-actions-trigger" aria-label="Chat actions" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => { setOpen(value => !value); if (open) dismiss.current() }}><UIIcon name="more" size={17} /></button>
    {open && <div className="chat-header-actions-backdrop" onClick={() => { setOpen(false); dismiss.current(); trigger.current?.focus() }} />}
    <div ref={content} className="chat-header-actions-content" hidden={!open} role="dialog" aria-label="Chat actions"
      onClick={event => { if ((event.target as HTMLElement).closest('button[data-action-label]')) { setOpen(false); dismiss.current() } }}>
      {children}
    </div>
  </div>
}
