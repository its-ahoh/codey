import React, { useEffect, useState } from 'react'
import { GatewayStatus } from '../types'
import { apiService } from '../services/api'
import { C } from '../theme'

interface StatusTabProps {
  status: GatewayStatus
  logs: string[]
  isRunning: boolean
}

const formatUptime = (seconds: number): string => {
  if (!seconds || seconds < 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export const StatusTab: React.FC<StatusTabProps> = ({ status, logs, isRunning }) => {
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [current, setCurrent] = useState<string>('')
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    Promise.all([
      apiService.getWorkspaces().catch(() => [] as string[]),
      apiService.getCurrentWorkspace().catch(() => ''),
    ]).then(([ws, cur]) => {
      setWorkspaces(ws)
      setCurrent(cur)
    })
  }, [])

  const handleSwitch = async (name: string) => {
    if (!name || name === current || switching) return
    setSwitching(true)
    try {
      await apiService.switchWorkspace(name)
      setCurrent(name)
    } finally {
      setSwitching(false)
    }
  }

  const stats = [
    { label: 'Uptime',   value: isRunning ? formatUptime(status.uptime) : '—' },
    { label: 'Messages', value: isRunning ? String(status.messagesProcessed ?? 0) : '—' },
    { label: 'Errors',   value: isRunning ? String(status.errors ?? 0) : '—' },
    { label: 'Status',   value: isRunning ? 'OK' : '—' },
  ]

  const channels = [
    { name: 'Telegram', active: !!status.channels?.telegram },
    { name: 'Discord',  active: !!status.channels?.discord },
    { name: 'iMessage', active: !!status.channels?.imessage },
  ]

  return (
    <div style={styles.container}>
      <div style={styles.gatewayRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: isRunning ? C.green : C.fg3,
              boxShadow: isRunning ? `0 0 8px ${C.green}` : 'none',
              transition: 'all 0.3s',
            }}
          />
          <span style={{ color: C.fg, fontSize: 16, fontWeight: 600 }}>
            {isRunning ? 'Gateway Running' : 'Gateway Stopped'}
          </span>
        </div>
        <span style={{ color: C.fg3, fontSize: 11 }}>In-process · Cmd+Q to quit</span>
      </div>

      <div style={styles.statsGrid}>
        {stats.map(s => (
          <div key={s.label} style={styles.statCard}>
            <div style={styles.statLabel}>{s.label}</div>
            <div style={styles.statValue}>{s.value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={styles.sectionHead}>Default Workspace</div>
        <div style={styles.listItem}>
          <span style={{ color: C.fg3, fontSize: 12 }}>
            Used for messages from chat platforms (Telegram, Discord, iMessage)
          </span>
          <select
            value={current}
            onChange={e => handleSwitch(e.target.value)}
            disabled={switching || workspaces.length === 0}
            style={styles.select}
          >
            {workspaces.length === 0 && <option value="">No workspaces</option>}
            {!current && workspaces.length > 0 && <option value="">— Select —</option>}
            {workspaces.map(ws => (
              <option key={ws} value={ws}>{ws}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={styles.sectionHead}>Channels</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {channels.map(ch => (
            <div key={ch.name} style={styles.listItem}>
              <span style={{ color: C.fg, fontSize: 13 }}>{ch.name}</span>
              <span style={{ color: ch.active ? C.green : C.fg3, fontSize: 12, fontWeight: 500 }}>
                {ch.active ? 'Connected' : 'Disabled'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div style={styles.sectionHead}>Logs</div>
        <div style={styles.logsBox}>
          {logs.length === 0
            ? <div style={{ color: '#444' }}>No logs yet.</div>
            : logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 20, overflowY: 'auto', height: '100%' },
  gatewayRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
    marginBottom: 24,
  },
  statCard: {
    background: C.surface2,
    borderRadius: 10,
    padding: '14px 16px',
    border: `1px solid ${C.border}`,
  },
  statLabel: { color: C.fg3, fontSize: 11, marginBottom: 4 },
  statValue: { color: C.fg, fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  sectionHead: {
    color: C.fg3,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  listItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: C.surface2,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: '10px 14px',
  },
  select: {
    background: C.surface3,
    color: C.fg,
    border: `1px solid ${C.border2}`,
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    cursor: 'pointer',
    outline: 'none',
  },
  logsBox: {
    background: '#0d0d0d',
    borderRadius: 10,
    border: `1px solid ${C.border}`,
    padding: 12,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 11,
    color: '#6a9955',
    maxHeight: 180,
    overflowY: 'auto',
    lineHeight: 1.6,
  },
}
