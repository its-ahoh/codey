import { TeamAvatar } from './TeamAvatar'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Chat } from '../types'
import { apiService, type BotDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { BotAvatar } from './BotAvatar'

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
  const [bots, setBots] = useState<BotDto[]>([])
  const [title, setTitle] = useState(`${chat.title} group`)
  const [context, setContext] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    void apiService.listBots().then(items => { if (alive.current) setBots(items) }).catch(err => { if (alive.current) setError(err.message) }).finally(() => { if (alive.current) setLoading(false) })
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
  const field: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, color: C.fg, padding: 9, font: 'inherit' }
  const button: React.CSSProperties = { border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, color: C.fg, padding: '8px 12px', cursor: 'pointer' }
  const botsByName = new Map(bots.map(bot => [bot.name.toLowerCase(), bot]))
  const names = [...new Set([...bots.map(bot => bot.name), ...chat.botChat!.members])]
  const query = search.trim().toLowerCase()
  const visibleNames = names.filter(name => `${name} ${botsByName.get(name.toLowerCase())?.config.displayName ?? ''} ${botsByName.get(name.toLowerCase())?.personality.role ?? ''}`.toLowerCase().includes(query))
  const labelStyle: React.CSSProperties = { display: 'grid', gap: 7, fontSize: 12, fontWeight: 600 }
  const errorLine = error.trim().split(/\r?\n/)[0] ?? ''
  const errorSummary = errorLine.length > 140 ? `${errorLine.slice(0, 137)}…` : errorLine
  const canSave = !busy && !loading && members.length >= 2 && (direct ? !!title.trim() : !locked)
  return createPortal(<div onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#0008', display: 'grid', placeItems: 'center' }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={direct ? 'Invite Bots' : 'Group members'} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) onClose()
      if (e.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary')
        if (!nodes?.length) return
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }} style={{ width: 'min(640px, calc(100vw - 32px))', minWidth: 0, boxSizing: 'border-box', flexShrink: 0, maxHeight: 'min(780px, calc(100dvh - 32px))', overflow: 'hidden', background: C.bg, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 18, boxShadow: '0 24px 80px #0004', display: 'flex', flexDirection: 'column', fontSize: 13 }}>
      <div style={{ padding: '20px 22px 16px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <TeamAvatar name={direct ? title : chat.title} members={members} bots={bots} size={34} />
          <strong style={{ fontSize: 17 }}>{direct ? 'Create a group' : 'Group members'}</strong>
        </div>
        <div style={{ color: C.fg2, lineHeight: 1.5, fontSize: 12 }}>{direct ? 'Only the context you add is shared. Your private chat stays private.' : 'New members can read the group’s history.'}</div>
      </div>
      {error && <div role="alert" style={{ color: C.red, fontSize: 12, padding: '10px 22px', flexShrink: 0, overflowWrap: 'anywhere' }}>
        {error.trim() === errorSummary ? errorSummary : <details>
          <summary style={{ cursor: 'pointer' }}>{errorSummary} <span style={{ fontSize: 11 }}>· Details</span></summary>
          <div style={{ maxHeight: 96, overflowY: 'auto', overflowX: 'hidden', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', marginTop: 6 }}>{error}</div>
        </details>}
      </div>}
      <div style={{ padding: '14px 22px', overflowY: 'auto', overflowX: 'hidden', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {direct && <label style={labelStyle}>Group name<input maxLength={120} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} style={{ ...field, fontWeight: 400 }} /></label>}
        <section aria-label="Choose Bots" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ fontSize: 12 }}>Members</strong>
            <span aria-live="polite" style={{ color: C.fg3, fontSize: 11 }}>{members.length} selected · minimum 2</span>
          </div>
          {members.length > 0 && <div aria-label="Selected Bots" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {members.map(name => <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', padding: '4px 8px 4px 4px', borderRadius: 20, background: C.surface2, border: `1px solid ${C.border}` }}>
              <BotAvatar name={name} config={botsByName.get(name.toLowerCase())?.config.avatar} size={24} />
              <span style={{ fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{botsByName.get(name.toLowerCase())?.config.displayName || name}</span>
            </span>)}
          </div>}
          <input type="search" aria-label="Search Bots" placeholder="Search by name or role…" value={search} disabled={loading || busy} onChange={e => setSearch(e.target.value)} style={field} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 6, maxHeight: 264, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box', padding: 2 }}>
            {loading ? <div role="status" style={{ gridColumn: '1 / -1', padding: 16, color: C.fg3 }}>Loading Bots…</div> : visibleNames.map(name => {
              const bot = botsByName.get(name.toLowerCase())
              const selected = members.includes(name)
              const original = direct && chat.botChat!.members.includes(name)
              const disabled = busy || (!direct && locked) || original || (!bot && !selected)
              return <label key={name} title={`${name}${original ? ' · Included' : !bot ? ' · Profile unavailable' : ''}`} style={{ display: 'flex', minWidth: 0, gap: 7, alignItems: 'center', padding: '7px 10px', border: `1px solid ${selected ? C.accent : C.border}`, borderRadius: 11, background: selected ? C.accentDim : C.surface2, cursor: disabled ? 'default' : 'pointer', opacity: !bot ? 0.65 : 1 }}>
                <BotAvatar name={name} config={bot?.config.avatar} size={30} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{botsByName.get(name.toLowerCase())?.config.displayName || name}</span>
                  {!bot && <span style={{ color: C.fg3, fontSize: 11 }}>Profile unavailable</span>}
                </span>
                <input type="checkbox" aria-label={`Include ${bot?.config.displayName || name}`} checked={selected} disabled={disabled} onChange={e => setMembers(current => e.target.checked ? [...current, name] : current.filter(n => n !== name))} style={{ accentColor: C.accent, width: 16, height: 16, flexShrink: 0, margin: 0 }} />
              </label>
            })}
            {!loading && !visibleNames.length && <div style={{ gridColumn: '1 / -1', padding: 16, textAlign: 'center', color: C.fg3 }}>No Bots match your search.</div>}
          </div>
        </section>
        {direct && <label style={labelStyle}>Context to share (optional)<textarea rows={2} maxLength={16000} value={context} disabled={busy} onChange={e => setContext(e.target.value)} placeholder="What should this group know?" style={{ ...field, resize: 'vertical', fontWeight: 400 }} /></label>}
        {!direct && locked && <div style={{ color: C.fg2, fontSize: 12 }}>Finish the current or paused group task before changing members.</div>}
        {chat.botChat?.sourceChatId && <button type="button" disabled={busy} onClick={() => { void openChatById(chat.botChat!.sourceChatId!).then(onClose).catch(err => setError(err.message)) }} style={button}>Open original private chat</button>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', padding: '14px 22px', borderTop: `1px solid ${C.border}`, background: C.surface2, flexShrink: 0 }}>
        <button type="button" disabled={busy} onClick={onClose} style={button}>Cancel</button>
        <button type="button" disabled={!canSave} onClick={() => void save()} style={{ ...button, background: C.accent, borderColor: C.accent, color: C.onAccent, fontWeight: 600, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'default' }}>{busy ? 'Saving…' : direct ? 'Create group' : 'Save members'}</button>
      </div>
    </div>
  </div>, document.body)
}
