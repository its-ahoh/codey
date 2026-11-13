import React, { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../types'
import { C } from '../theme'
import { cancelSignIn, cardView, clearSignIn, retryPlan, startSignIn, useAgentSignIn, type RetryPlan } from './agentSignIn'

const LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export const AgentSignInCard: React.FC<{
  chatId: string
  /** Working directory of the chat, for "Take over in Terminal". */
  cwd?: string
  message: ChatMessage
  messages: ChatMessage[]
  busy: boolean
  /** Re-send a past user message through the normal retry route. */
  onRerun: (userMessageId: string) => void
}> = ({ chatId, cwd, message, messages, busy, onRerun }) => {
  const agent = message.authRequired!.agent
  const name = LABEL[agent] ?? agent
  const progress = useAgentSignIn(agent)
  const view = cardView(progress)
  const [showError, setShowError] = useState(false)
  const [manual, setManual] = useState<RetryPlan | null>(null)
  // One re-run per card, even if the store publishes `succeeded` twice.
  const handled = useRef(false)
  // The user has sent something since: this turn is history, not a to-do.
  const index = messages.findIndex(m => m.id === message.id)
  const superseded = index >= 0 && messages.slice(index + 1).some(m => m.role === 'user')
  // Only the card that was on screen when the login was started re-runs on its
  // own: a card rendered later from history must not fire on an old success.
  const armed = useRef(false)

  useEffect(() => {
    if (view === 'running') armed.current = true
    if (view !== 'succeeded' || handled.current || superseded) return
    handled.current = true
    const plan = retryPlan(messages, message.id, { busy })
    // A card that was not on screen for the login (another chat waiting on the
    // same agent) offers a button instead of running by itself.
    if (plan.kind === 'auto' && armed.current) onRerun(plan.userMessageId)
    else setManual(plan.kind === 'auto' ? { kind: 'manual', userMessageId: plan.userMessageId } : plan)
  }, [view, messages, message.id, busy, onRerun, superseded])

  const signIn = () => { armed.current = true; clearSignIn(agent); startSignIn(agent) }
  const takeOver = () => { if (cwd) void window.codey.agents.loginInTerminal({ agent, chatId, cwd }) }

  return (
    <div role="group" aria-label={`${name} sign-in`} style={styles.card}>
      {superseded && <span>{name} was signed out.</span>}
      {!superseded && view === 'idle' && (
        <div style={styles.row}>
          <span>{name} is signed out.</span>
          <button style={styles.primary} onClick={signIn}>Sign in</button>
        </div>
      )}
      {!superseded && view === 'running' && (
        <div style={styles.row}>
          <span>Waiting for sign-in in your browser…</span>
          {progress?.url && <a href={progress.url} target="_blank" rel="noreferrer" style={styles.link}>Open page</a>}
          {cwd && <button style={styles.secondary} onClick={takeOver}>Take over in Terminal</button>}
          <button style={styles.secondary} onClick={() => cancelSignIn(agent)}>Cancel</button>
        </div>
      )}
      {!superseded && view === 'succeeded' && (
        <div style={styles.row}>
          <span>{manual ? 'Signed in.' : 'Signed in. Running your message again…'}</span>
          {manual?.kind === 'manual' && (
            <button style={styles.primary} disabled={busy} onClick={() => { onRerun(manual.userMessageId); setManual({ kind: 'none' }) }}>Run again</button>
          )}
        </div>
      )}
      {!superseded && view === 'failed' && (
        <div>
          <div style={styles.row}>
            <span>Sign-in did not finish{progress?.command ? ` (${progress.command})` : ''}.</span>
            <button style={styles.primary} onClick={signIn}>Try again</button>
          </div>
          {progress?.output && <pre style={styles.output}>{progress.output}</pre>}
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
  primary: { padding: '4px 12px', borderRadius: 6, border: 'none', background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 13 },
  secondary: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${C.border2}`, background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 13 },
  link: { fontSize: 13, color: C.accent },
  disclosure: { alignSelf: 'flex-start', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontSize: 12, color: C.fg3 },
  output: { margin: 0, padding: 8, borderRadius: 6, fontSize: 12, background: C.surface3, color: C.fg2, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' },
}
