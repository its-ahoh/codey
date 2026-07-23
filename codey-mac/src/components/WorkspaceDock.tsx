import React from 'react'
import type { BrowserLoginWaitEvent } from '../codey-api'
import { C } from '../theme'
import { BrowserPanel } from './BrowserPanel'
import { TerminalPanel } from './TerminalPanel'
import { UIIcon, type IconName } from './UIIcons'

export type WorkspaceDockTool = 'overview' | 'terminal' | 'browser'

interface Props {
  tool: WorkspaceDockTool
  width: number
  overview: React.ReactNode
  chatId: string
  workingDir?: string
  loginWait?: BrowserLoginWaitEvent | null
  onConfirmLoginWait?: (event: BrowserLoginWaitEvent) => void
  onDismissLoginWait?: () => void
  onSelectTool: (tool: WorkspaceDockTool) => void
  onClose: () => void
  onResize: (width: number) => void
  onDockTerminalBottom: () => void
  overlay?: boolean
}

export const WorkspaceDock: React.FC<Props> = ({
  tool, width, overview, chatId, workingDir, loginWait, onConfirmLoginWait, onDismissLoginWait,
  onSelectTool, onClose, onResize, onDockTerminalBottom, overlay = false,
}) => {
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const move = (next: PointerEvent) => {
      const max = Math.max(320, window.innerWidth - 500)
      onResize(Math.max(320, Math.min(max, startWidth + startX - next.clientX)))
    }
    const up = (next: PointerEvent) => {
      move(next)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside style={{ ...styles.root, width, ...(overlay ? styles.rootOverlay : null) }} aria-label="Chat workspace panel">
      <div style={styles.resizer} onPointerDown={startResize} title="Resize right panel" />
      <div style={styles.toolbar}>
        <ToolButton tool="overview" active={tool === 'overview'} icon="overview" label="Overview" onSelect={onSelectTool} />
        <ToolButton tool="terminal" active={tool === 'terminal'} icon="terminal" label="Terminal" onSelect={onSelectTool} />
        <ToolButton tool="browser" active={tool === 'browser'} icon="globe" label="Browser" onSelect={onSelectTool} />
        <span style={styles.spacer} />
        {tool === 'terminal' && (
          <button style={styles.iconButton} onClick={onDockTerminalBottom} title="Move Terminal to bottom" aria-label="Move Terminal to bottom">
            <UIIcon name="panel-bottom" size={15} />
          </button>
        )}
        <button style={styles.iconButton} onClick={onClose} title="Close right panel" aria-label="Close right panel">
          <UIIcon name="close" size={15} />
        </button>
      </div>

      <div style={styles.content}>
        {tool === 'overview' ? overview : tool === 'browser' ? (
          <BrowserPanel
            chatId={chatId}
            embedded
            loginWait={loginWait}
            onConfirmLoginWait={onConfirmLoginWait}
            onDismissLoginWait={onDismissLoginWait}
            onClose={onClose}
          />
        ) : workingDir ? (
          <TerminalPanel
            chatId={chatId}
            workingDir={workingDir}
            placement="right"
            onMove={() => onDockTerminalBottom()}
            onClose={onClose}
          />
        ) : (
          <div style={styles.unavailable}>Resolving workspace directory…</div>
        )}
      </div>
    </aside>
  )
}

const ToolButton: React.FC<{
  tool: WorkspaceDockTool
  active: boolean
  icon: IconName
  label: string
  onSelect: (tool: WorkspaceDockTool) => void
}> = ({ tool, active, icon, label, onSelect }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    onClick={() => onSelect(tool)}
    style={{ ...styles.toolButton, ...(active ? styles.toolButtonActive : null) }}
  >
    <UIIcon name={icon} size={16} />
  </button>
)

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative', height: '100%', minWidth: 320, flexShrink: 0,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    background: C.surface, borderLeft: `1px solid ${C.border2}`,
  },
  rootOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 35, boxShadow: '-16px 0 36px rgba(0,0,0,0.28)' },
  resizer: { position: 'absolute', left: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 20 },
  toolbar: {
    minHeight: 43, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 8px', background: C.sidebarBg, borderBottom: `1px solid ${C.sidebarBorder}`,
  },
  toolButton: {
    width: 31, height: 30, display: 'grid', placeItems: 'center',
    padding: 0, color: C.fg3, background: 'transparent', border: '1px solid transparent',
    borderRadius: 7, cursor: 'pointer',
  },
  toolButtonActive: { color: C.fg, background: C.accentDim },
  spacer: { flex: 1 },
  iconButton: {
    width: 29, height: 29, display: 'grid', placeItems: 'center', padding: 0,
    color: C.fg2, background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer',
  },
  content: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  unavailable: { flex: 1, display: 'grid', placeItems: 'center', padding: 24, color: C.fg3, fontSize: 12 },
}
