import React from 'react'
import { C } from '../theme'
import { highlightedLine, languageForFilePath } from './toolFormat'

/** Lines rendered before the view asks whether to show the rest. */
const INITIAL_LINES = 2000

/**
 * A whole file, numbered and syntax-highlighted, for files the agent read or
 * touched without leaving a diff behind. Big files are shown in a first slice
 * with a button for the rest, so opening a generated bundle stays responsive.
 */
export const FileCodeView: React.FC<{ content: string; filePath: string }> = ({ content, filePath }) => {
  const [showAll, setShowAll] = React.useState(false)
  const language = languageForFilePath(filePath)
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  const shown = showAll ? lines : lines.slice(0, INITIAL_LINES)
  const hidden = lines.length - shown.length
  const gutterWidth = Math.max(30, String(lines.length).length * 8 + 12)

  return (
    <div style={styles.wrap}>
      <div style={styles.inner}>
        {shown.map((text, i) => {
          const html = highlightedLine(text, language)
          return (
            <div key={i} style={styles.row}>
              <span style={{ ...styles.gutter, minWidth: gutterWidth }}>{i + 1}</span>
              {html
                ? <span style={styles.code} dangerouslySetInnerHTML={{ __html: html }} />
                : <span style={styles.code}>{text || ' '}</span>}
            </div>
          )
        })}
        {hidden > 0 && (
          <button style={styles.moreButton} onClick={() => setShowAll(true)}>
            <span style={styles.moreLabel}>↓ Show {hidden} more line{hidden === 1 ? '' : 's'}</span>
          </button>
        )}
        {lines.length === 0 && <div style={styles.empty}>Empty file.</div>}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    fontFamily: 'Menlo, Monaco, "Courier New", monospace', fontSize: 11.5, lineHeight: 1.55,
    borderRadius: 6, overflowX: 'auto', border: `1px solid ${C.border2}`, background: C.surface,
  },
  inner: { display: 'flex', flexDirection: 'column', width: 'max-content', minWidth: '100%' },
  row: { display: 'flex', whiteSpace: 'pre', width: '100%', minWidth: 'max-content' },
  gutter: {
    flexShrink: 0, textAlign: 'right', padding: '0 8px 0 6px',
    color: C.fg2, opacity: 0.8, userSelect: 'none', WebkitUserSelect: 'none',
  },
  code: { flexShrink: 0, paddingRight: 14, color: C.fg },
  moreButton: {
    display: 'block', width: '100%', minWidth: '100%', padding: '5px 10px', boxSizing: 'border-box',
    border: 'none', borderTop: `1px solid ${C.border}`,
    background: C.surface2, color: C.accent, cursor: 'pointer',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 10.5, fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap',
  },
  moreLabel: { position: 'sticky', left: 0, zIndex: 2, display: 'inline-block' },
  empty: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '8px 10px' },
}
