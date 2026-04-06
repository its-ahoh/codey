import React, { useState, useEffect } from 'react'
import { ChatTab } from './components/ChatTab'
import { StatusTab } from './components/StatusTab'
import { SettingsTab } from './components/SettingsTab'
import { WorkspacesTab } from './components/WorkspacesTab'
import { useGateway } from './hooks/useGateway'
import { ChatMessage } from './types'

type TabType = 'chat' | 'status' | 'settings' | 'workspaces'

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('chat')
  const { isRunning, status, logs, toggle } = useGateway()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onGatewayToggle) return

    const cleanup = api.onGatewayToggle((action: string) => {
      if (action === 'start' && !isRunning) toggle()
      else if (action === 'stop' && isRunning) toggle()
    })

    return cleanup
  }, [isRunning, toggle])

  const tabs: { key: TabType; label: string }[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'status', label: 'Status' },
    { key: 'settings', label: 'Settings' },
    { key: 'workspaces', label: 'Workspaces' },
  ]

  const renderTab = () => {
    switch (activeTab) {
      case 'chat':
        return <ChatTab isGatewayRunning={isRunning} messages={messages} setMessages={setMessages} isLoading={isLoading} setIsLoading={setIsLoading} />
      case 'status':
        return <StatusTab status={status} logs={logs} isRunning={isRunning} onToggle={toggle} />
      case 'settings':
        return <SettingsTab isGatewayRunning={isRunning} />
      case 'workspaces':
        return <WorkspacesTab isGatewayRunning={isRunning} />
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.tabBar}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            style={{
              ...styles.tab,
              ...(activeTab === tab.key ? styles.activeTab : {})
            }}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={styles.content}>{renderTab()}</div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#1a1a1a',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid #333',
  },
  tab: {
    flex: 1,
    padding: '14px',
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: '14px',
    transition: 'all 0.2s',
  },
  activeTab: {
    color: '#fff',
    fontWeight: 600,
    borderBottom: '2px solid #007AFF',
  },
  content: {
    flex: 1,
    overflow: 'auto',
  },
}

export default App
