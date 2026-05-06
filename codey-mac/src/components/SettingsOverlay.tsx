import React, { useEffect, useState } from 'react'
import { StatusTab } from './StatusTab'
import { SettingsTab } from './SettingsTab'
import { WorkspacesTab } from './WorkspacesTab'
import WorkersTab from './WorkersTab'
import { useGateway } from '../hooks/useGateway'
import { C } from '../theme'
import { AppearanceTab } from './AppearanceTab'

type Tab = 'appearance' | 'workers' | 'workspaces' | 'status' | 'settings'
const TABS: { key: Tab; label: string; icon: string; description: string }[] = [
  { key: 'appearance', label: 'System',     icon: '◐', description: 'Theme & visual options' },
  { key: 'settings',   label: 'AI Models',  icon: '✦', description: 'Default agent & model' },
  { key: 'workspaces', label: 'Workspaces', icon: '◫', description: 'Project directories' },
  { key: 'workers',    label: 'Workers',    icon: '☰', description: 'Personalities & teams' },
  { key: 'status',     label: 'Gateway',    icon: '◉', description: 'Server status & logs' },
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

  const activeTab = TABS.find(t => t.key === tab)!

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.window} onClick={e => e.stopPropagation()}>
        <div style={styles.titleBar}>
          <button onClick={onClose} style={styles.closeBtn} title="Close (Esc)" aria-label="Close">
            <span style={styles.closeDot} />
          </button>
          <div style={styles.titleText}>Settings</div>
          <div style={{ width: 60 }} />
        </div>
        <div style={styles.body}>
          <aside style={styles.sidebar}>
            {TABS.map(t => {
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  style={{
                    ...styles.sideItem,
                    background: active ? C.accentDim : 'transparent',
                    color: active ? C.fg : C.fg2,
                  }}
                >
                  <span style={{ ...styles.sideIcon, color: active ? C.accent : C.fg3 }}>{t.icon}</span>
                  <span style={styles.sideLabel}>
                    <span style={{ fontWeight: 500 }}>{t.label}</span>
                    <span style={styles.sideDesc}>{t.description}</span>
                  </span>
                </button>
              )
            })}
          </aside>
          <main style={styles.main}>
            <div style={styles.mainHeader}>{activeTab.label}</div>
            <div style={styles.mainContent}>
              {tab === 'appearance' && <AppearanceTab />}
              {tab === 'status'     && <StatusTab status={status} logs={logs} isRunning={isRunning} />}
              {tab === 'workspaces' && <WorkspacesTab isGatewayRunning={isRunning} />}
              {tab === 'workers'    && <WorkersTab />}
              {tab === 'settings'   && <SettingsTab isGatewayRunning={isRunning} />}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(3px)',
    WebkitBackdropFilter: 'blur(3px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  window: {
    width: 'min(900px, 92%)',
    height: 'min(620px, 88%)',
    background: C.bg,
    border: `1px solid ${C.border2}`,
    borderRadius: 10,
    boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  titleBar: {
    display: 'flex', alignItems: 'center',
    height: 36, padding: '0 12px',
    background: C.surface,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  closeBtn: {
    width: 14, height: 14, borderRadius: '50%',
    background: '#FF5F57', border: '1px solid #E0443E',
    cursor: 'pointer', padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  closeDot: { display: 'block' },
  titleText: {
    flex: 1, textAlign: 'center',
    fontSize: 13, fontWeight: 600, color: C.fg2,
  },
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  sidebar: {
    width: 200, flexShrink: 0,
    background: C.surface,
    borderRight: `1px solid ${C.border}`,
    padding: '10px 8px',
    display: 'flex', flexDirection: 'column', gap: 2,
    overflowY: 'auto',
  },
  sideItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 10px', border: 'none',
    borderRadius: 6, cursor: 'pointer',
    fontSize: 13, textAlign: 'left',
  },
  sideIcon: { fontSize: 14, width: 16, textAlign: 'center', flexShrink: 0 },
  sideLabel: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  sideDesc: { fontSize: 11, color: C.fg3, fontWeight: 400 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: C.bg },
  mainHeader: {
    padding: '14px 20px', fontSize: 15, fontWeight: 600, color: C.fg,
    borderBottom: `1px solid ${C.border}`, flexShrink: 0,
  },
  mainContent: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' },
}
