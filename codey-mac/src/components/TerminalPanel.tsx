import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { C } from '../theme'
import { UIIcon } from './UIIcons'

interface Props {
  chatId: string
  workingDir: string
  placement: 'right' | 'bottom'
  onMove: () => void
  onClose: () => void
}

type SplitDirection = 'row' | 'column'
type DropZone = 'top' | 'bottom' | 'left' | 'right'
type DragSource = { kind: 'tab' | 'session'; id: string }
type TerminalTab = { id: string; sessions: string[]; activeSessionId: string; splitDirection?: SplitDirection }
type TerminalLayout = { tabs: TerminalTab[]; activeTabId: string }

const layoutCache = new Map<string, TerminalLayout>()
const layoutLoads = new Map<string, Promise<TerminalLayout>>()
const sessionTitleCache = new Map<string, string>()

const newTabId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const dropZoneAt = (event: React.DragEvent<HTMLElement>): DropZone => {
  const rect = event.currentTarget.getBoundingClientRect()
  const x = (event.clientX - rect.left) / Math.max(1, rect.width)
  const y = (event.clientY - rect.top) / Math.max(1, rect.height)
  const distances: Array<[DropZone, number]> = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
  distances.sort((a, b) => a[1] - b[1])
  return distances[0][0]
}

const dropIndicatorStyle = (zone: DropZone): React.CSSProperties => {
  if (zone === 'top') return { top: 0, left: 0, width: '100%', height: '50%' }
  if (zone === 'bottom') return { bottom: 0, left: 0, width: '100%', height: '50%' }
  if (zone === 'left') return { top: 0, left: 0, width: '50%', height: '100%' }
  return { top: 0, right: 0, width: '50%', height: '100%' }
}

const createSession = async (chatId: string, cwd: string): Promise<string> => {
  const result = await window.codey.terminal.open({ chatId, cwd, cols: 80, rows: 24 })
  if (!result.ok) throw new Error(result.error)
  return result.data.sessionId
}

const loadLayout = (chatId: string, cwd: string): Promise<TerminalLayout> => {
  const cached = layoutCache.get(chatId)
  if (cached) return Promise.resolve(cached)
  const pending = layoutLoads.get(chatId)
  if (pending) return pending
  const load = (async () => {
    const listed = await window.codey.terminal.list(chatId)
    let sessions = listed.ok ? listed.data.map(item => item.sessionId) : []
    if (sessions.length === 0) sessions = [await createSession(chatId, cwd)]
    const tabs = sessions.map(sessionId => ({ id: newTabId(), sessions: [sessionId], activeSessionId: sessionId }))
    const layout = { tabs, activeTabId: tabs[0].id }
    layoutCache.set(chatId, layout)
    return layout
  })().finally(() => layoutLoads.delete(chatId))
  layoutLoads.set(chatId, load)
  return load
}

