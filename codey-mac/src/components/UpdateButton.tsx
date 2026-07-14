import React from 'react'
import { C } from '../theme'
import { useUpdater } from '../hooks/useUpdater'
import { UIIcon } from './UIIcons'

export const UpdateButton: React.FC = () => {
  const { state, check, download, install } = useUpdater()

  if (state.phase === 'idle') return null

  if (state.phase === 'available') {
    return (
      <button style={styles.action} onClick={() => download()} title={`Download version ${state.version}`}>
        <UIIcon name="refresh" size={14} />Update to v{state.version}
      </button>
    )
  }

  if (state.phase === 'downloading') {
    return <div style={styles.progress}>Downloading… {state.percent}%</div>
  }

  if (state.phase === 'error') {
    return (
      <button style={styles.error} onClick={() => check()} title={state.message}>
        <UIIcon name="refresh" size={14} />Update failed · Retry
      </button>
    )
  }

  // phase === 'ready'
  return (
    <button style={styles.action} onClick={() => install()} title="Restart and install the update">
      <UIIcon name="refresh" size={14} />Restart to update
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  action: {
    width: '100%', padding: '8px 10px', border: `1px solid ${C.accent}`, marginBottom: 4,
    background: C.accentDim, color: C.fg, cursor: 'pointer',
    textAlign: 'left', borderRadius: 8, fontSize: 12, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 7,
  },
  progress: {
    width: '100%', padding: '8px 10px', marginBottom: 4,
    color: C.fg2, fontSize: 13, textAlign: 'left',
  },
  error: {
    width: '100%', padding: '8px 10px', border: `1px solid ${C.dangerBorder}`, marginBottom: 4,
    background: C.dangerBg, color: C.dangerFg, cursor: 'pointer',
    textAlign: 'left', borderRadius: 8, fontSize: 12, fontWeight: 650,
    display: 'flex', alignItems: 'center', gap: 7,
  },
}
