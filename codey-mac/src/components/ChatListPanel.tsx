import React, { useCallback, useEffect, useState } from 'react'
import { useChats } from '../hooks/useChats'
import { apiService } from '../services/api'
import type { Chat } from '../types'
import { C } from '../theme'
import { RouteIcons } from './RouteIcons'
import { UpdateButton } from './UpdateButton'
import { setPendingPairing } from './pendingPairing'
import { onWorkspacesChanged } from './workspacesChanged'
import { UIIcon } from './UIIcons'
import { moveWorkspace, reconcileWorkspaceOrder } from './workspaceOrder'

interface Props {
  onOpenSettings: (tab?: string) => void
  onOpenAutomations: () => void
  onOpenBrowser: () => void
  onOpenTools: () => void
  onSelectChat: () => void
  automationsUnseenCount: number
  activeChatId: string | null
}

interface WsMenuState {
  workspace: string
  x: number
  y: number
}

export const ChatListPanel: React.FC<Props> = ({ onOpenSettings, onOpenAutomations, onOpenBrowser, onOpenTools, onSelectChat, automationsUnseenCount, activeChatId }) => {
  const { state, createChat, selectChat, renameChat, deleteChat, toggleWorkspace, refreshWorkspaces, refreshChats, linkChannel, unlinkChannel } = useChats()
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
  const [wsOrder, setWsOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('codey.workspaceOrder') || '[]')
      return Array.isArray(saved) ? saved : []
    } catch { return [] }
  })
  const [draggingWs, setDraggingWs] = useState<string | null>(null)
  const [dragOverWs, setDragOverWs] = useState<string | null>(null)
  const refreshWs = useCallback(() => {
    apiService.getCurrentWorkspace()
      .then(setGatewayWorkspace)
      .catch(() => {})
    apiService.getWorkspaces()
      .then(w => {
        setWorkspaces(w)
        setWsOrder(prev => reconcileWorkspaceOrder(prev, w))
        setLastWorkspace(prev => {
          if (prev && w.includes(prev)) return prev
          const stored = localStorage.getItem('codey.lastWorkspace')
          if (stored && w.includes(stored)) return stored
          return w[0] ?? ''
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshWs()
    const id = setInterval(refreshWs, 5000)
    // Refresh immediately when a workspace is added/removed/renamed in the
    // Settings overlay, instead of waiting up to 5s for the next poll. A delete
    // also removes that workspace's chats, so reload the chat list too — the
    // sidebar groups are derived from state.chats, not the workspace array.
    const off = onWorkspacesChanged(() => { refreshWs(); refreshChats() })
    return () => { clearInterval(id); off() }
  }, [refreshWs, refreshChats])

  useEffect(() => {
    if (lastWorkspace) localStorage.setItem('codey.lastWorkspace', lastWorkspace)
  }, [lastWorkspace])

  useEffect(() => {
    localStorage.setItem('codey.workspaceOrder', JSON.stringify(wsOrder))
  }, [wsOrder])

  const selectedWorkspace = activeChatId ? state.chats[activeChatId]?.workspaceName : undefined
  const newChatWorkspace = selectedWorkspace || lastWorkspace

  const handleNewChat = async (workspaceName?: string) => {
    const target = workspaceName || selectedWorkspace || lastWorkspace
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
      setWsOrder(prev => reconcileWorkspaceOrder(
        prev.map(name => name === oldName ? newName : name),
        fresh,
      ))
      await refreshWorkspaces()
      // Rename cascades to the chats' workspaceName on the backend; reload them
      // so they regroup under the new name instead of stranding the old group.
      await refreshChats()
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
      setWsOrder(prev => reconcileWorkspaceOrder(prev, fresh))
      await refreshWorkspaces()
      // Deleting a workspace also deletes its chats; drop them from the store so
      // the group disappears instead of lingering until a reload.
      await refreshChats()
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
      setWsOrder(prev => reconcileWorkspaceOrder(prev, fresh))
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
  // The backend supplies the newest-added-first default. wsOrder preserves any
  // drag override, while reconciliation inserts newly added workspaces on top.
  const orderIndex = new Map(wsOrder.map((name, index) => [name, index]))
  const groupNames = Object.keys(groups).sort((a, b) => {
    const ia = orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER
    const ib = orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER
    return ia !== ib ? ia - ib : a.localeCompare(b)
  })

  const reorderWs = (dragged: string, target: string) => {
    setWsOrder(prev => moveWorkspace(prev, dragged, target))
  }

  return (
    <div style={styles.root}>
      <div style={styles.brandArea}>
        <button
          style={styles.newChatBtn}
          onClick={() => handleNewChat()}
          disabled={!newChatWorkspace}
          title={newChatWorkspace ? `New chat in ${newChatWorkspace}` : 'No workspace available'}
        >
          <UIIcon name="add" size={16} strokeWidth={2.1} />
          <span>New chat</span>
          {newChatWorkspace && <span style={styles.newChatWorkspace}>{newChatWorkspace}</span>}
        </button>
      </div>
      <div style={styles.functionSection}>
        <div style={styles.sectionLabel}>Quick access</div>
        <div style={styles.topNav}>
        <button style={styles.navButton} onClick={onOpenAutomations}>
          <span style={styles.navIcon}><UIIcon name="activity" size={16} /></span>
          <span>Automations</span>
          {automationsUnseenCount > 0 && (
            <span style={styles.navBadge}>{automationsUnseenCount > 9 ? '9+' : automationsUnseenCount}</span>
          )}
        </button>
        <button style={styles.navButton} onClick={onOpenBrowser} title="Browse the web in Codey">
          <span style={styles.navIcon}><UIIcon name="globe" size={16} /></span><span>Browser</span>
        </button>
        <button style={styles.navButton} onClick={onOpenTools} title="Skills & playbooks">
          <span style={styles.navIcon}><UIIcon name="tools" size={16} /></span><span>Tools</span>
        </button>
        </div>
      </div>
      <div style={styles.chatSection}>
        <div style={styles.chatSectionHeader}><span>Chats</span><span>{state.order.length}</span></div>
        <div style={styles.scroll}>
        {groupNames.length === 0 && (
          <div style={styles.empty}>No chats yet. Click "New Chat".</div>
        )}
        {groupNames.map(ws => {
          const collapsed = !!state.collapsedWorkspaces[ws]
          const unreadCount = groups[ws].reduce(
            (count, chat) => count + (state.unreadChats[chat.id] ? 1 : 0),
            0,
          )
          const runningCount = groups[ws].reduce(
            (count, chat) => count + (state.inFlight[chat.id] ? 1 : 0),
            0,
          )
          const attentionCount = groups[ws].reduce(
            (count, chat) => count + (state.pendingPermissions[chat.id] ? 1 : 0),
            0,
          )
          return (
            <div key={ws}>
              <div
                style={{
                  ...styles.groupHeader,
                  ...(dragOverWs === ws && draggingWs && draggingWs !== ws ? styles.groupHeaderDropTarget : null),
                  ...(draggingWs === ws ? styles.groupHeaderDragging : null),
                }}
                draggable={renamingWs !== ws}
                onClick={() => renamingWs === ws ? null : toggleWorkspace(ws)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setWsMenu({ workspace: ws, x: e.clientX, y: e.clientY })
                }}
                onDragStart={(e) => {
                  setDraggingWs(ws)
                  e.dataTransfer.effectAllowed = 'move'
                  try { e.dataTransfer.setData('text/plain', ws) } catch { /* ignore */ }
                }}
                onDragOver={(e) => {
                  if (!draggingWs) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOverWs !== ws) setDragOverWs(ws)
                }}
                onDragLeave={() => { if (dragOverWs === ws) setDragOverWs(null) }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (draggingWs) reorderWs(draggingWs, ws)
                  setDraggingWs(null)
                  setDragOverWs(null)
                }}
                onDragEnd={() => { setDraggingWs(null); setDragOverWs(null) }}
              >
                <span style={{ ...styles.chevron, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}><UIIcon name="chevron" size={13} /></span>
                <span style={styles.workspaceIcon}><UIIcon name={collapsed ? 'folder' : 'folder-open'} size={16} /></span>
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
                  <span style={styles.groupIdentity}>
                    <span style={styles.groupName}>{ws}</span>
                    {ws === gatewayWorkspace && (
                      <span
                        style={styles.gatewayIcon}
                        title="Gateway default workspace — receives messages from chat platforms"
                        aria-label="Gateway default workspace"
                      >
                        <UIIcon name="server" size={12} strokeWidth={2} />
                      </span>
                    )}
                  </span>
                )}
                {attentionCount > 0 && (
                  <span
                    style={styles.attentionBadge}
                    title={`${attentionCount} chat${attentionCount === 1 ? '' : 's'} need attention`}
                    aria-label={`${attentionCount} chat${attentionCount === 1 ? '' : 's'} need attention`}
                  >!</span>
                )}
                {runningCount > 0 && (
                  <span
                    style={styles.runningBadge}
                    title={`${runningCount} chat${runningCount === 1 ? '' : 's'} running`}
                    aria-label={`${runningCount} chat${runningCount === 1 ? '' : 's'} running`}
                  />
                )}
                {unreadCount > 0 && (
                  <span
                    style={styles.workspaceUnreadBadge}
                    title={`${unreadCount} unread chat${unreadCount === 1 ? '' : 's'}`}
                    aria-label={`${unreadCount} unread chat${unreadCount === 1 ? '' : 's'}`}
                  >{unreadCount}</span>
                )}
                <button
                  style={styles.groupAddBtn}
                  onClick={(e) => { e.stopPropagation(); handleNewChat(ws) }}
                  title={`New chat in "${ws}"`}
                ><UIIcon name="plus" size={15} /></button>
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
                    style={{ ...styles.item, background: active ? C.accentDim : 'transparent', borderColor: active ? C.accent : 'transparent', opacity: orphaned ? 0.5 : 1 }}
                    onClick={() => {
                      if (isRenaming) return
                      onSelectChat()
                      selectChat(chat.id)
                    }}
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
                    <span style={{ ...styles.chatIcon, color: active ? C.accent : C.fg3 }}><UIIcon name="chat" size={14} /></span>
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
                      <span style={styles.title}>{chat.title?.trim() || 'New Chat'}</span>
                    )}
                    <RouteIcons routes={chat.routes} />
                    {unread && !active && <span style={styles.unreadDot} />}
                    {flight && <span style={styles.dot} />}
                    {!isRenaming && (
                      <button
                        style={styles.xBtn}
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (confirm(`Delete chat "${chat.title?.trim() || 'New Chat'}"?`)) {
                            await deleteChat(chat.id)
                          }
                        }}
                        title="Delete chat"
                      ><UIIcon name="trash" size={13} /></button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
        </div>
      </div>
      <div style={styles.manageSection}>
        <div style={styles.footer}>
        <UpdateButton />
        <button
          style={styles.footerButton}
          onClick={handleAddWorkspace}
          disabled={addingWorkspace}
          title="Pick a folder and create a new workspace + chat"
        ><UIIcon name="workspace" size={15} />{addingWorkspace ? 'Picking…' : 'Add workspace'}</button>
        <button style={styles.footerButton} onClick={() => onOpenSettings()}><UIIcon name="settings" size={15} />Settings</button>
        </div>
      </div>
      {wsMenu && (
        <div
          style={{ ...styles.menu, top: wsMenu.y, left: wsMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={styles.menuHeader}>{wsMenu.workspace}</div>
          <button style={styles.menuItem} onClick={() => handleNewChat(wsMenu.workspace).then(closeWsMenu)}><UIIcon name="add" size={14} />New chat</button>
          <button
            style={{ ...styles.menuItem, opacity: wsMenu.workspace === 'default' ? 0.4 : 1 }}
            disabled={wsMenu.workspace === 'default'}
            onClick={() => beginRenameWs(wsMenu.workspace)}
          ><UIIcon name="code" size={14} />Rename…</button>
          <button
            style={styles.menuItem}
            onClick={() => setAsGateway(wsMenu.workspace)}
            disabled={wsMenu.workspace === gatewayWorkspace}
          ><UIIcon name="server" size={14} />Set as Gateway default</button>
          <button style={styles.menuItem} onClick={() => revealWs(wsMenu.workspace)}><UIIcon name="folder" size={14} />Reveal in Finder</button>
          <button style={styles.menuItem} onClick={() => editMemoryWs(wsMenu.workspace)}><UIIcon name="sparkle" size={14} />Edit memory…</button>
          <div style={styles.menuSep} />
          <button
            style={{ ...styles.menuItem, color: C.red, opacity: wsMenu.workspace === 'default' ? 0.4 : 1 }}
            disabled={wsMenu.workspace === 'default'}
            onClick={() => deleteWs(wsMenu.workspace)}
          ><UIIcon name="trash" size={14} />Delete workspace</button>
        </div>
      )}
      {chatMenu && (
        <div
          style={{ ...styles.menu, top: chatMenu.y, left: chatMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={styles.menuHeader}>{chatMenu.chat.title?.trim() || 'New Chat'}</div>
          {chatMenuView === 'main' ? (
            <>
              <button
                style={styles.menuItem}
                onClick={() => setChatMenuView('connect')}
              ><UIIcon name="link" size={14} />Connect to channel...</button>
              <button
                style={styles.menuItem}
                onClick={() => {
                  const c = chatMenu.chat
                  setChatMenu(null)
                  setRenamingId(c.id)
                  setRenameValue(c.title)
                }}
              ><UIIcon name="code" size={14} />Rename…</button>
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
                  if (confirm(`Delete chat "${c.title?.trim() || 'New Chat'}"?`)) {
                    await deleteChat(c.id)
                  }
                }}
              ><UIIcon name="trash" size={14} />Delete chat</button>
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
                      onSelectChat()
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
    width: '100%',
    height: '100%',
    background: C.sidebarBg,
    borderRight: `1px solid ${C.sidebarBorder}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    gap: 8,
    padding: 8,
    backdropFilter: 'blur(22px) saturate(1.2)',
    WebkitBackdropFilter: 'blur(22px) saturate(1.2)',
  },
  brandArea: { padding: '4px' },
  newChatBtn: {
    width: '100%', border: 'none', borderRadius: 9, padding: '9px 10px',
    background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 12, fontWeight: 700,
    display: 'flex', alignItems: 'center', gap: 7, boxShadow: `0 6px 16px ${C.accentDim}`,
  },
  newChatWorkspace: { marginLeft: 'auto', minWidth: 0, maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.72, fontWeight: 550, fontSize: 10 },
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
  functionSection: { padding: 8, borderRadius: 12, background: C.surface2, border: `1px solid ${C.sidebarBorder}` },
  chatSection: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 12, background: C.surface2, border: `1px solid ${C.sidebarBorder}` },
  chatSectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 11px 7px', color: C.fg3, fontSize: 10, fontWeight: 750, letterSpacing: 0.75, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}` },
  sectionLabel: { color: C.fg3, fontSize: 10, fontWeight: 750, letterSpacing: 0.75, textTransform: 'uppercase', margin: '1px 4px 6px' },
  scroll: { flex: 1, overflowY: 'auto', padding: 6 },
  empty: { color: C.fg3, fontSize: 12, padding: 12, textAlign: 'center' },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 8px', color: C.fg3, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', userSelect: 'none',
  },
  workspaceIcon: { color: C.fg3, display: 'inline-flex', flexShrink: 0 },
  groupHeaderDropTarget: { boxShadow: `inset 0 2px 0 ${C.accent}` },
  groupHeaderDragging: { opacity: 0.45 },
  groupIdentity: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 },
  groupName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  groupAddBtn: {
    background: C.surface3, border: `1px solid ${C.border2}`, color: C.fg2,
    cursor: 'pointer', lineHeight: 1, padding: 3, borderRadius: 5, display: 'inline-flex',
  },
  gatewayIcon: {
    color: C.accent, background: C.accentDim, border: `1px solid ${C.accent}55`,
    borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 18, height: 18, boxSizing: 'border-box', flexShrink: 0,
  },
  attentionBadge: {
    width: 16, height: 16, borderRadius: 5, display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', background: `${C.red}22`, color: C.red, fontSize: 11,
    fontWeight: 800, flexShrink: 0,
  },
  runningBadge: {
    width: 7, height: 7, borderRadius: '50%', background: C.green,
    flexShrink: 0, animation: 'codey-pulse-dot 1.2s infinite',
  },
  workspaceUnreadBadge: {
    minWidth: 16, height: 16, borderRadius: 8, padding: '0 4px', boxSizing: 'border-box',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: C.accent, color: C.onAccent, fontSize: 9, fontWeight: 750, flexShrink: 0,
  },
  chevron: { display: 'inline-flex', color: C.fg3, transition: 'transform 0.15s ease' },
  item: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 9px', borderRadius: 8, cursor: 'pointer',
    fontSize: 12, color: C.fg2, margin: '2px 2px 2px 20px', border: '1px solid transparent',
  },
  chatIcon: { display: 'inline-flex', flexShrink: 0 },
  title: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  renameInput: {
    flex: 1, background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 4, padding: '2px 6px', color: C.fg, fontSize: 12, outline: 'none',
  },
  dot: { width: 6, height: 6, borderRadius: '50%', background: C.accent, animation: 'codey-pulse-dot 1.2s infinite' },
  unreadDot: { width: 6, height: 6, borderRadius: '50%', background: C.accent, flexShrink: 0 },
  xBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', padding: 3, display: 'inline-flex', borderRadius: 4,
  },
  manageSection: { padding: 8, borderRadius: 12, background: C.surface2, border: `1px solid ${C.sidebarBorder}` },
  footer: { display: 'flex', flexDirection: 'column', gap: 2 },
  topNav: { display: 'flex', flexDirection: 'column', gap: 2 },
  navButton: {
    width: '100%', padding: '8px 9px', border: 'none', background: 'transparent', color: C.fg2,
    cursor: 'pointer', textAlign: 'left', borderRadius: 7, fontSize: 12, fontWeight: 600,
    display: 'flex', alignItems: 'center', gap: 8,
  },
  navIcon: { width: 25, height: 25, borderRadius: 7, background: C.surface3, color: C.accent, display: 'grid', placeItems: 'center' },
  footerButton: { width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', color: C.fg2, cursor: 'pointer', textAlign: 'left', borderRadius: 7, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 },
  navBadge: {
    marginLeft: 'auto', minWidth: 16, height: 16, padding: '0 4px',
    borderRadius: 8, background: '#E5484D', color: '#fff',
    fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
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
    fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7,
  },
  menuSep: { height: 1, background: C.border, margin: '4px 0' },
}
