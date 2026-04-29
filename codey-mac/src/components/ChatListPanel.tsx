import React, { useEffect, useState } from 'react'
import { useChats } from '../hooks/useChats'
import { apiService } from '../services/api'
import type { Chat } from '../types'
import { C } from '../theme'

interface Props {
  onOpenSettings: () => void
  activeChatId: string | null
}

export const ChatListPanel: React.FC<Props> = ({ onOpenSettings, activeChatId }) => {
  const { state, createChat, selectChat, renameChat, deleteChat, toggleWorkspace, refreshWorkspaces } = useChats()
  const [addingWorkspace, setAddingWorkspace] = useState(false)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [lastWorkspace, setLastWorkspace] = useState<string>('')
  const [gatewayWorkspace, setGatewayWorkspace] = useState<string>('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

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
    <div style={styles.root}>
      <div style={styles.header}>
        <button
          style={styles.newBtn}
          onClick={() => handleNewChat()}
          disabled={!lastWorkspace}
          title={lastWorkspace ? `Create a new chat in "${lastWorkspace}"` : 'No workspace available'}
        >
          {lastWorkspace ? `+ New Chat in ${lastWorkspace}` : '+ New Chat'}
        </button>
      </div>
      <div style={styles.scroll}>
        {groupNames.length === 0 && (
          <div style={styles.empty}>No chats yet. Click "New Chat".</div>
        )}
        {groupNames.map(ws => {
          const collapsed = !!state.collapsedWorkspaces[ws]
          return (
            <div key={ws}>
              <div style={styles.groupHeader} onClick={() => toggleWorkspace(ws)}>
                <span style={{ ...styles.chevron, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>▸</span>
                <span style={styles.groupName}>{ws}</span>
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
        <button
          style={styles.settingsBtn}
          onClick={handleAddWorkspace}
          disabled={addingWorkspace}
          title="Pick a folder and create a new workspace + chat"
        >{addingWorkspace ? 'Picking…' : '+ Add Workspace'}</button>
        <button style={styles.settingsBtn} onClick={onOpenSettings}>⚙ Settings</button>
      </div>
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
}
