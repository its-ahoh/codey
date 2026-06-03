import React from 'react'
import { C } from '../theme'
import { useUpdater } from '../hooks/useUpdater'

export const UpdateButton: React.FC = () => {
  const { state, download, install } = useUpdater()

  if (state.phase === 'idle') return null

  if (state.phase === 'available') {
    return (
      <button style={styles.action} onClick={() => download()} title={`Download version ${state.version}`}>
        ↑ Update to v{state.version}
      </button>
    )
  }

  if (state.phase === 'downloading') {
    return <div style={styles.progress}>Downloading… {state.percent}%</div>
  }

  // phase === 'ready'
  return (
    <button style={styles.action} onClick={() => install()} title="Restart and install the update">
      Restart to update
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  action: {
    width: '100%', padding: '8px 10px', border: 'none', marginBottom: 4,
    background: C.accentDim, color: C.fg, cursor: 'pointer',
    textAlign: 'left', borderRadius: 6, fontSize: 13, fontWeight: 600,
  },
  progress: {
    width: '100%', padding: '8px 10px', marginBottom: 4,
    color: C.fg2, fontSize: 13, textAlign: 'left',
  },
}
