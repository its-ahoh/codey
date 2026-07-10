import React, { useEffect, useState } from 'react'
import { ChatTab } from './components/ChatTab'
import { ChatListPanel } from './components/ChatListPanel'
import { SettingsOverlay } from './components/SettingsOverlay'
import { VoiceRecorder } from './components/VoiceRecorder'
import { NotificationCenter } from './components/NotificationCenter'
import { ChatsProvider, useChats } from './hooks/useChats'
import { QuickQuestionProvider } from './hooks/useQuickQuestion'
import { useGateway } from './hooks/useGateway'
import { CoreOfflineBanner } from './components/CoreOfflineBanner'
import { AutomationsView } from './components/AutomationsView'
import { unwrap } from './components/settingsAtoms'
import {
  C,
  applyTheme,
  applyPalette,
  getStoredThemeMode,
  getStoredPalette,
  resolveEffectiveTheme,
  paletteToCssVars,
  classicLight,
  classicDark,
  terminalLight,
  terminalDark,
} from './theme'

const Shell: React.FC = () => {
  const { isRunning, coreState, relaunchApp } = useGateway()
  const { state, createChat, selectChat, refreshWorkspaces } = useChats()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [automationsOpen, setAutomationsOpen] = useState(false)
  // Unseen automation-run keys (`${automationId}:${runId}`), for the sidebar
  // badge. A Set so the one-shot 'automation-unseen' push and the on-mount
  // recompute from history can both add to it without racing each other.
  const [unseenRunKeys, setUnseenRunKeys] = useState<Set<string>>(new Set())
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(
    () => localStorage.getItem('codey.leftPanelCollapsed') === '1'
  )

  const activeChat = state.selectedChatId ? state.chats[state.selectedChatId] : null

  const toggleLeftPanel = () => {
    setLeftCollapsed((prev) => {
      const next = !prev
      localStorage.setItem('codey.leftPanelCollapsed', next ? '1' : '0')
      return next
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey
      if (!isMeta) return
      if (e.key === 'n') {
        e.preventDefault()
        const ws = localStorage.getItem('codey.lastWorkspace') ?? state.workspaces[0]
        if (ws) createChat(ws)
      } else if (e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (e.key === '\\') {
        e.preventDefault()
        toggleLeftPanel()
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1
        const id = state.order[idx]
        if (id) { e.preventDefault(); selectChat(id) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.order, state.workspaces, createChat, selectChat])

  useEffect(() => {
    const off = window.codey.notify.onOpenSettings(() => {
      setSettingsTab('general')
      setSettingsOpen(true)
    })
    return off
  }, [])

  // Addition 3: the nav badge must not rely solely on the one-shot
  // 'automation-unseen' push (missed if it fires before this mounts, or if
  // the app was relaunched) — also recompute from history on mount. Both
  // paths merge into the same Set, whichever arrives.
  useEffect(() => {
    let cancelled = false
    const off = window.codey.automations.onUnseen((msg) => {
      setUnseenRunKeys(prev => {
        const next = new Set(prev)
        for (const runId of msg.runIds) next.add(`${msg.automationId}:${runId}`)
        return next
      })
    })
    void (async () => {
      try {
        const autos = unwrap(await window.codey.automations.list())
        const perAuto = await Promise.all(autos.map(async a => {
          try {
            const runs = unwrap(await window.codey.automations.history(a.id, 50))
            return runs.filter(r => r.endedAt && !r.seenAt).map(r => `${a.id}:${r.runId}`)
          } catch {
            return [] as string[]
          }
        }))
        if (cancelled) return
        setUnseenRunKeys(prev => {
          const next = new Set(prev)
          for (const keys of perAuto) for (const k of keys) next.add(k)
          return next
        })
      } catch {
        // gateway not ready yet — the push will still arrive when it fires
      }
    })()
    return () => { cancelled = true; off() }
  }, [])

  const openAutomations = () => {
    setUnseenRunKeys(new Set())
    setAutomationsOpen(true)
  }

  useEffect(() => {
    applyTheme(getStoredThemeMode())
    applyPalette(getStoredPalette())
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (getStoredThemeMode() === 'system') {
        document.documentElement.dataset.theme = resolveEffectiveTheme('system')
      }
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return (
    <div style={styles.root}>
      <div style={styles.titleBar}>
        <div style={styles.titleBarDragArea}>
          <div style={{ width: 76 }} />
          <button
            type="button"
            onClick={toggleLeftPanel}
            title={leftCollapsed ? 'Show sidebar (⌘\\)' : 'Hide sidebar (⌘\\)'}
            aria-label={leftCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            style={styles.sidebarToggle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
              {!leftCollapsed && <rect x="3" y="3" width="6" height="18" rx="0" fill="currentColor" stroke="none" />}
            </svg>
          </button>
          <div style={styles.titleCenter}>
            {activeChat && <span style={styles.appName} title={activeChat.title}>{activeChat.title}</span>}
          </div>
        </div>
        <NotificationCenter />
      </div>
      <div style={styles.body}>
        {!leftCollapsed && (
          <ChatListPanel
            onOpenSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true) }}
            onOpenAutomations={openAutomations}
            automationsUnseenCount={unseenRunKeys.size}
            activeChatId={state.selectedChatId}
          />
        )}
        <div style={styles.content}>
          <CoreOfflineBanner state={coreState} onRelaunch={relaunchApp} />
          {activeChat && (
            <div
              key={activeChat.id}
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            >
              <ChatTab chatId={activeChat.id} isGatewayRunning={isRunning} coreFailed={coreState.phase === 'failed'} />
            </div>
          )}
          {!activeChat && (
            <div style={styles.emptyMain}>
              {state.order.length === 0
                ? 'No chats yet. Click "New Chat" on the left to start.'
                : 'Select a chat on the left.'}
            </div>
          )}
        </div>
        {settingsOpen && <SettingsOverlay initialTab={settingsTab} onClose={() => { setSettingsOpen(false); setSettingsTab(undefined); refreshWorkspaces() }} />}
        {automationsOpen && <AutomationsView onClose={() => setAutomationsOpen(false)} />}
        <VoiceRecorder />
      </div>
      <style>{`
  /* Fallback (classic) until data-theme / data-palette are set. */
  :root {
${paletteToCssVars(classicDark)}
  }
  :root[data-theme="light"] {
${paletteToCssVars(classicLight)}
  }
  :root[data-theme="dark"] {
${paletteToCssVars(classicDark)}
  }
  /* Classic theme */
  :root[data-palette="classic"][data-theme="light"] {
${paletteToCssVars(classicLight)}
  }
  :root[data-palette="classic"][data-theme="dark"] {
${paletteToCssVars(classicDark)}
  }
  /* Terminal theme */
  :root[data-palette="terminal"][data-theme="light"] {
${paletteToCssVars(terminalLight)}
  }
  :root[data-palette="terminal"][data-theme="dark"] {
${paletteToCssVars(terminalDark)}
  }
  html, body, #root { height: 100%; margin: 0; background: ${C.bg}; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; color: ${C.fg}; }
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${C.scrollbar}; border-radius: 3px; }
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
    <QuickQuestionProvider>
      <Shell />
    </QuickQuestionProvider>
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
  titleCenter: { flex: 1, textAlign: 'center', paddingLeft: 4, paddingRight: 4, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
  appName: { color: C.fg2, fontSize: 13, fontWeight: 500 },
  sidebarToggle: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: C.fg3, padding: 4, marginLeft: 4, borderRadius: 4,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    // @ts-ignore Electron
    WebkitAppRegion: 'no-drag',
  },
  body: { flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' },
  content: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  emptyMain: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.fg3 },
}

export default App
