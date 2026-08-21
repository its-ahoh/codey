import React, { useState, useEffect, useCallback } from 'react'
import { apiService } from '../services/api'
import { C } from '../theme'
import { emitWorkspacesChanged } from './workspacesChanged'
import { ProjectMemorySection } from './AgentMemorySection'
import { CodeyGlobalMemorySection, CodeyMemorySection, CodeyMemorySettings } from './CodeyMemorySection'

interface WorkspacesTabProps {
  isGatewayRunning: boolean
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

const TrashIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
  </svg>
)

const ChevronIcon: React.FC<{ color: string; open: boolean }> = ({ color, open }) => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <path d="M9 18l6-6-6-6" />
  </svg>
)

interface WorkspaceInfo {
  workingDir: string
}

export const WorkspacesTab: React.FC<WorkspacesTabProps> = ({ isGatewayRunning }) => {
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [busyName, setBusyName] = useState<string>('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>('')
  const [expanded, setExpanded] = useState<string>('')
  const [infoCache, setInfoCache] = useState<Record<string, WorkspaceInfo>>({})

  const loadWorkspaces = useCallback(async () => {
    try {
      const ws = await apiService.getWorkspaces()
      setWorkspaces(ws)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workspaces')
    }
  }, [])

  useEffect(() => { if (isGatewayRunning) loadWorkspaces() }, [isGatewayRunning, loadWorkspaces])

  const loadInfo = useCallback(async (name: string) => {
    try {
      const info = await apiService.getWorkspaceInfo(name)
      setInfoCache(prev => ({ ...prev, [name]: info }))
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to load info for ${name}`)
    }
  }, [])

  const toggleExpand = (name: string, ev: React.MouseEvent) => {
    ev.stopPropagation()
    if (expanded === name) {
      setExpanded('')
      return
    }
    setExpanded(name)
    if (!infoCache[name]) loadInfo(name)
  }

  const pickAndCreate = async () => {
    if (creating) return
    setCreating(true); setError('')
    try {
      const dir = await apiService.pickDirectory()
      if (!dir) return
      await apiService.createWorkspaceFromDir(dir)
      await loadWorkspaces()
      emitWorkspacesChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workspace')
    } finally {
      setCreating(false)
    }
  }

  const removeWorkspace = async (name: string, ev: React.MouseEvent) => {
    ev.stopPropagation()
    if (busyName) return
    if (name === 'default') {
      setError('The "default" workspace is protected and cannot be deleted.')
      return
    }
    const isLast = workspaces.length === 1
    const extra = isLast
      ? '\n\nThis is your only workspace. After deletion you will need to add a folder before starting a new chat.'
      : ''
    const ok = window.confirm(
      `Delete workspace "${name}"?\n\nThis removes the workspace folder (workspace.json, memory.md, logs). The original project directory it points to is NOT touched.${extra}`
    )
    if (!ok) return
    setBusyName(name); setError('')
    try {
      await apiService.deleteWorkspace(name)
      setWorkspaces(prev => prev.filter(w => w !== name))
      emitWorkspacesChanged()
      setInfoCache(prev => {
        const next = { ...prev }; delete next[name]; return next
      })
      if (expanded === name) setExpanded('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete workspace')
    } finally {
      setBusyName('')
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
        <span style={{ color: C.fg3, fontSize: 11, lineHeight: 1.5 }}>Manage project folders and their workspace memory.</span>
        <button
          onClick={pickAndCreate}
          disabled={creating}
          style={{ ...styles.newBtn, opacity: creating ? 0.6 : 1 }}
        >
          <PlusIcon color={C.accent} />
          {creating ? 'Picking…' : 'Add folder'}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <CodeyMemorySettings />

      <div style={{ marginBottom: 12 }}>
        <CodeyGlobalMemorySection />
      </div>

      {workspaces.length === 0 ? (
        <div style={{ color: C.fg3, padding: '20px 0' }}>No workspaces yet — click "Add folder" to pick one.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {workspaces.map(ws => {
            const isBusy = busyName === ws
            const isOpen = expanded === ws
            const info = infoCache[ws]
            return (
              <div
                key={ws}
                style={{
                  background: C.surface2,
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  cursor: isBusy ? 'wait' : 'default',
                  transition: 'border-color 0.15s, background 0.15s',
                  opacity: isBusy ? 0.6 : 1,
                  overflow: 'hidden',
                }}
              >
                <div
                  onClick={(e) => toggleExpand(ws, e)}
                  style={{
                    ...styles.wsTopRow,
                    padding: '14px 16px',
                    cursor: isBusy ? 'wait' : 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <ChevronIcon color={C.fg2} open={isOpen} />
                    <FolderIcon color={C.fg2} />
                    <span style={{ color: C.fg, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      onClick={(e) => removeWorkspace(ws, e)}
                      disabled={isBusy || ws === 'default'}
                      title={ws === 'default' ? 'The default workspace is protected' : `Delete ${ws}`}
                      style={{ ...styles.iconBtn, opacity: (isBusy || ws === 'default') ? 0.3 : 0.85, cursor: (isBusy || ws === 'default') ? 'not-allowed' : 'pointer' }}
                    >
                      <TrashIcon color={C.fg2} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div style={styles.expandedBody}>
                    <div style={styles.fieldRow}>
                      <div style={styles.fieldLabel}>Path</div>
                      {info ? (
                        <code style={styles.pathValue}>{info.workingDir || '—'}</code>
                      ) : (
                        <span style={{ color: C.fg3, fontSize: 12 }}>Loading…</span>
                      )}
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <CodeyMemorySection workspace={ws} />
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <ProjectMemorySection workspace={ws} />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 20, height: '100%', overflowY: 'auto' },
  offlineContainer: {
    display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16,
  },
  newBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 12px', borderRadius: 8, border: 'none',
    background: C.accentDim, color: C.accent, cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  error: {
    background: C.dangerBg, color: C.dangerFg, border: `1px solid ${C.dangerBorder}`,
    borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12,
  },
  wsTopRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  },
  iconBtn: {
    background: 'transparent', border: 'none', padding: 4, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  expandedBody: {
    padding: '12px 16px 16px',
    borderTop: `1px solid ${C.border}`,
  },
  fieldRow: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  fieldLabel: {
    fontSize: 12, fontWeight: 650, color: C.fg2,
  },
  pathValue: {
    fontSize: 12, color: C.fg, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px',
    wordBreak: 'break-all',
  },
}
