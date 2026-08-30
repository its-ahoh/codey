import React from 'react'
import { C } from '../theme'
import { opensInSystemApp } from './filePathRef'

/**
 * Working dir that message-relative paths are resolved against. Chat provides
 * it; other Markdown surfaces leave it undefined, where only absolute and `~`
 * paths become links.
 */
export const FilePathCwd = React.createContext<string | null>(null)

/** Editor preference shared with the chat toolbar's "Open in" button. */
const PREFERRED_KEY = 'codey.preferredEditor'

type Located = { absPath: string | null; exists: boolean; isDirectory: boolean }

/** One lookup per (cwd, path) for the life of the window: a long chat repeats
 *  the same path dozens of times, and re-rendering must not re-stat it. */
const locateCache = new Map<string, Promise<Located | null>>()

function locate(path: string, cwd: string | null): Promise<Located | null> {
  const key = `${cwd ?? ''}\u0000${path}`
  const cached = locateCache.get(key)
  if (cached) return cached
  const pending = (window.codey?.fileRef?.locate?.(path, cwd) ?? Promise.resolve(null))
    .then((res: any) => (res && res.ok ? res.data as Located : null))
    .catch(() => null)
  locateCache.set(key, pending)
  return pending
}

async function preferredEditorId(): Promise<string | undefined> {
  const saved = localStorage.getItem(PREFERRED_KEY) ?? ''
  const res = await window.codey.editors.list()
  const editors = res.ok ? res.data : []
  const installed = editors.filter(editor => editor.installed)
  return installed.find(editor => editor.id === saved)?.id ?? installed[0]?.id
}

interface FilePathLinkProps {
  /** The path exactly as written in the message. */
  path: string
  /** Line number, when the message wrote one; passed through for the tooltip. */
  line?: number
  /** Rendered as-is until the path is confirmed to exist. */
  children: React.ReactNode
  style: React.CSSProperties
  linkColor: string
}

/**
 * An inline-code span that turned out to be a real path: click opens it (in
 * the preferred editor for a file, in Finder for a directory), ⌘/⇧-click
 * reveals it in Finder. A path that does not exist stays plain text, so a
 * backticked command or MIME type never grows a dead link.
 */
export const FilePathLink: React.FC<FilePathLinkProps> = ({ path, line, children, style, linkColor }) => {
  const cwd = React.useContext(FilePathCwd)
  const [located, setLocated] = React.useState<Located | null>(null)
  const [hover, setHover] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    void locate(path, cwd).then(res => { if (alive) setLocated(res) })
    return () => { alive = false }
  }, [path, cwd])

  const live = located?.exists === true
  if (!live) return <code style={style}>{children}</code>

  const open = async (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const reveal = event.metaKey || event.shiftKey
    // A directory, a PDF, an image or an archive belongs to the OS; only text
    // goes to the editor. Passing no editorId makes the main process fall back
    // to `shell.openPath`, which is exactly the macOS double-click behaviour.
    const editorId = reveal || located?.isDirectory || opensInSystemApp(path)
      ? undefined
      : await preferredEditorId()
    const res = await window.codey.fileRef.open(path, cwd, { editorId, reveal })
    if (!res.ok) alert(`Couldn't open ${path}: ${res.error}`)
  }

  const what = located?.isDirectory
    ? 'folder in Finder'
    : opensInSystemApp(path)
      ? 'file in its default app'
      : 'file in your editor'
  return (
    <code
      role="link"
      tabIndex={0}
      onClick={event => { void open(event) }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        void open(event as unknown as React.MouseEvent)
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Click to open the ${what}${line ? ` (line ${line})` : ''} · ⌘-click to reveal in Finder\n${located?.absPath ?? path}`}
      style={{
        ...style,
        color: linkColor,
        cursor: 'pointer',
        textDecoration: hover ? 'underline' : 'none',
        textUnderlineOffset: 2,
        boxShadow: hover ? `inset 0 0 0 1px ${C.border2}` : 'none',
      }}
    >
      {children}
    </code>
  )
}
