import React, { useState, useEffect } from 'react'
import { apiService } from '../services/api'
import { C } from '../theme'
import TeamsSection from './TeamsSection'

interface WorkspacesTabProps {
  isGatewayRunning: boolean
  onWorkspaceChange?: (name: string) => void
}

const FolderIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

const PlusIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const WorkspacesTab: React.FC<WorkspacesTabProps> = ({ isGatewayRunning, onWorkspaceChange }) => {
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [currentWorkspace, setCurrentWorkspace] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (isGatewayRunning) loadWorkspaces()
  }, [isGatewayRunning])

  const loadWorkspaces = async () => {
    try {
      const ws = await apiService.getWorkspaces()
      setWorkspaces(ws)
    } catch (error) {
      console.error('Failed to load workspaces:', error)
    }
  }

  const switchWorkspace = async (name: string) => {
    if (loading || name === currentWorkspace) return
    setLoading(true)
    try {
      await apiService.switchWorkspace(name)
      setCurrentWorkspace(name)
      onWorkspaceChange?.(name)
    } catch (error) {
      console.error('Failed to switch workspace:', error)
    } finally {
      setLoading(false)
    }
  }

  const cancelCreate = () => { setCreating(false); setNewName('') }

  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) { cancelCreate(); return }
    try {
      // Optimistic: add to list if API doesn't have a create endpoint yet
      setWorkspaces(prev => prev.includes(name) ? prev : [...prev, name])
    } finally {
      cancelCreate()
    }
  }

  if (!isGatewayRunning) {
    return (
      <div style={styles.offlineContainer}>
        <span style={{ color: C.fg3, fontSize: 13 }}>
          Start the gateway to manage workspaces
        </span>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={{ color: C.fg, fontSize: 16, fontWeight: 600 }}>Workspaces</span>
        <button
          onClick={() => setCreating(v => !v)}
          style={styles.newBtn}
        >
          <PlusIcon color={C.accent} />
          New
        </button>
      </div>

      {creating && (
        <div style={styles.createRow}>
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Workspace name…"
            style={styles.createInput}
            onKeyDown={e => {
              if (e.key === 'Enter') submitCreate()
              if (e.key === 'Escape') cancelCreate()
            }}
          />
          <button onClick={submitCreate} style={styles.createSubmit}>Create</button>
        </div>
      )}

      {workspaces.length === 0 ? (
        <div style={{ color: C.fg3, padding: '20px 0' }}>No workspaces found</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {workspaces.map(ws => {
            const active = currentWorkspace === ws
            return (
              <div
                key={ws}
                onClick={() => switchWorkspace(ws)}
                style={{
                  background: active ? C.surface3 : C.surface2,
                  border: `1px solid ${active ? C.accent + '55' : C.border}`,
                  borderRadius: 10,
                  padding: '14px 16px',
                  cursor: loading ? 'wait' : 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                <div style={styles.wsTopRow}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FolderIcon color={active ? C.accent : C.fg2} />
                    <span style={{ color: active ? C.accent : C.fg, fontSize: 14, fontWeight: 600 }}>{ws}</span>
                  </div>
                  {active && <span style={{ color: C.accent, fontSize: 11, fontWeight: 600 }}>Active</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {currentWorkspace && <TeamsSection workspace={currentWorkspace} />}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 20, height: '100%', overflowY: 'auto' },
  offlineContainer: {
    display: 'flex',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  newBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 8,
    border: 'none',
    background: C.accentDim,
    color: C.accent,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  createRow: {
    background: C.surface2,
    border: `1px solid ${C.border2}`,
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    display: 'flex',
    gap: 8,
  },
  createInput: {
    flex: 1,
    background: C.surface3,
    border: `1px solid ${C.border2}`,
    borderRadius: 7,
    color: C.fg,
    fontSize: 13,
    padding: '8px 10px',
    outline: 'none',
  },
  createSubmit: {
    padding: '8px 14px',
    borderRadius: 7,
    border: 'none',
    background: C.accent,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  wsTopRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
}
