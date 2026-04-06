import React, { useState, useEffect } from 'react'
import { apiService } from '../services/api'

interface WorkspacesTabProps {
  isGatewayRunning: boolean
}

export const WorkspacesTab: React.FC<WorkspacesTabProps> = ({ isGatewayRunning }) => {
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [currentWorkspace, setCurrentWorkspace] = useState<string>('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isGatewayRunning) {
      loadWorkspaces()
    }
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
    setLoading(true)
    try {
      await apiService.switchWorkspace(name)
      setCurrentWorkspace(name)
    } catch (error) {
      console.error('Failed to switch workspace:', error)
    } finally {
      setLoading(false)
    }
  }

  if (!isGatewayRunning) {
    return (
      <div style={styles.container}>
        <div style={styles.offline}>Start the gateway to manage workspaces</div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.section}>Workspaces</div>
      {workspaces.length === 0 ? (
        <div style={styles.empty}>No workspaces found</div>
      ) : (
        <div>
          {workspaces.map(ws => (
            <div
              key={ws}
              style={{
                ...styles.workspaceItem,
                ...(currentWorkspace === ws ? styles.activeWorkspace : {})
              }}
              onClick={() => !loading && switchWorkspace(ws)}
            >
              <span style={styles.workspaceName}>{ws}</span>
              {currentWorkspace === ws && <span style={styles.activeBadge}>Active</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    padding: '16px',
  },
  offline: {
    color: '#888',
    textAlign: 'center',
    marginTop: '40px',
  },
  section: {
    color: '#fff',
    fontSize: '16px',
    fontWeight: '600',
    marginBottom: '16px',
  },
  empty: {
    color: '#888',
  },
  workspaceItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px',
    backgroundColor: '#2a2a2a',
    borderRadius: '8px',
    marginBottom: '8px',
    cursor: 'pointer',
    border: '2px solid transparent',
  },
  activeWorkspace: {
    borderColor: '#007AFF',
  },
  workspaceName: {
    color: '#fff',
    fontSize: '14px',
  },
  activeBadge: {
    color: '#007AFF',
    fontSize: '12px',
  },
}
