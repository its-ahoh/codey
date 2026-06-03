import React, { useEffect, useState } from 'react'
import { useChats } from '../hooks/useChats'
import { apiService } from '../services/api'
import type { Chat } from '../types'
import { C } from '../theme'
import { RouteIcons } from './RouteIcons'
import { UpdateButton } from './UpdateButton'
import { setPendingPairing } from './pendingPairing'

interface Props {
  onOpenSettings: (tab?: string) => void
  activeChatId: string | null
}

interface WsMenuState {
  workspace: string
  x: number
  y: number
}

export const ChatListPanel: React.FC<Props> = ({ onOpenSettings, activeChatId }) => {
  const { state, createChat, selectChat, renameChat, deleteChat, toggleWorkspace, refreshWorkspaces, linkChannel, unlinkChannel } = useChats()
  const [addingWorkspace, setAddingWorkspace] = useState(false)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [lastWorkspace, setLastWorkspace] = useState<string>('')
  const [gatewayWorkspace, setGatewayWorkspace] = useState<string>('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [wsMenu, setWsMenu] = useState<WsMenuState | null>(null)
  const [renamingWs, setRenamingWs] = useState<string | null>(null)
  const [wsRenameValue, setWsRenameValue] = useState('')
  const [chatMenu, setChatMenu] = useState<{ chat: Chat; x: number; y: number } | null>(null)
  const [chatMenuView, setChatMenuView] = useState<'main' | 'connect'>('main')
  // Shrink the panel on narrow windows so the conversation column keeps
  // breathing room. Matches the threshold used in ChatTab for the context panel.
  const [narrow, setNarrow] = useState<boolean>(() => window.innerWidth < 600)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 600)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      apiService.getCurrentWorkspace()
        .then(w => { if (!cancelled) setGatewayWorkspace(w) })
        .catch(() => {})
      apiService.getWorkspaces()
        .then(w => {
          if (cancelled) return
          setWorkspaces(w)
          setLastWorkspace(prev => {
            if (prev && w.includes(prev)) return prev
            const stored = localStorage.getItem('codey.lastWorkspace')
            if (stored && w.includes(stored)) return stored
            return w[0] ?? ''
          })
        })
        .catch(() => {})
    }
    refresh()
    const id = setInterval(refresh, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (lastWorkspace) localStorage.setItem('codey.lastWorkspace', lastWorkspace)
  }, [lastWorkspace])

  const handleNewChat = async (workspaceName?: string) => {
    const target = workspaceName || lastWorkspace
    if (!target) return
    const chat = await createChat(target)
    setLastWorkspace(chat.workspaceName)
  }

  const closeWsMenu = () => setWsMenu(null)

  const beginRenameWs = (ws: string) => {
    closeWsMenu()
    if (ws === 'default') {
      alert('The "default" workspace is protected and cannot be renamed.')
      return
    }
    setRenamingWs(ws)
    setWsRenameValue(ws)
  }

  const commitRenameWs = async () => {
    const oldName = renamingWs
    const newName = wsRenameValue.trim()
    setRenamingWs(null)
    if (!oldName || !newName || newName === oldName) return
    try {
      await apiService.renameWorkspace(oldName, newName)
      const fresh = await apiService.getWorkspaces()
      setWorkspaces(fresh)
      await refreshWorkspaces()
      if (lastWorkspace === oldName) setLastWorkspace(newName)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rename workspace')
    }
  }

  const deleteWs = async (ws: string) => {
    closeWsMenu()
    if (ws === 'default') {
      alert('The "default" workspace is protected and cannot be deleted.')
      return
    }
    if (!confirm(`Delete workspace "${ws}" and all its chats?`)) return
    try {
      await apiService.deleteWorkspace(ws)
      const fresh = await apiService.getWorkspaces()
      setWorkspaces(fresh)
      await refreshWorkspaces()
      if (lastWorkspace === ws) setLastWorkspace(fresh[0] ?? '')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete workspace')
    }
  }

  const setAsGateway = async (ws: string) => {
    closeWsMenu()
    try {
      await apiService.switchWorkspace(ws)
      const w = await apiService.getCurrentWorkspace()
      setGatewayWorkspace(w)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to switch workspace')
    }
  }

  const revealWs = async (ws: string) => {
    closeWsMenu()
    try {
      await apiService.revealWorkspace(ws)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to reveal workspace')
    }
  }

  const editMemoryWs = (ws: string) => {
    closeWsMenu()
    setLastWorkspace(ws)
    onOpenSettings('workspaces')
  }

  useEffect(() => {
    if (!wsMenu && !chatMenu) return
    const onClick = () => { setWsMenu(null); setChatMenu(null) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setWsMenu(null); setChatMenu(null) }
    }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [wsMenu, chatMenu])

  const handleAddWorkspace = async () => {
    if (addingWorkspace) return
    setAddingWorkspace(true)
    try {
      const dir = await apiService.pickDirectory()
      if (!dir) return
      const name = await apiService.createWorkspaceFromDir(dir)
      const fresh = await apiService.getWorkspaces()
      setWorkspaces(fresh)
      await refreshWorkspaces()
      const chat = await createChat(name)
      setLastWorkspace(chat.workspaceName)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to add workspace')
    } finally {
      setAddingWorkspace(false)
    }
  }

  const groups: Record<string, Chat[]> = {}
  for (const id of state.order) {
    const c = state.chats[id]
    if (!c) continue
    ;(groups[c.workspaceName] ??= []).push(c)
  }
  for (const ws of workspaces) {
    if (!groups[ws]) groups[ws] = []
  }
  const groupNames = Object.keys(groups).sort()

  return (
    <div style={{ ...styles.root, width: narrow ? 180 : 240 }}>
      <div style={styles.scroll}>
        {groupNames.length === 0 && (
          <div style={styles.empty}>No chats yet. Click "New Chat".</div>
        )}
        {groupNames.map(ws => {
          const collapsed = !!state.collapsedWorkspaces[ws]
          return (
            <div key={ws}>
              <div
                style={styles.groupHeader}
                onClick={() => renamingWs === ws ? null : toggleWorkspace(ws)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setWsMenu({ workspace: ws, x: e.clientX, y: e.clientY })
                }}
              >
                <span style={styles.chevron}>{collapsed ? '📁︎' : '📂︎'}</span>
                {renamingWs === ws ? (
                  <input
                    autoFocus
                    value={wsRenameValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={e => setWsRenameValue(e.target.value)}
                    onBlur={commitRenameWs}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      else if (e.key === 'Escape') { setRenamingWs(null) }
                    }}
                    style={styles.renameInput}
                  />
                ) : (
                  <span style={styles.groupName}>{ws}</span>
                )}
                {ws === gatewayWorkspace && (
                  <span style={styles.gatewayBadge} title="Gateway default workspace — receives messages from chat platforms"/>
                )}
                <button
                  style={styles.groupAddBtn}
                  onClick={(e) => { e.stopPropagation(); handleNewChat(ws) }}
                  title={`New chat in "${ws}"`}
                >+</button>
              </div>
              {!collapsed && groups[ws].map(chat => {
                const active = chat.id === activeChatId
                const flight = state.inFlight[chat.id]
                const unread = !!state.unreadChats[chat.id]
                const isRenaming = renamingId === chat.id
                const orphaned = workspaces.length > 0 && !workspaces.includes(chat.workspaceName)
                return (
                  <div
                    key={chat.id}
                    title={orphaned ? 'Workspace deleted' : undefined}
                    style={{ ...styles.item, background: active ? C.accentDim : 'transparent', opacity: orphaned ? 0.5 : 1 }}
                    onClick={() => !isRenaming && selectChat(chat.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenamingId(chat.id)
                      setRenameValue(chat.title)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setChatMenuView('main')
                      setChatMenu({ chat, x: e.clientX, y: e.clientY })
                    }}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={async () => {
                          if (renameValue.trim() && renameValue !== chat.title) {
                            await renameChat(chat.id, renameValue.trim())
                          }
                          setRenamingId(null)
                        }}
                        onKeyDown={async e => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur()
                          } else if (e.key === 'Escape') {
                            setRenamingId(null)
                          }
                        }}
                        style={styles.renameInput}
                      />
                    ) : (
                      <span style={styles.title}>{chat.title}</span>
                    )}
                    <RouteIcons routes={chat.routes} />
                    {unread && !active && <span style={styles.unreadDot} />}
                    {flight && <span style={styles.dot} />}
                    {!isRenaming && (
                      <button
                        style={styles.xBtn}
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (confirm(`Delete chat "${chat.title}"?`)) {
                            await deleteChat(chat.id)
                          }
                        }}
                        title="Delete chat"
                      >×</button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div style={styles.footer}>
          <UpdateButton />
          <button
          style={styles.settingsBtn}
          onClick={handleAddWorkspace}
          disabled={addingWorkspace}
          title="Pick a folder and create a new workspace + chat"
        >{addingWorkspace ? 'Picking…' : '+ Add Workspace'}</button>
        <button style={styles.settingsBtn} onClick={() => onOpenSettings()}>⚙ Settings</button>
      </div>
      {wsMenu && (
        <div
          style={{ ...styles.menu, top: wsMenu.y, left: wsMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={styles.menuHeader}>{wsMenu.workspace}</div>
          <button style={styles.menuItem} onClick={() => handleNewChat(wsMenu.workspace).then(closeWsMenu)}>＋ New chat</button>
          <button
            style={{ ...styles.menuItem, opacity: wsMenu.workspace === 'default' ? 0.4 : 1 }}
            disabled={wsMenu.workspace === 'default'}
            onClick={() => beginRenameWs(wsMenu.workspace)}
          >✎ Rename…</button>
          <button
            style={styles.menuItem}
            onClick={() => setAsGateway(wsMenu.workspace)}
            disabled={wsMenu.workspace === gatewayWorkspace}
          >★ Set as Gateway default</button>
          <button style={styles.menuItem} onClick={() => revealWs(wsMenu.workspace)}>↗ Reveal in Finder</button>
          <button style={styles.menuItem} onClick={() => editMemoryWs(wsMenu.workspace)}>✦ Edit memory…</button>
          <div style={styles.menuSep} />
          <button
            style={{ ...styles.menuItem, color: C.red, opacity: wsMenu.workspace === 'default' ? 0.4 : 1 }}
            disabled={wsMenu.workspace === 'default'}
            onClick={() => deleteWs(wsMenu.workspace)}
          >✕ Delete workspace</button>
        </div>
      )}
      {chatMenu && (
        <div
          style={{ ...styles.menu, top: chatMenu.y, left: chatMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={styles.menuHeader}>{chatMenu.chat.title}</div>
          {chatMenuView === 'main' ? (
            <>
              <button
                style={styles.menuItem}
                onClick={() => setChatMenuView('connect')}
              >🔗 Connect to channel...</button>
              <button
                style={styles.menuItem}
                onClick={() => {
                  const c = chatMenu.chat
                  setChatMenu(null)
                  setRenamingId(c.id)
                  setRenameValue(c.title)
                }}
              >✎ Rename…</button>
              <button
                style={styles.menuItem}
                onClick={async () => {
                  try { await navigator.clipboard.writeText(chatMenu.chat.id) } catch {}
                  setChatMenu(null)
                }}
              >⧉ Copy chat ID</button>
              <div style={styles.menuSep} />
              <button
                style={{ ...styles.menuItem, color: C.red }}
                onClick={async () => {
                  const c = chatMenu.chat
                  setChatMenu(null)
                  if (confirm(`Delete chat "${c.title}"?`)) {
                    await deleteChat(c.id)
                  }
                }}
              >✕ Delete chat</button>
            </>
          ) : (
            <>
              <button style={styles.menuItem} onClick={() => setChatMenuView('main')}>⬅ Back</button>
              {(['telegram', 'discord', 'imessage'] as const).map(ch => {
                const linked = chatMenu.chat.routes?.find(r => r.channel === ch)
                const label = ch === 'telegram' ? '✈ Telegram' : ch === 'discord' ? '◈ Discord' : '◐ iMessage'
                return (
                  <button
                    key={ch}
                    style={{
                      ...styles.menuItem,
                      ...(linked ? { color: C.red } : {}),
                    }}
                    onClick={async () => {
                      const c = chatMenu.chat
                      setChatMenu(null)
                      if (linked) {
                        await unlinkChannel(c.id, linked.channel, linked.channelUserId)
                        return
                      }
                      setPendingPairing(c.id, ch)
                      selectChat(c.id)
                      window.dispatchEvent(new Event('pendingPairing'))
                    }}
                  >{linked ? `✕ Disconnect ${label}` : label}</button>
                )
              })}
            </>
          )}
        </div>
      )}
      <style>{`
        @keyframes codey-pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.7); }
        }
      `}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: 240,
    background: C.surface,
    borderRight: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  header: { padding: '10px 12px', borderBottom: `1px solid ${C.border}` },
  newBtn: {
    width: '100%',
    padding: '8px 10px',
    border: `1px solid ${C.border2}`,
    borderRadius: 6,
    background: C.surface3,
    color: C.fg,
    cursor: 'pointer',
    fontSize: 12,
  },
  scroll: { flex: 1, overflowY: 'auto', padding: 6 },
  empty: { color: C.fg3, fontSize: 12, padding: 12, textAlign: 'center' },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 8px', color: C.fg3, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', userSelect: 'none',
  },
  groupName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  groupAddBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px',
  },
  gatewayBadge: {
    width: 8, height: 8, borderRadius: '50%',
    background: C.green, boxShadow: `0 0 6px ${C.green}`,
    flexShrink: 0,  
  },
  chevron: { display: 'inline-block', fontSize: 12, lineHeight: 1, transition: 'transform 0.15s ease' },
  item: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, color: C.fg2, margin: '1px 2px',
  },
  title: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  renameInput: {
    flex: 1, background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 4, padding: '2px 6px', color: C.fg, fontSize: 12, outline: 'none',
  },
  dot: { width: 6, height: 6, borderRadius: '50%', background: C.accent, animation: 'codey-pulse-dot 1.2s infinite' },
  unreadDot: { width: 6, height: 6, borderRadius: '50%', background: C.accent, flexShrink: 0 },
  xBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 14, padding: '0 4px',
  },
  footer: { padding: 8, borderTop: `1px solid ${C.border}` },
  settingsBtn: {
    width: '100%', padding: '8px 10px', border: 'none',
    background: 'transparent', color: C.fg2, cursor: 'pointer',
    textAlign: 'left', borderRadius: 6, fontSize: 13,
  },
  menu: {
    position: 'fixed', zIndex: 1000,
    minWidth: 180, padding: 4,
    background: C.surface2 ?? C.surface,
    border: `1px solid ${C.border2}`,
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    display: 'flex', flexDirection: 'column',
  },
  menuHeader: {
    padding: '4px 10px 6px', fontSize: 11, color: C.fg3,
    borderBottom: `1px solid ${C.border}`, marginBottom: 4,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  menuItem: {
    background: 'transparent', border: 'none', textAlign: 'left',
    padding: '6px 10px', borderRadius: 4, color: C.fg2,
    fontSize: 12, cursor: 'pointer',
  },
  menuSep: { height: 1, background: C.border, margin: '4px 0' },
}
