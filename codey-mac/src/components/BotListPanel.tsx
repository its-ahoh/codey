import { TeamAvatar } from './TeamAvatar'
import { BotCreationGuide } from './BotCreationGuide'
import { BotMessageSearchCache, botConversationList, readBotPins } from './botConversationList'
import { SidebarNavigation, SidebarFooter, SidebarAction, type SidebarCommonProps } from './SidebarNavigation'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { apiService, type BotDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { BotAvatar } from './BotAvatar'
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
  const [bots, setBots] = useState<BotDto[]>([])
  const [search, setSearch] = useState('')
  const [settledSearch, setSettledSearch] = useState('')
  const [composing, setComposing] = useState(false)
  const [searchCache] = useState(() => new BotMessageSearchCache())
  useEffect(() => {
    if (composing) return
    const timer = window.setTimeout(() => setSettledSearch(search), 200)
    return () => window.clearTimeout(timer)
  }, [search, composing])
  const searchQuery = search.trim() ? settledSearch : ''
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<'bot' | null>(null)
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
      void apiService.listBots().then(items => {
        if (alive) { setBots(items); setError('') }
      }).catch(err => { if (alive) setError(String(err.message ?? err)) })
        .finally(() => { if (alive) setLoading(false) })
    }
    refresh()
    window.addEventListener('codey:bots-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => { alive = false; window.removeEventListener('codey:bots-changed', refresh); window.removeEventListener('focus', refresh) }
  }, [])

  const open = async (name: string) => {
    if (opening) return
    setOpening(name)
    try { const chat = await openBot(name, false); if (mounted.current) { selectChat(chat.id); setError('') } }
    catch (err) { setError((err as Error).message) }
    finally { setOpening(null) }
  }
  const create = async (description: string) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const bot = await apiService.generateBot(description.trim())
      setBots(await apiService.listBots())
      window.dispatchEvent(new Event('codey:bots-changed'))
      const chat = await openBot(bot.name, false)
      if (mounted.current) selectChat(chat.id)
      setForm(null)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  const chats = useMemo(() => state.order.map(id => state.chats[id]).filter(Boolean), [state.order, state.chats])
  const rows = useMemo(() => botConversationList(bots, chats, pins, searchQuery, searchCache), [bots, chats, pins, searchQuery, searchCache])
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
    <input type="search" aria-label="Search chats and messages" placeholder="Search chats and messages" value={search} onChange={e => setSearch(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} style={field} />
    {error && !form && <div role="alert" style={{ color: C.red, fontSize: 12 }}>{error}</div>}
    <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
      {form && <div style={{ padding: 10, marginBottom: 14, border: `1px solid ${C.border}`, borderRadius: 10 }}>
        <BotCreationGuide busy={busy} error={error} onCreate={create} onCancel={() => { setForm(null); setError('') }} />
      </div>}
      {loading && <p style={{ color: C.fg3, fontSize: 12 }}>Loading chats…</p>}
      {!loading && !rows.length && <p style={{ color: C.fg3, fontSize: 12 }}>{search ? 'No matching chats.' : 'Create a Bot to start chatting. Invite other Bots from the chat to form a group.'}</p>}
      {rows.map(({ key, title, chat, bot, messageMatch }) => {
        const active = chat?.id === state.selectedChatId
        const running = !!chat && !!state.inFlight[chat.id]
        const queued = !!chat && !!state.inFlight[chat.id]?.queuedPosition
        const last = chat?.messages[chat.messages.length - 1]
        const awaiting = !running && last?.role === 'assistant' && (last.botStatus === 'askedUser' || !!last.userQuestion || !!last.choices?.length)
        const unread = chat && !active ? state.unreadChats[chat.id] : undefined
        const avatarState = queued ? 'waiting' : running ? 'working'
          : unread && (unread === 'error' || last?.botStatus === 'failed') ? 'failed'
          : awaiting ? 'reply' : unread ? 'done' : 'idle'
        const pinned = pins.includes(key)
        return <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 2, background: active ? C.accentDim : 'transparent', borderRadius: 10, marginBottom: 3 }}>
          <button onClick={() => chat ? selectChat(chat.id) : bot && void open(bot.name)} disabled={!chat && opening !== null} aria-pressed={active} style={{ ...textButton, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', textAlign: 'left', gap: 10, padding: '10px 7px' }}>
            {chat?.botChat?.kind === 'group' ? <TeamAvatar name={title} members={chat.botChat.members} bots={bots} size={34} state={avatarState} /> : <BotAvatar name={title} config={bot?.config.avatar} size={34} state={avatarState} />}
            <span style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ display: 'block', color: C.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}{chat && state.unreadChats[chat.id] ? ' ·' : ''}</strong>
              <span title={messageMatch?.snippet} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.fg3, marginTop: 4 }}>{messageMatch?.snippet ?? (opening === bot?.name ? 'Opening…' : queued ? 'Queued' : running ? 'Working' : awaiting ? 'Waiting for you' : last?.content || bot?.personality.role.split('\n')[0] || chat?.botChat?.members.join(', ') || 'Ready to chat')}</span>
              {messageMatch && <span style={{ display: 'block', fontSize: 10, color: C.accent, marginTop: 3 }}>{messageMatch.count} matching {messageMatch.count === 1 ? 'message' : 'messages'}</span>}
            </span>
          </button>
          <button style={{ ...textButton, color: pinned ? C.accent : C.fg3 }} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${title}`} title={pinned ? 'Unpin chat' : 'Pin chat'} aria-pressed={pinned} onClick={() => void togglePin(key, chat ? undefined : bot?.name)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4z" /><path d="M12 16v6" /></svg>
          </button>
          {bot && <button style={textButton} aria-label={`Edit ${bot.config.displayName || bot.name}`} title="Bot profile" onClick={() => props.onOpenSettings(`bot:${bot.name}`)}><UIIcon name="settings" size={13} /></button>}
        </div>
      })}
    </div>
    <SidebarFooter onOpenSettings={props.onOpenSettings}>
      <SidebarAction icon="bot" disabled={busy} onClick={() => setForm(form === 'bot' ? null : 'bot')}>Add Bot</SidebarAction>
    </SidebarFooter>
  </div>
}