export const TerminalPanel: React.FC<Props> = ({ chatId, workingDir, placement, onMove, onClose }) => {
  const [layout, setLayout] = React.useState<TerminalLayout | null>(() => layoutCache.get(chatId) ?? null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [sessionTitles, setSessionTitles] = React.useState<Record<string, string>>(() => Object.fromEntries(sessionTitleCache))
  const [restartTokens, setRestartTokens] = React.useState<Record<string, number>>({})
  const [draggedTabId, setDraggedTabId] = React.useState<string | null>(null)
  const [draggedSessionId, setDraggedSessionId] = React.useState<string | null>(null)
  const [dropTarget, setDropTarget] = React.useState<{ sessionId: string; zone: DropZone } | null>(null)
  const [tabDropLocator, setTabDropLocator] = React.useState<{ index: number; left: number } | null>(null)
  const dragSourceRef = React.useRef<DragSource | null>(null)
  const tabDropIndexRef = React.useRef<number | null>(null)

  const commit = React.useCallback((next: TerminalLayout) => {
    layoutCache.set(chatId, next)
    setLayout(next)
  }, [chatId])

  React.useEffect(() => {
    let cancelled = false
    void loadLayout(chatId, workingDir)
      .then(next => { if (!cancelled) setLayout(next) })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [chatId, workingDir])

  const activeTab = layout?.tabs.find(tab => tab.id === layout.activeTabId) ?? layout?.tabs[0]

  const addTab = async () => {
    if (!layout || busy) return
    setBusy(true); setError(null)
    try {
      const sessionId = await createSession(chatId, workingDir)
      const tab = { id: newTabId(), sessions: [sessionId], activeSessionId: sessionId }
      commit({ tabs: [...layout.tabs, tab], activeTabId: tab.id })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  const splitActive = async () => {
    if (!layout || !activeTab || activeTab.sessions.length >= 2 || busy) return
    setBusy(true); setError(null)
    try {
      const sessionId = await createSession(chatId, workingDir)
      const tabs = layout.tabs.map(tab => tab.id === activeTab.id
        ? { ...tab, sessions: [...tab.sessions, sessionId], activeSessionId: sessionId, splitDirection: 'row' as const }
        : tab)
      commit({ ...layout, tabs })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  const restartActive = async () => {
    if (!activeTab || busy) return
    setBusy(true); setError(null)
    try {
      const result = await window.codey.terminal.restart({
        sessionId: activeTab.activeSessionId,
        chatId,
        cwd: workingDir,
        cols: 80,
        rows: 24,
      })
      if (!result.ok) throw new Error(result.error)
      sessionTitleCache.delete(activeTab.activeSessionId)
      setSessionTitles(current => {
        const next = { ...current }
        delete next[activeTab.activeSessionId]
        return next
      })
      setRestartTokens(current => ({
        ...current,
        [activeTab.activeSessionId]: (current[activeTab.activeSessionId] ?? 0) + 1,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  const closeTab = async (tabId: string) => {
    if (!layout || layout.tabs.length <= 1) return
    const tab = layout.tabs.find(item => item.id === tabId)
    if (!tab) return
    await Promise.all(tab.sessions.map(sessionId => window.codey.terminal.close(sessionId)))
    const tabs = layout.tabs.filter(item => item.id !== tabId)
    commit({ tabs, activeTabId: layout.activeTabId === tabId ? tabs[0].id : layout.activeTabId })
  }

  const closeSplit = async (sessionId: string) => {
    if (!layout || !activeTab || activeTab.sessions.length <= 1) return
    await window.codey.terminal.close(sessionId)
    const sessions = activeTab.sessions.filter(id => id !== sessionId)
    const tabs = layout.tabs.map(tab => tab.id === activeTab.id
      ? { ...tab, sessions, activeSessionId: sessions[0] }
      : tab)
    commit({ ...layout, tabs })
  }

  const focusSession = (sessionId: string) => {
    if (!layout || !activeTab || activeTab.activeSessionId === sessionId) return
    const tabs = layout.tabs.map(tab => tab.id === activeTab.id ? { ...tab, activeSessionId: sessionId } : tab)
    commit({ ...layout, tabs })
  }

  const setSessionTitle = React.useCallback((sessionId: string, title: string) => {
    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 36)
    if (!clean || sessionTitleCache.get(sessionId) === clean) return
    sessionTitleCache.set(sessionId, clean)
    setSessionTitles(current => ({ ...current, [sessionId]: clean }))
  }, [])

  const reorderTabs = (sourceId: string, targetId: string) => {
    if (!layout || sourceId === targetId) return
    const sourceIndex = layout.tabs.findIndex(tab => tab.id === sourceId)
    const targetIndex = layout.tabs.findIndex(tab => tab.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const tabs = [...layout.tabs]
    const [source] = tabs.splice(sourceIndex, 1)
    tabs.splice(targetIndex, 0, source)
    commit({ ...layout, tabs })
  }

  const moveSessionToTab = (sessionId: string, targetTabId: string) => {
    if (!layout) return
    const sourceTab = layout.tabs.find(tab => tab.sessions.includes(sessionId))
    const targetTab = layout.tabs.find(tab => tab.id === targetTabId)
    if (!sourceTab || !targetTab) return
    if (sourceTab.id === targetTab.id) {
      commit({ ...layout, activeTabId: targetTab.id })
      return
    }
    if (targetTab.sessions.length >= 2) return
    const tabs = layout.tabs
      .map(tab => tab.id === sourceTab.id
        ? { ...tab, sessions: tab.sessions.filter(id => id !== sessionId), activeSessionId: tab.sessions.find(id => id !== sessionId) ?? '' }
        : tab.id === targetTab.id
          ? { ...tab, sessions: [...tab.sessions, sessionId], activeSessionId: sessionId, splitDirection: 'row' as const }
          : tab)
      .filter(tab => tab.sessions.length > 0)
    commit({ tabs, activeTabId: targetTab.id })
  }

  const placeSessionAt = (sourceId: string, targetId: string, zone: DropZone) => {
    if (!layout || sourceId === targetId) return
    const sourceTab = layout.tabs.find(tab => tab.sessions.includes(sourceId))
    const targetTab = layout.tabs.find(tab => tab.sessions.includes(targetId))
    if (!sourceTab || !targetTab) return
    if (sourceTab.id !== targetTab.id && targetTab.sessions.length >= 2) return
    const before = zone === 'left' || zone === 'top'
    const splitDirection: SplitDirection = zone === 'top' || zone === 'bottom' ? 'column' : 'row'
    const targetSessions = targetTab.sessions.filter(id => id !== sourceId && id !== targetId)
    const placedSessions = before
      ? [sourceId, targetId, ...targetSessions]
      : [targetId, sourceId, ...targetSessions]
    const tabs = layout.tabs
      .map(tab => tab.id === sourceTab.id && sourceTab.id !== targetTab.id
        ? { ...tab, sessions: tab.sessions.filter(id => id !== sourceId), activeSessionId: tab.sessions.find(id => id !== sourceId) ?? '' }
        : tab.id === targetTab.id
          ? { ...tab, sessions: placedSessions, activeSessionId: sourceId, splitDirection }
          : tab)
      .filter(tab => tab.sessions.length > 0)
    commit({ tabs, activeTabId: targetTab.id })
  }

  const draggedSourceSession = () => {
    const source = dragSourceRef.current
    if (!source || !layout) return null
    if (source.kind === 'session') return source.id
    const tab = layout.tabs.find(item => item.id === source.id)
    return tab?.sessions.length === 1 ? tab.sessions[0] : null
  }

  const setDragPayload = (event: React.DragEvent<HTMLElement>, source: DragSource) => {
    dragSourceRef.current = source
    event.dataTransfer.effectAllowed = 'move'
    // Chromium starts native drags more consistently when a standard text
    // payload is present; the ref remains the synchronous source of truth.
    event.dataTransfer.setData('text/plain', `codey-terminal:${source.kind}:${source.id}`)
    event.dataTransfer.setData(
      source.kind === 'tab' ? 'application/x-codey-terminal-tab' : 'application/x-codey-terminal-session',
      source.id,
    )
    if (source.kind === 'tab') setDraggedTabId(source.id)
    else setDraggedSessionId(source.id)
  }

  const clearDrag = () => {
    dragSourceRef.current = null
    setDraggedTabId(null)
    setDraggedSessionId(null)
    setDropTarget(null)
    setTabDropLocator(null)
    tabDropIndexRef.current = null
  }

  const moveSessionToNewTab = (sessionId: string, insertAt = layout?.tabs.length ?? 0) => {
    if (!layout) return
    const sourceTab = layout.tabs.find(tab => tab.sessions.includes(sessionId))
    if (!sourceTab || sourceTab.sessions.length <= 1) return
    const sessions = sourceTab.sessions.filter(id => id !== sessionId)
    const newTab = { id: newTabId(), sessions: [sessionId], activeSessionId: sessionId }
    const tabs = layout.tabs.map(tab => tab.id === sourceTab.id
      ? { ...tab, sessions, activeSessionId: sessions[0] }
      : tab)
    const index = Math.max(0, Math.min(tabs.length, insertAt))
    tabs.splice(index, 0, newTab)
    commit({ tabs, activeTabId: newTab.id })
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div
          style={styles.tabs}
          onDragOverCapture={event => {
            const source = dragSourceRef.current
            if (source?.kind !== 'session') return
            const sourceTab = layout?.tabs.find(tab => tab.sessions.includes(source.id))
            if (!sourceTab || sourceTab.sessions.length <= 1) return
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'
            const container = event.currentTarget
            const tabs = Array.from(container.querySelectorAll<HTMLElement>('[data-terminal-tab]'))
            let index = tabs.findIndex(tab => event.clientX < tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2)
            if (index < 0) index = tabs.length
            const left = index < tabs.length
              ? tabs[index].offsetLeft - 2
              : tabs.length > 0 ? tabs[tabs.length - 1].offsetLeft + tabs[tabs.length - 1].offsetWidth + 2 : 3
            tabDropIndexRef.current = index
            setTabDropLocator({ index, left })
          }}
          onDrop={event => {
            event.preventDefault()
            const sessionId = event.dataTransfer.getData('application/x-codey-terminal-session')
              || (dragSourceRef.current?.kind === 'session' ? dragSourceRef.current.id : '')
            if (sessionId) moveSessionToNewTab(sessionId, tabDropIndexRef.current ?? layout?.tabs.length)
            clearDrag()
          }}
        >
          {tabDropLocator && <span style={{ ...styles.tabDropIndicator, left: tabDropLocator.left }} />}
          {layout?.tabs.map((tab, index) => (
            <button
              key={tab.id}
              data-terminal-tab={tab.id}
              draggable
              style={{ ...styles.tab, ...(tab.id === activeTab?.id ? styles.tabActive : null), opacity: draggedTabId === tab.id ? 0.55 : 1 }}
              onClick={() => commit({ ...layout, activeTabId: tab.id })}
              onDragStart={event => {
                setDragPayload(event, { kind: 'tab', id: tab.id })
              }}
              onDragEnd={clearDrag}
              onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
              onDrop={event => {
                event.preventDefault(); event.stopPropagation()
                const sessionId = event.dataTransfer.getData('application/x-codey-terminal-session')
                const tabId = event.dataTransfer.getData('application/x-codey-terminal-tab')
                const sourceTab = sessionId ? layout.tabs.find(item => item.sessions.includes(sessionId)) : undefined
                if (sessionId && sourceTab && sourceTab.sessions.length > 1) moveSessionToNewTab(sessionId, tabDropIndexRef.current ?? index)
                else if (sessionId) moveSessionToTab(sessionId, tab.id)
                else if (tabId) reorderTabs(tabId, tab.id)
                clearDrag()
              }}
              title={`${sessionTitles[tab.activeSessionId] || `Terminal ${index + 1}`} · drag to reorder`}
            >
              <UIIcon name="terminal" size={13} />
              <span style={styles.tabTitle}>{sessionTitles[tab.activeSessionId] || `Shell ${index + 1}`}</span>
              {layout.tabs.length > 1 && (
                <span
                  role="button"
                  aria-label={`Close terminal ${index + 1}`}
                  style={styles.tabClose}
                  onClick={(event) => { event.stopPropagation(); void closeTab(tab.id) }}
                >×</span>
              )}
            </button>
          ))}
        </div>
        <div style={styles.actions}>
          <button style={styles.iconButton} disabled={busy || !layout} onClick={() => void addTab()} title="New terminal tab" aria-label="New terminal tab">
            <UIIcon name="plus" size={14} />
          </button>
          <button style={styles.iconButton} disabled={busy || !activeTab || activeTab.sessions.length >= 2} onClick={() => void splitActive()} title="Split terminal" aria-label="Split terminal">
            <UIIcon name="split" size={14} />
          </button>
          <button style={styles.iconButton} disabled={busy || !activeTab} onClick={() => void restartActive()} title="Restart active terminal" aria-label="Restart active terminal">
            <UIIcon name="refresh" size={13} />
          </button>
          {placement === 'bottom' && (
            <button style={styles.iconButton} onClick={onMove} title="Move Terminal to right panel" aria-label="Move Terminal to right panel">
              <UIIcon name="panel-right" size={14} />
            </button>
          )}
          {placement === 'bottom' && (
            <button style={styles.iconButton} onClick={onClose} title="Close bottom panel" aria-label="Close bottom panel">
              <UIIcon name="close" size={14} />
            </button>
          )}
        </div>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={{ ...styles.panes, flexDirection: activeTab?.splitDirection ?? 'row' }}>
        {activeTab?.sessions.map((sessionId, index) => (
          <div
            key={sessionId}
            style={{
              ...styles.pane,
              ...(index > 0 ? (activeTab.splitDirection === 'column' ? styles.paneSplitTop : styles.paneSplitLeft) : null),
              opacity: draggedSessionId === sessionId ? 0.7 : 1,
            }}
            onDragOverCapture={event => {
              const sourceId = draggedSourceSession()
              if (!sourceId || sourceId === sessionId) return
              const sourceTab = layout?.tabs.find(tab => tab.sessions.includes(sourceId))
              const targetTab = layout?.tabs.find(tab => tab.sessions.includes(sessionId))
              if (!sourceTab || !targetTab || (sourceTab.id !== targetTab.id && targetTab.sessions.length >= 2)) return
              event.preventDefault(); event.dataTransfer.dropEffect = 'move'
              setTabDropLocator(null); tabDropIndexRef.current = null
              setDropTarget({ sessionId, zone: dropZoneAt(event) })
            }}
            onDropCapture={event => {
              event.preventDefault(); event.stopPropagation()
              const sourceId = event.dataTransfer.getData('application/x-codey-terminal-session') || draggedSourceSession()
              if (sourceId) placeSessionAt(sourceId, sessionId, dropZoneAt(event))
              clearDrag()
            }}
          >
            <div
              draggable
              style={styles.paneHeader}
              title="Drag to a pane edge to split, or onto a tab to move"
              aria-label={`Drag ${sessionTitles[sessionId] || 'terminal'} pane`}
              onDragStart={event => {
                setDragPayload(event, { kind: 'session', id: sessionId })
              }}
              onDragEnd={clearDrag}
            >
              <span style={styles.paneTitle}>{sessionTitles[sessionId] || 'Shell'}</span>
              {activeTab.sessions.length > 1 && (
                <button draggable={false} style={styles.splitClose} onMouseDown={event => event.stopPropagation()} onClick={() => void closeSplit(sessionId)} title="Close split" aria-label="Close split">×</button>
              )}
            </div>
            <TerminalSessionView
              sessionId={sessionId}
              chatId={chatId}
              workingDir={workingDir}
              active={activeTab.activeSessionId === sessionId}
              restartToken={restartTokens[sessionId] ?? 0}
              onFocus={() => focusSession(sessionId)}
              onTitle={setSessionTitle}
            />
          </div>
        ))}
        {dropTarget && (
          <div style={styles.layoutPreview}>
            <div style={{ ...styles.dropIndicator, ...dropIndicatorStyle(dropTarget.zone) }} />
          </div>
        )}
        {!activeTab && !error && <div style={styles.loading}>Opening shell…</div>}
      </div>
    </div>
  )
}

const terminalTheme = () => {
  const root = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => root.getPropertyValue(`--${name}`).trim() || fallback
  return {
    background: color('codeBg', '#111318'), foreground: color('codeFg', '#e6e6e6'),
    cursor: color('accent', '#6d7cff'), cursorAccent: color('codeBg', '#111318'),
    selectionBackground: color('accentDim', '#6d7cff44'), black: '#1e1e1e',
    red: color('red', '#ff453a'), green: color('green', '#32d74b'), yellow: color('yellow', '#ffd60a'),
    blue: color('accent', '#6d7cff'), magenta: '#c586c0', cyan: '#4ec9b0', white: color('fg2', '#aeb8cc'),
    brightBlack: color('fg3', '#71809b'), brightRed: color('red', '#ff6961'),
    brightGreen: color('green', '#5ee071'), brightYellow: color('yellow', '#ffe36e'),
    brightBlue: color('accent', '#8995ff'), brightMagenta: '#d7a0d2',
    brightCyan: '#70d7c3', brightWhite: color('fg', '#f2f5fb'),
  }
}

const TerminalSessionView: React.FC<{
  sessionId: string
  chatId: string
  workingDir: string
  active: boolean
  restartToken: number
  onFocus: () => void
  onTitle: (sessionId: string, title: string) => void
}> = ({ sessionId, chatId, workingDir, active, restartToken, onFocus, onTitle }) => {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const terminalRef = React.useRef<Terminal | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 12, lineHeight: 1.25, scrollback: 10_000, theme: terminalTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal

    const input = terminal.onData(data => { void window.codey.terminal.write(sessionId, data) })
    const titleChange = terminal.onTitleChange(title => { if (title.trim()) onTitle(sessionId, title) })
    const offData = window.codey.terminal.onData(event => {
      if (event.sessionId === sessionId) terminal.write(event.data)
    })
    const offExit = window.codey.terminal.onExit(event => {
      if (event.sessionId === sessionId) terminal.writeln(`\r\n\x1b[90m[process exited with code ${event.exitCode}]\x1b[0m`)
    })

    let frame = 0
    const fitAndResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        try {
          fit.fit()
          void window.codey.terminal.resize(sessionId, terminal.cols, terminal.rows)
        } catch { /* zero-sized during tab transitions */ }
      })
    }
    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)
    fitAndResize()
    void window.codey.terminal.open({ sessionId, chatId, cwd: workingDir, cols: terminal.cols, rows: terminal.rows })
      .then(result => {
        if (!result.ok) terminal.writeln(`\r\n\x1b[31m${result.error}\x1b[0m`)
        else if (result.data.output) terminal.write(result.data.output)
      })

    const refreshTitle = () => {
      void window.codey.terminal.status(sessionId).then(result => {
        if (result.ok) onTitle(sessionId, result.data.title)
      })
    }
    refreshTitle()
    const titleTimer = window.setInterval(refreshTitle, 1500)

    return () => {
      cancelAnimationFrame(frame); window.clearInterval(titleTimer); observer.disconnect(); input.dispose(); titleChange.dispose(); offData(); offExit(); terminal.dispose()
      terminalRef.current = null
    }
  }, [sessionId, chatId, workingDir, restartToken, onTitle])

  React.useEffect(() => { if (active) terminalRef.current?.focus() }, [active])
  return <div ref={hostRef} style={styles.terminal} onMouseDown={onFocus} onClick={() => terminalRef.current?.focus()} />
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: C.codeBg },
  header: {
    minHeight: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, padding: '5px 7px', background: C.surface2, borderBottom: `1px solid ${C.border2}`,
  },
  tabs: { flex: 1, minWidth: 0, minHeight: 28, position: 'relative', display: 'flex', alignItems: 'center', gap: 3, overflowX: 'auto' },
  tabDropIndicator: {
    position: 'absolute', top: 1, bottom: 1, zIndex: 12, width: 4, borderRadius: 3,
    background: C.green, boxShadow: `0 0 8px ${C.green}`, pointerEvents: 'none',
  },
  tab: {
    height: 28, minWidth: 74, maxWidth: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
    padding: '0 7px', color: C.fg3, background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer',
    fontSize: 10.5, fontWeight: 650,
  },
  tabActive: { color: C.fg, background: C.accentDim },
  tabTitle: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tabClose: { color: C.fg3, fontSize: 14, lineHeight: 1, paddingLeft: 2 },
  actions: { display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 },
  iconButton: {
    width: 27, height: 27, display: 'grid', placeItems: 'center', padding: 0,
    color: C.fg2, background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer',
  },
  error: { flexShrink: 0, padding: '6px 10px', color: C.dangerFg, background: C.dangerBg, fontSize: 11 },
  panes: { flex: 1, minHeight: 0, position: 'relative', display: 'flex', background: C.codeBg },
  pane: { flex: 1, minWidth: 0, minHeight: 0, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  paneSplitLeft: { borderLeft: `1px solid ${C.border2}` },
  paneSplitTop: { borderTop: `1px solid ${C.border2}` },
  paneHeader: {
    height: 25, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px 0 9px',
    background: C.surface2, color: C.fg2, borderBottom: `1px solid ${C.border2}`, cursor: 'grab', userSelect: 'none',
  },
  paneTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 600 },
  splitClose: {
    width: 19, height: 19, flexShrink: 0, padding: 0, display: 'grid', placeItems: 'center',
    border: 'none', borderRadius: 5, background: C.surface3, color: C.fg2, cursor: 'pointer',
  },
  layoutPreview: {
    position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none', overflow: 'hidden',
    background: 'transparent',
  },
  dropIndicator: {
    position: 'absolute', pointerEvents: 'none',
    background: C.green, boxShadow: `inset 0 0 0 2px rgba(255,255,255,.3), 0 0 16px ${C.green}`,
  },
  terminal: { flex: 1, width: '100%', minHeight: 0, padding: '8px 6px 4px 9px', overflow: 'hidden', background: C.codeBg },
  loading: { flex: 1, display: 'grid', placeItems: 'center', color: C.fg3, fontSize: 11 },
}
