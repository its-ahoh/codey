import React, { useState } from 'react'
import { ChatTab } from './components/ChatTab'
import { ChatListPanel } from './components/ChatListPanel'
import { SettingsOverlay } from './components/SettingsOverlay'
import { ChatsProvider, useChats } from './hooks/useChats'
import { useGateway } from './hooks/useGateway'
import { C } from './theme'

const Shell: React.FC = () => {
  const { isRunning } = useGateway()
  const { state } = useChats()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeChat = state.selectedChatId ? state.chats[state.selectedChatId] : null

  return (
    <div style={styles.root}>
      <div style={styles.titleBar}>
        <div style={styles.titleBarDragArea}>
          <div style={{ width: 76 }} />
          <div style={styles.titleCenter}>
            <span style={styles.appName}>Codey</span>
            {activeChat && <span style={styles.workspaceLabel}>· {activeChat.workspaceName}</span>}
          </div>
        </div>
        <div style={{
          ...styles.statusPill,
          borderColor: C.green + '55',
          background: '#32D74B11',
          color: C.green,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.green }} />
          Running
        </div>
      </div>
      <div style={styles.body}>
        <ChatListPanel
          onOpenSettings={() => setSettingsOpen(true)}
          activeChatId={state.selectedChatId}
        />
        <div style={styles.content}>
          {Object.values(state.chats).map(chat => (
            <div
              key={chat.id}
              style={{
                display: state.selectedChatId === chat.id ? 'flex' : 'none',
                flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden',
              }}
            >
              <ChatTab chatId={chat.id} isGatewayRunning={isRunning} />
            </div>
          ))}
          {!activeChat && (
            <div style={styles.emptyMain}>
              {state.order.length === 0
                ? 'No chats yet. Click "New Chat" on the left to start.'
                : 'Select a chat on the left.'}
            </div>
          )}
        </div>
        {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}
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

const App: React.FC = () => (
  <ChatsProvider>
    <Shell />
  </ChatsProvider>
)

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.fg },
  titleBar: {
    height: 44, background: C.surface, borderBottom: `1px solid ${C.border}`,
    display: 'flex', alignItems: 'center', padding: '0 14px 0 0', flexShrink: 0,
    // @ts-ignore Electron
    WebkitAppRegion: 'drag',
  },
  titleBarDragArea: { flex: 1, display: 'flex', alignItems: 'center', height: '100%' },
  titleCenter: { flex: 1, textAlign: 'center', paddingRight: 76 },
  appName: { color: C.fg2, fontSize: 13, fontWeight: 500 },
  workspaceLabel: { color: C.fg3, fontSize: 11, marginLeft: 6 },
  statusPill: {
    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
    borderRadius: 6, border: '1px solid', fontSize: 11, fontWeight: 600,
    // @ts-ignore Electron
    WebkitAppRegion: 'no-drag',
  },
  body: { flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' },
  content: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  emptyMain: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.fg3 },
}

export default App
