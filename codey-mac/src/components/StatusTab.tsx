import React from 'react'
import { GatewayStatus } from '../types'

interface StatusTabProps {
  status: GatewayStatus
  logs: string[]
  isRunning: boolean
  onToggle: () => void
}

const formatUptime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}h ${m}m ${s}s`
}

export const StatusTab: React.FC<StatusTabProps> = ({ status, logs, isRunning, onToggle }) => {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Gateway Status</span>
        <button
          style={{
            ...styles.toggleButton,
            ...(isRunning ? styles.stopButton : styles.startButton)
          }}
          onClick={onToggle}
        >
          {isRunning ? 'Stop' : 'Start'}
        </button>
      </div>

      <div style={styles.statsGrid}>
        <div style={styles.statItem}>
          <div style={styles.statLabel}>Status</div>
          <div style={{
            ...styles.statValue,
            ...(isRunning ? styles.running : styles.stopped)
          }}>
            {isRunning ? 'Running' : 'Stopped'}
          </div>
        </div>
        <div style={styles.statItem}>
          <div style={styles.statLabel}>Uptime</div>
          <div style={styles.statValue}>{isRunning ? formatUptime(status.uptime) : '-'}</div>
        </div>
        <div style={styles.statItem}>
          <div style={styles.statLabel}>Messages</div>
          <div style={styles.statValue}>{status.messagesProcessed}</div>
        </div>
        <div style={styles.statItem}>
          <div style={styles.statLabel}>Errors</div>
          <div style={styles.statValue}>{status.errors}</div>
        </div>
      </div>

      <div style={styles.sectionTitle}>Channels</div>
      <div style={styles.channels}>
        <span style={styles.channel}>Telegram: {status.channels.telegram ? '✓' : '✗'}</span>
        <span style={styles.channel}>Discord: {status.channels.discord ? '✓' : '✗'}</span>
        <span style={styles.channel}>iMessage: {status.channels.imessage ? '✓' : '✗'}</span>
      </div>

      <div style={styles.sectionTitle}>Logs</div>
      <div style={styles.logs}>
        {logs.map((log, index) => (
          <div key={index} style={styles.logLine}>{log}</div>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
  },
  title: {
    fontSize: '20px',
    fontWeight: '600',
    color: '#fff',
  },
  toggleButton: {
    padding: '10px 20px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    fontWeight: '600',
    color: '#fff',
  },
  startButton: {
    backgroundColor: '#4CAF50',
  },
  stopButton: {
    backgroundColor: '#f44336',
  },
  statsGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    marginBottom: '20px',
  },
  statItem: {
    width: '50%',
    padding: '8px 0',
    boxSizing: 'border-box',
  },
  statLabel: {
    color: '#888',
    fontSize: '12px',
  },
  statValue: {
    color: '#fff',
    fontSize: '18px',
    fontWeight: '600',
  },
  running: {
    color: '#4CAF50',
  },
  stopped: {
    color: '#9E9E9E',
  },
  sectionTitle: {
    color: '#888',
    fontSize: '14px',
    marginBottom: '8px',
    marginTop: '12px',
  },
  channels: {
    display: 'flex',
    gap: '16px',
  },
  channel: {
    color: '#ccc',
  },
  logs: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: '8px',
    padding: '12px',
    overflowY: 'auto',
    fontFamily: 'monospace',
    fontSize: '11px',
    color: '#888',
  },
  logLine: {
    marginBottom: '4px',
  },
}
