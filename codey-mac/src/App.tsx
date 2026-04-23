import React, { useState, useEffect } from 'react'
import { ChatTab } from './components/ChatTab'
import { StatusTab } from './components/StatusTab'
import { SettingsTab } from './components/SettingsTab'
import { WorkspacesTab } from './components/WorkspacesTab'
import WorkersTab from './components/WorkersTab'
import { useGateway } from './hooks/useGateway'
import { ChatMessage } from './types'
import { C } from './theme'

type TabType = 'chat' | 'status' | 'workspaces' | 'workers' | 'settings'

const Icon: React.FC<{ d: string | string[]; size?: number; color?: string }> = ({ d, size = 17, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
)

const icons = {
  chat:       'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  status:     ['M22 12h-4l-3 9L9 3l-3 9H2'],
  workspaces: ['M3 6l9-3 9 3v12l-9 3-9-3V6z', 'M12 3v18'],
  workers:    ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8-7v6m3-3h-6'],
  settings:   'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v3m0-12v3m-7.8 4.2 2.1-2.1M19.8 7.8l-2.1 2.1M3 12H6m12 0h3M4.2 7.8l2.1 2.1m11.3 4.3-2.1-2.1',
}

const navItems: { key: TabType; label: string; icon: keyof typeof icons }[] = [
  { key: 'chat',       label: 'Chat',       icon: 'chat' },
  { key: 'workers',    label: 'Workers',    icon: 'workers' },
  { key: 'workspaces', label: 'Workspaces', icon: 'workspaces' },
  { key: 'status',     label: 'Status',     icon: 'status' },
  { key: 'settings',   label: 'Settings',   icon: 'settings' },
]

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const stored = localStorage.getItem('codey-tab') as TabType | null
    return stored && navItems.some(n => n.key === stored) ? stored : 'chat'
  })
  const { isRunning, status, logs } = useGateway()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [currentWorkspace, setCurrentWorkspace] = useState<string>('')

  const setTab = (t: TabType) => { setActiveTab(t); localStorage.setItem('codey-tab', t) }

  // Gateway is always in-process; no toggle IPC needed

  const renderTab = () => {
    switch (activeTab) {
      case 'chat':       return <ChatTab isGatewayRunning={isRunning} messages={messages} setMessages={setMessages} />
      case 'status':     return <StatusTab status={status} logs={logs} isRunning={isRunning} />
      case 'workspaces': return <WorkspacesTab isGatewayRunning={isRunning} onWorkspaceChange={setCurrentWorkspace} />
      case 'workers':    return <WorkersTab />
      case 'settings':   return <SettingsTab isGatewayRunning={isRunning} />
    }
  }

  return (
    <div style={styles.root}>
      {/* Title bar — traffic lights are rendered by macOS over this area via hiddenInset */}
      <div style={styles.titleBar}>
        <div style={styles.titleBarDragArea}>
          <div style={{ width: 76 }} /> {/* space for macOS traffic lights */}
          <div style={styles.titleCenter}>
            <span style={styles.appName}>Codey</span>
            {isRunning && currentWorkspace && (
              <span style={styles.workspaceLabel}>· {currentWorkspace}</span>
            )}
          </div>
        </div>
        <div
          style={{
            ...styles.statusPill,
            borderColor: C.green + '55',
            background: '#32D74B11',
            color: C.green,
            cursor: 'default',
          }}
        >
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.green }} />
          Running
        </div>
      </div>
      {/* Body */}
      <div style={styles.body}>
        <div style={styles.sidebar}>
          <div style={styles.logoMark}>
            <span style={styles.logoText}>C</span>
          </div>
          <div style={styles.sidebarDivider} />
          {navItems.map(item => {
            const active = activeTab === item.key
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                title={item.label}
                style={{
                  ...styles.navBtn,
                  background: active ? C.accentDim : 'transparent',
                }}
              >
                <Icon d={icons[item.icon]} size={17} color={active ? C.accent : C.fg3} />
              </button>
            )
          })}
        </div>
        <div style={styles.content}>{renderTab()}</div>
      </div>
      <style>{`
        html, body, #root { height: 100%; margin: 0; background: ${C.bg}; }
        body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; color: ${C.fg}; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
        textarea, input, select, button { font-family: inherit; }
        input, select, textarea { color: ${C.fg}; }
        @keyframes codey-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: C.bg,
    color: C.fg,
  },
  titleBar: {
    height: 44,
    background: C.surface,
    borderBottom: `1px solid ${C.border}`,
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px 0 0',
    flexShrink: 0,
    // @ts-ignore Electron
    WebkitAppRegion: 'drag',
  },
  titleBarDragArea: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    height: '100%',
  },
  titleCenter: {
    flex: 1,
    textAlign: 'center',
    paddingRight: 76,
  },
  appName: { color: C.fg2, fontSize: 13, fontWeight: 500 },
  workspaceLabel: { color: C.fg3, fontSize: 11, marginLeft: 6 },
  statusPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    // @ts-ignore Electron
    WebkitAppRegion: 'no-drag',
  },
  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  sidebar: {
    width: 60,
    background: C.surface,
    borderRight: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: 14,
    gap: 4,
    flexShrink: 0,
    userSelect: 'none',
  },
  logoMark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    background: 'linear-gradient(135deg, #0A84FF, #0060cc)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  logoText: { color: '#fff', fontWeight: 800, fontSize: 14, letterSpacing: -1 },
  sidebarDivider: { width: 32, height: 1, background: C.border, marginBottom: 8 },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.15s',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
}

export default App
