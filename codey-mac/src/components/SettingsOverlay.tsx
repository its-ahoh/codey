import React, { useState } from 'react'
import { OverlayWindow } from './OverlayWindow'
import { StatusTab } from './StatusTab'
import { SettingsTab } from './SettingsTab'
import { AgentsTab } from './AgentsTab'
import { WorkspacesTab } from './WorkspacesTab'
import WorkersTab from './WorkersTab'
import { TeamsTab } from './TeamsTab'
import { useGateway } from '../hooks/useGateway'
import { C } from '../theme'
import { AppearanceTab } from './AppearanceTab'
import { WhisperTab } from './WhisperTab'
import { ApiKeysTab } from './ApiKeysTab'
type Tab = 'general' | 'workers' | 'teams' | 'workspaces' | 'status' | 'settings' | 'agents' | 'whisper' | 'apiKeys'
const TABS: { key: Tab; label: string; icon: string; description: string }[] = [
  { key: 'general',    label: 'General',    icon: '⚙', description: 'Theme & visual options' },
  { key: 'apiKeys',    label: 'API Keys',   icon: '⚿', description: 'Shared API keys' },
  { key: 'settings',   label: 'AI Models',  icon: '✦', description: 'Default agent & model' },
  { key: 'agents',     label: 'Agents',     icon: '✺', description: 'CLI install & env vars' },
  { key: 'whisper',    label: 'Whisper',    icon: '◐', description: 'Voice input & hotkey' },
  { key: 'workspaces', label: 'Workspaces', icon: '◫', description: 'Project directories' },
  { key: 'workers',    label: 'Workers',    icon: '☰', description: 'Personalities' },
  { key: 'teams',      label: 'Teams',      icon: '⚉', description: 'Shared team library' },
  { key: 'status',     label: 'Gateway',    icon: '◉', description: 'Server status & logs' },
]

interface Props { onClose: () => void; initialTab?: string }

export const SettingsOverlay: React.FC<Props> = ({ onClose, initialTab }) => {
  const [tab, setTab] = useState<Tab>(
    (initialTab && TABS.some(t => t.key === initialTab)) ? (initialTab as Tab) : 'settings'
  )
  const { isRunning, status, logs } = useGateway()

  const activeTab = TABS.find(t => t.key === tab)!

  return (
    <OverlayWindow title="Settings" onClose={onClose}>
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
              {tab === 'general'    && <AppearanceTab />}
              {tab === 'apiKeys'    && <ApiKeysTab isGatewayRunning={isRunning} />}
              {tab === 'status'     && <StatusTab status={status} logs={logs} isRunning={isRunning} />}
              {tab === 'workspaces' && <WorkspacesTab isGatewayRunning={isRunning} />}
              {tab === 'workers'    && <WorkersTab />}
              {tab === 'teams'      && <TeamsTab />}
              {tab === 'settings'   && <SettingsTab isGatewayRunning={isRunning} />}
              {tab === 'agents'     && <AgentsTab isGatewayRunning={isRunning} />}
              {tab === 'whisper'    && <WhisperTab isGatewayRunning={isRunning} />}
            </div>
          </main>
      </div>
    </OverlayWindow>
  )
}

const styles: Record<string, React.CSSProperties> = {
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
