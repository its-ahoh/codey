import React from 'react'
import { C } from '../theme'

/**
 * What an agent CLI said when its update failed.
 *
 * This is a modal rather than a line in the settings row because the useful
 * part is the updater's own output — a stack of shell text nobody can read in
 * the 11px gap under a row, and the one thing that tells the user whether they
 * need sudo, a login, or a different install method.
 */
export const AgentUpdateFailureModal: React.FC<{
  agent: string
  command: string
  output: string
  onClose: () => void
}> = ({ agent, command, output, onClose }) => (
  <div style={styles.backdrop} onClick={onClose}>
    <div style={styles.card} onClick={e => e.stopPropagation()} role="dialog" aria-label={`${agent} update failed`}>
      <div style={styles.head}>Couldn&rsquo;t update {agent}</div>
      <div style={styles.sub}>
        Codey ran <code style={styles.code}>{command}</code> in your login shell. It reported:
      </div>
      <pre style={styles.output}>{output || 'The updater exited with an error but printed nothing.'}</pre>
      <div style={styles.row}>
        <button style={styles.primary} onClick={onClose}>Close</button>
      </div>
    </div>
  </div>
)

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  card: {
    width: 520, maxWidth: '100%', background: C.surface2, border: `1px solid ${C.border}`,
    borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
  },
  head: { fontSize: 14, fontWeight: 600, color: C.red },
  sub: { fontSize: 12, color: C.fg3, lineHeight: 1.5 },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: C.fg2 },
  output: {
    margin: 0, padding: 12, background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 8,
    color: C.fg2, fontSize: 11, lineHeight: 1.55, maxHeight: 320, overflow: 'auto',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  row: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  primary: {
    background: C.accent, color: C.onAccent, border: 'none', borderRadius: 7,
    padding: '7px 14px', fontSize: 13, cursor: 'pointer',
  },
}
