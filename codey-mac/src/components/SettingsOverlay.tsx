import React, { useEffect, useState } from 'react'
import { StatusTab } from './StatusTab'
import { SettingsTab } from './SettingsTab'
import { WorkspacesTab } from './WorkspacesTab'
import WorkersTab from './WorkersTab'
import { useGateway } from '../hooks/useGateway'
import { C } from '../theme'

type Tab = 'workers' | 'workspaces' | 'status' | 'settings'
const TABS: { key: Tab; label: string }[] = [
  { key: 'workers',    label: 'Workers' },
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'status',     label: 'Gateway' },
  { key: 'settings',   label: 'Settings' },
]

interface Props { onClose: () => void }

export const SettingsOverlay: React.FC<Props> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('settings')
  const { isRunning, status, logs } = useGateway()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div style={styles.tabs}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                ...styles.tabBtn,
                color: tab === t.key ? C.fg : C.fg3,
                borderBottom: tab === t.key ? `2px solid ${C.accent}` : '2px solid transparent',
              }}
            >{t.label}</button>
          ))}
        </div>
        <button onClick={onClose} style={styles.closeBtn} title="Close (Esc)">×</button>
      </div>
      <div style={styles.body}>
        {tab === 'status'     && <StatusTab status={status} logs={logs} isRunning={isRunning} />}
        {tab === 'workspaces' && <WorkspacesTab isGatewayRunning={isRunning} />}
        {tab === 'workers'    && <WorkersTab />}
        {tab === 'settings'   && <SettingsTab isGatewayRunning={isRunning} />}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'absolute', inset: 0, background: C.bg,
    display: 'flex', flexDirection: 'column', zIndex: 50,
  },
  header: {
    display: 'flex', alignItems: 'center',
    borderBottom: `1px solid ${C.border}`, padding: '0 8px',
    flexShrink: 0, background: C.surface,
  },
  tabs: { display: 'flex', flex: 1, gap: 4 },
  tabBtn: {
    background: 'transparent', border: 'none', padding: '12px 14px',
    cursor: 'pointer', fontSize: 13, fontWeight: 500,
  },
  closeBtn: {
    background: 'transparent', border: 'none', fontSize: 20,
    color: C.fg3, cursor: 'pointer', padding: '4px 10px',
  },
  body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
}
