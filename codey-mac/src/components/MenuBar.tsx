import React from 'react'

interface MenuBarProps {
  isRunning: boolean
  onToggle: () => void
  onOpenWindow: () => void
  onQuit: () => void
}

export const MenuBar: React.FC<MenuBarProps> = ({
  isRunning,
  onToggle,
  onOpenWindow,
  onQuit,
}) => {
  return (
    <div style={styles.container}>
      <div style={styles.iconContainer} onClick={onOpenWindow}>
        <div style={{ ...styles.statusDot, ...(isRunning ? styles.running : styles.stopped) }} />
        <span style={styles.iconText}>Codey</span>
      </div>
      <div style={styles.menuItem} onClick={onToggle}>
        {isRunning ? 'Stop Gateway' : 'Start Gateway'}
      </div>
      <div style={styles.menuItem} onClick={onOpenWindow}>
        Open Window
      </div>
      <div style={styles.menuItem} onClick={onQuit}>
        Quit
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    backgroundColor: '#2d2d2d',
    borderRadius: '8px',
    padding: '8px',
    minWidth: '150px',
  },
  iconContainer: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px',
    marginBottom: '4px',
    cursor: 'pointer',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '4px',
    marginRight: '8px',
  },
  running: {
    backgroundColor: '#4CAF50',
  },
  stopped: {
    backgroundColor: '#9E9E9E',
  },
  iconText: {
    color: '#fff',
    fontSize: '14px',
    fontWeight: '600',
  },
  menuItem: {
    padding: '8px',
    borderTop: '1px solid #444',
    cursor: 'pointer',
    color: '#fff',
  },
}
