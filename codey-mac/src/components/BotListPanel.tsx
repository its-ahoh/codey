import { botConversationList, readBotPins } from './botConversationList'
import { SidebarNavigation, SidebarFooter, SidebarAction, type SidebarCommonProps } from './SidebarNavigation'
import React, { useEffect, useRef, useState } from 'react'
import { apiService, type WorkerDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { WorkerAvatar } from './WorkerAvatar'
import { UIIcon } from './UIIcons'

interface Props extends SidebarCommonProps {
  newBotRequested: boolean
  onNewBotHandled: () => void
}

export function BotListPanel(props: Props) {
  const { newBotRequested, onNewBotHandled } = props
  const { state, openBot, selectChat } = useChats()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [bots, setBots] = useState<WorkerDto[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<'bot' | null>(null)
  const [description, setDescription] = useState('')
  const [pins, setPins] = useState(() => readBotPins(localStorage.getItem('codey.botChatPins')))
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    if (newBotRequested) {
      setForm('bot')
      onNewBotHandled()
    }
  }, [newBotRequested, onNewBotHandled])

  useEffect(() => {
    let alive = true
    const refresh = () => {
      void apiService.listWorkers().then(items => {
        if (alive) { setBots(items); setError('') }
      }).catch(err => { if (alive) setError(String(err.message ?? err)) })
        .finally(() => { if (alive) setLoading(false) })
    }
    refresh()
    window.addEventListener('codey:workers-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => { alive = false; window.removeEventListener('codey:workers-changed', refresh); window.removeEventListener('focus', refresh) }
  }, [])

  const open = async (name: string) => {
    if (opening) return
    setOpening(name)
    try { const chat = await openBot(name, false); if (mounted.current) { selectChat(chat.id); setError('') } }
    catch (err) { setError((err as Error).message) }
    finally { setOpening(null) }
  }
  const create = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const bot = await apiService.generateWorker(description.trim())
      setBots(await apiService.listWorkers())
      window.dispatchEvent(new Event('codey:workers-changed'))
      const chat = await openBot(bot.name, false)
      if (mounted.current) selectChat(chat.id)
      setDescription('')
      setForm(null)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  const chats = state.order.map(id => state.chats[id]).filter(Boolean)
  const rows = botConversationList(bots, chats, pins, search)
  const togglePin = async (key: string, botName?: string) => {
    try {
      const id = botName ? (await openBot(botName, false)).id : key
      setPins(previous => {
        const next = previous.includes(id) ? previous.filter(pin => pin !== id) : [...previous, id]
        localStorage.setItem('codey.botChatPins', JSON.stringify(next))
        return next
      })
    } catch (err) { setError((err as Error).message) }
  }
  const textButton = { background: 'transparent', color: C.fg2, border: 'none', borderRadius: 7, cursor: 'pointer', padding: '7px 9px', fontSize: 12 } as const
  const field = { width: '100%', background: C.bg, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 9, fontFamily: 'inherit', fontSize: 12 } as const
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 8, gap: 8, background: C.sidebarBg }}>
    <SidebarNavigation {...props} />
    <input type="search" aria-label="Search chats and messages" placeholder="Search chats and messages" value={search} onChange={e => setSearch(e.target.value)} style={field} />
    {error && <div role="alert" style={{ color: C.red, fontSize: 12 }}>{error}</div>}
    <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
      {form && <form onSubmit={e => { e.preventDefault(); void create() }} style={{ display: 'grid', gap: 8, padding: 10, marginBottom: 14, border: `1px solid ${C.border}`, borderRadius: 10 }}>
        <strong style={{ fontSize: 12 }}>Describe your Bot</strong>
        <textarea autoFocus aria-label="Bot description" required rows={4} value={description} onChange={e => setDescription(e.target.value)} placeholder="A designer who helps me shape product ideas…" style={field} disabled={busy} />
        <button style={{ ...textButton, background: C.accent, color: C.onAccent }} disabled={busy || !description.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        <button type="button" style={textButton} disabled={busy} onClick={() => setForm(null)}>Cancel</button>
      </form>}
      {loading && <p style={{ color: C.fg3, fontSize: 12 }}>Loading chats…</p>}
      {!loading && !rows.length && <p style={{ color: C.fg3, fontSize: 12 }}>{search ? 'No matching chats.' : 'Create a Bot to start chatting. Invite other Bots from the chat to form a group.'}</p>}
      {rows.map(({ key, title, chat, bot, messageMatch }) => {
        const active = chat?.id === state.selectedChatId
        const running = !!chat && !!state.inFlight[chat.id]
        const queued = !!chat && !!state.inFlight[chat.id]?.queuedPosition
        const last = chat?.messages[chat.messages.length - 1]
        const awaiting = !running && last?.role === 'assistant' && (!!last.userQuestion || !!last.choices?.length)
        const pinned = pins.includes(key)
        return <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 2, background: active ? C.accentDim : 'transparent', borderRadius: 10, marginBottom: 3 }}>
          <button onClick={() => chat ? selectChat(chat.id) : bot && void open(bot.name)} disabled={!chat && opening !== null} aria-pressed={active} style={{ ...textButton, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', textAlign: 'left', gap: 10, padding: '10px 7px' }}>
            {chat?.botChat?.kind === 'group' ? <span style={{ width: 34, flexShrink: 0, display: 'grid', placeItems: 'center' }}><UIIcon name="users" size={26} /></span> : <WorkerAvatar name={title} config={bot?.config.avatar} size={34} state={queued ? 'waiting' : running ? 'working' : awaiting ? 'reply' : 'idle'} />}
            <span style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ display: 'block', color: C.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}{chat && state.unreadChats[chat.id] ? ' ·' : ''}</strong>
              <span title={messageMatch?.snippet} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.fg3, marginTop: 4 }}>{messageMatch?.snippet ?? (opening === bot?.name ? 'Opening…' : queued ? 'Queued' : running ? 'Working' : awaiting ? 'Waiting for you' : last?.content || bot?.personality.role.split('\n')[0] || chat?.botChat?.members.join(', ') || 'Ready to chat')}</span>
              {messageMatch && <span style={{ display: 'block', fontSize: 10, color: C.accent, marginTop: 3 }}>{messageMatch.count} matching {messageMatch.count === 1 ? 'message' : 'messages'}</span>}
            </span>
          </button>
          <button style={{ ...textButton, color: pinned ? C.accent : C.fg3 }} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${title}`} title={pinned ? 'Unpin chat' : 'Pin chat'} aria-pressed={pinned} onClick={() => void togglePin(key, chat ? undefined : bot?.name)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4z" /><path d="M12 16v6" /></svg>
          </button>
          {bot && <button style={textButton} aria-label={`Edit ${bot.name}`} title="Bot profile" onClick={() => props.onOpenSettings(`bot:${bot.name}`)}><UIIcon name="settings" size={13} /></button>}
        </div>
      })}
    </div>
    <SidebarFooter onOpenSettings={props.onOpenSettings}>
      <SidebarAction icon="bot" disabled={busy} onClick={() => setForm(form === 'bot' ? null : 'bot')}>Add Bot</SidebarAction>
    </SidebarFooter>
  </div>
}
