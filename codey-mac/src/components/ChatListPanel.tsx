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
  const { state, createChat, selectChat, renameChat, deleteChat, toggleWorkspace } = useChats()
  const [, setWorkspaces] = useState<string[]>([])
  const [lastWorkspace, setLastWorkspace] = useState<string>('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    apiService.getWorkspaces().then(w => {
      setWorkspaces(w)
      if (w.length > 0) {
        const stored = localStorage.getItem('codey.lastWorkspace')
        setLastWorkspace(stored && w.includes(stored) ? stored : w[0])
      }
    })
  }, [])

  useEffect(() => {
    if (lastWorkspace) localStorage.setItem('codey.lastWorkspace', lastWorkspace)
  }, [lastWorkspace])

  const handleNewChat = async () => {
    if (!lastWorkspace) return
    const chat = await createChat(lastWorkspace)
    setLastWorkspace(chat.workspaceName)
  }

  const groups: Record<string, Chat[]> = {}
  for (const id of state.order) {
    const c = state.chats[id]
    if (!c) continue
    ;(groups[c.workspaceName] ??= []).push(c)
  }
  const groupNames = Object.keys(groups).sort()

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <button style={styles.newBtn} onClick={handleNewChat} disabled={!lastWorkspace}>
          + New Chat
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
                <span style={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
                <span>{ws}</span>
              </div>
              {!collapsed && groups[ws].map(chat => {
                const active = chat.id === activeChatId
                const flight = state.inFlight[chat.id]
                const isRenaming = renamingId === chat.id
                return (
                  <div
                    key={chat.id}
                    style={{ ...styles.item, background: active ? C.accentDim : 'transparent' }}
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
    padding: '6px 8px', color: C.fg3, fontSize: 11, fontWeight: 600,
    textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none',
  },
  chevron: { fontSize: 10, width: 10 },
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
    textAlign: 'left', borderRadius: 6, fontSize: 12,
  },
}
