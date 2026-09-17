import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Chat } from '../types'
import { apiService, type WorkerDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'

export function BotMembers({ chat, running }: { chat: Chat; running: boolean }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" onClick={() => setOpen(true)} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 7, color: C.fg2, padding: '5px 9px', cursor: 'pointer', fontSize: 11 }}>
      {chat.botChat?.kind === 'group' ? `${chat.botChat.members.length} Bots · Members` : '+ Invite Bot'}
    </button>
    {open && <MembersDialog chat={chat} locked={running || !!chat.pendingTeam} onClose={() => setOpen(false)} />}
  </>
}

function MembersDialog({ chat, locked, onClose }: { chat: Chat; locked: boolean; onClose: () => void }) {
  const { openChatById } = useChats()
  const direct = chat.botChat!.kind === 'direct'
  const [members, setMembers] = useState([...chat.botChat!.members])
  const [bots, setBots] = useState<WorkerDto[]>([])
  const [title, setTitle] = useState(`${chat.title} group`)
  const [context, setContext] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    void apiService.listWorkers().then(setBots).catch(err => setError(err.message)).finally(() => setLoading(false))
    return () => { alive.current = false; previous?.focus() }
  }, [])
  const save = async () => {
    setBusy(true); setError('')
    try {
      const result = direct
        ? await apiService.chats.inviteBots(chat.id, title, members, context)
        : await apiService.chats.updateBotGroup(chat.id, members)
      if (alive.current) { await openChatById(result.id); onClose() }
    } catch (err) { if (alive.current) setError((err as Error).message) }
    finally { if (alive.current) setBusy(false) }
  }
  const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, color: C.fg, padding: 9, font: 'inherit' }
  const button: React.CSSProperties = { border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, color: C.fg, padding: '8px 12px', cursor: 'pointer' }
  const names = [...new Set([...bots.map(bot => bot.name), ...chat.botChat!.members])]
  return createPortal(<div onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#0008', display: 'grid', placeItems: 'center' }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={direct ? 'Invite Bots' : 'Group members'} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) onClose()
      if (e.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
        if (!nodes?.length) return
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }} style={{ width: 430, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', background: C.bg, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22, display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
      <strong>{direct ? 'Invite Bots to a group' : 'Group members'}</strong>
      <div style={{ color: C.fg2, lineHeight: 1.5 }}>{direct ? 'Your direct chat stays private. Create a linked group and choose what context to share.' : 'New members can read this group’s history. Removed members keep their past messages but receive no future turns.'}</div>
      {direct && <label>Group name<input maxLength={120} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} style={field} /></label>}
      {loading ? <div>Loading Bots…</div> : names.map(name => <label key={name} style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
        <input type="checkbox" checked={members.includes(name)} disabled={busy || (!direct && locked) || (direct && chat.botChat!.members.includes(name))} onChange={e => setMembers(current => e.target.checked ? [...current, name] : current.filter(n => n !== name))} />
        {name}{!bots.some(bot => bot.name === name) && ' (unavailable)'}
      </label>)}
      {direct && <label>Context to share (optional)<textarea rows={5} maxLength={16000} value={context} disabled={busy} onChange={e => setContext(e.target.value)} placeholder="Add the goal, decisions, or messages you want this group to know." style={{ ...field, resize: 'vertical' }} /></label>}
      {!direct && locked && <div style={{ color: C.fg2 }}>Finish the current or paused group task before changing members.</div>}
      {error && <div role="alert" style={{ color: C.red }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" disabled={busy} onClick={onClose} style={button}>Cancel</button>
        <button type="button" disabled={busy || loading || members.length < 2 || (direct ? !title.trim() : locked)} onClick={() => void save()} style={{ ...button, color: C.accent }}>{busy ? 'Saving…' : direct ? 'Create group' : 'Save members'}</button>
      </div>
      {chat.botChat?.sourceChatId && <button type="button" disabled={busy} onClick={() => { void openChatById(chat.botChat!.sourceChatId!).then(onClose).catch(err => setError(err.message)) }} style={button}>Open original private chat</button>}
    </div>
  </div>, document.body)
}
