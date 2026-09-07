import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { WorkerAvatar } from './WorkerAvatar'
import { avatarShapes, avatarColors, type WorkerAvatarConfig } from './workerAvatarModel'
import { C } from '../theme'
import './avatarPicker.css'

export function AvatarPicker({ value, onChange, name = 'Member', size = 56 }: {
  value: WorkerAvatarConfig
  onChange: (avatar: WorkerAvatarConfig) => void
  name?: string
  size?: number
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (!open) return
    const element = dialog.current
    element?.showModal()
    return () => {
      element?.close()
      trigger.current?.focus()
    }
  }, [open])

  return <>
    <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-label={`Change ${name} avatar`}
      title="Change avatar" aria-haspopup="dialog" aria-expanded={open}
      style={{ display: 'inline-flex', padding: 0, background: 'transparent', border: 'none', borderRadius: '50%', cursor: 'pointer', lineHeight: 0 }}>
      <WorkerAvatar name={name} config={value} size={size} />
    </button>
    {open && createPortal(<dialog ref={dialog} className="member-avatar-dialog" aria-label={`Change ${name} avatar`}
      onCancel={event => { event.preventDefault(); setOpen(false) }}
      onClick={event => { if (event.target === event.currentTarget) setOpen(false) }}
      style={{ padding: 0, width: 360, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 48px)',
        margin: 'auto', border: `1px solid ${C.border}`, borderRadius: 18, color: C.fg, background: C.bg,
        boxShadow: '0 18px 70px rgba(0,0,0,.25)' }}>
      <div style={{ padding: 22 }}>
        <div role="group" aria-label="Shape">
          <div style={{ marginBottom: 10, color: C.fg3, fontSize: 12 }}>Shape</div>
          <div style={{ display: 'flex', gap: 10 }}>
            {avatarShapes.map(shape => <button type="button" key={shape} aria-label={shape} aria-pressed={value.shape === shape}
              autoFocus={value.shape === shape} onClick={() => onChange({ ...value, shape })}
              style={{ background: C.surface2, border: `2px solid ${value.shape === shape ? C.accent : C.border}`, borderRadius: 12, padding: 5, cursor: 'pointer' }}>
              <WorkerAvatar name={shape} config={{ ...value, shape }} size={44} />
            </button>)}
          </div>
        </div>
        <div role="group" aria-label="Color" style={{ marginTop: 20 }}>
          <div style={{ marginBottom: 12, color: C.fg3, fontSize: 12 }}>Color</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 32px)', gap: 14 }}>
            {avatarColors.map(color => <button type="button" key={color} aria-label={`Color ${color}`} aria-pressed={value.color === color}
              onClick={() => onChange({ ...value, color })}
              style={{ width: 32, height: 32, background: color, border: `3px solid ${value.color === color ? C.fg : 'transparent'}`, borderRadius: '50%', cursor: 'pointer' }} />)}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button type="button" onClick={() => setOpen(false)} style={{ border: 'none', borderRadius: 8, padding: '8px 18px',
            background: C.accent, color: C.onAccent, fontWeight: 600, cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </dialog>, document.body)}
  </>
}
