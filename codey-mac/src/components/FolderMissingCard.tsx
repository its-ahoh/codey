import React, { useState } from 'react'
import type { ChatMessage } from '../types'
import { C } from '../theme'
import { apiService } from '../services/api'
import { retryPlan, type RetryPlan } from './agentSignIn'

/**
 * Stands in for the raw error when a turn failed because the workspace's
 * project folder is gone, most often renamed or moved in Finder. Choosing the
 * new location repoints the workspace and runs the failed message again.
 */
export const FolderMissingCard: React.FC<{
  workspaceName: string
  message: ChatMessage
  messages: ChatMessage[]
  busy: boolean
  /** Re-send a past user message through the normal retry route. */
  onRerun: (userMessageId: string) => void
  /** The workspace now points at `dir`. */
  onFolderChanged: (dir: string) => void
}> = ({ workspaceName, message, messages, busy, onRerun, onFolderChanged }) => {
  const missing = message.folderMissing!.workingDir
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [done, setDone] = useState<{ dir: string; plan: RetryPlan } | null>(null)
  const [showError, setShowError] = useState(false)

  const choose = async () => {
    setError(null)
    setPicking(true)
    try {
      const picked = await apiService.pickDirectory()
      if (!picked) return
      const dir = await apiService.setWorkspaceFolder(workspaceName, picked)
      onFolderChanged(dir)
      const plan = retryPlan(messages, message.id, { busy })
      // Only re-run on its own when nothing newer was sent: an old card must
      // not replay a message the user has since moved past.
      if (plan.kind === 'auto') { onRerun(plan.userMessageId); setDone({ dir, plan: { kind: 'none' } }) }
      else setDone({ dir, plan })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }

  return (
    <div role="group" aria-label="Project folder missing" style={styles.card}>
      {!done && (
        <>
          <span>
            The project folder <code style={styles.code}>{missing}</code> is gone.
            It may have been renamed, moved or deleted.
          </span>
          <div style={styles.row}>
            <button style={styles.primary} disabled={picking} onClick={() => { void choose() }}>Choose folder</button>
          </div>
          {error && <span style={styles.error}>{error}</span>}
        </>
      )}
      {done && (
        <div style={styles.row}>
          <span>
            Workspace now uses <code style={styles.code}>{done.dir}</code>.
            {done.plan.kind === 'none' && ' Running your message again…'}
          </span>
          {done.plan.kind === 'manual' && (
            <button
              style={styles.primary}
              disabled={busy}
              onClick={() => { if (done.plan.kind === 'manual') onRerun(done.plan.userMessageId); setDone({ ...done, plan: { kind: 'none' } }) }}
            >Run again</button>
          )}
        </div>
      )}
      <button style={styles.disclosure} aria-expanded={showError} onClick={() => setShowError(v => !v)}>
        {showError ? 'Hide error' : 'Show error'}
      </button>
      {showError && <pre style={styles.output}>{message.content}</pre>}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border2}`, background: C.surface2, color: C.fg2, fontSize: 13, margin: '4px 0' },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  code: { fontSize: 12, wordBreak: 'break-all' },
  primary: { padding: '4px 12px', borderRadius: 6, border: 'none', background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 13 },
  error: { fontSize: 12, color: C.dangerFg },
  disclosure: { alignSelf: 'flex-start', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontSize: 12, color: C.fg3 },
  output: { margin: 0, padding: 8, borderRadius: 6, fontSize: 12, background: C.surface3, color: C.fg2, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' },
}
