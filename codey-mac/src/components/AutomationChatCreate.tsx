// codey-mac/src/components/AutomationChatCreate.tsx
// Chat-driven automation authoring: chat column + live summary panel.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap, inputStyle } from './settingsAtoms'
import { scheduleSummary, draftComplete } from './automationsModel'
import type { AutomationDraft } from '../../../packages/core/src/aide-automation'
import type { ChatStep } from '../../../packages/gateway/src/automations/chat'

interface Props {
  mode: 'create' | 'edit'
  automationId?: string
  onDone: () => void
  onCancel: () => void
  setError: (e: string | null) => void
}

interface Bubble { role: 'user' | 'assistant'; text: string }

export const AutomationChatCreate: React.FC<Props> = ({ mode, automationId, onDone, onCancel, setError }) => {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [messages, setMessages] = useState<Bubble[]>([])
  const [draft, setDraft] = useState<AutomationDraft>({})
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failedText, setFailedText] = useState<string | null>(null)
  const [sessionLost, setSessionLost] = useState(false)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  // Cancel the server-side session when the view unmounts.
  useEffect(() => () => {
    mountedRef.current = false
    const sid = sessionIdRef.current
    if (sid) void window.codey.automations.chatCancel(sid).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const step: ChatStep = unwrap(await window.codey.automations.chatStart(mode, automationId))
        if (cancelled) { void window.codey.automations.chatCancel(step.sessionId).catch(() => {}); return }
        setSessionId(step.sessionId)
        setMessages([{ role: 'assistant', text: step.reply }])
        setDraft(step.draft)
        setSuggestions(step.suggestions)
        setReady(step.ready)
      } catch (e: any) {
        setError(e?.message ?? String(e))
      }
    })()
    return () => { cancelled = true }
  }, [mode, automationId, setError])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, busy])

  const send = useCallback(async (text: string, isRetry = false) => {
    const sid = sessionIdRef.current
    const trimmed = text.trim()
    if (!sid || !trimmed || busy) return
    setBusy(true)
    setFailedText(null)
    setSuggestions([])
    if (!isRetry) setMessages(prev => [...prev, { role: 'user', text: trimmed }])
    try {
      const step: ChatStep = unwrap(await window.codey.automations.chatSend(sid, trimmed))
      setMessages(prev => [...prev, { role: 'assistant', text: step.reply }])
      setDraft(step.draft)
      setSuggestions(step.suggestions)
      setReady(step.ready)
    } catch (e: any) {
      // Unknown session = gateway restarted or the session hit its TTL —
      // only starting over helps. Anything else is retryable in place.
      if (/Unknown automation chat session/.test(e?.message ?? '')) {
        setSessionLost(true)
        setInput(trimmed) // keep the user's text for the restarted chat
      } else {
        setFailedText(trimmed)
      }
    } finally {
      setBusy(false)
    }
  }, [busy])

  const startOver = () => {
    // Remount-free restart: clear local state and re-run the start effect
    // by clearing the session; simplest is to reload via chatStart directly.
    setSessionLost(false)
    setMessages([])
    setDraft({})
    setSuggestions([])
    setReady(false)
    void (async () => {
      try {
        const step: ChatStep = unwrap(await window.codey.automations.chatStart(mode, automationId))
        if (!mountedRef.current) { void window.codey.automations.chatCancel(step.sessionId).catch(() => {}); return }
        setSessionId(step.sessionId)
        setMessages([{ role: 'assistant', text: step.reply }])
        setDraft(step.draft)
        setSuggestions(step.suggestions)
        setReady(step.ready)
      } catch (e: any) {
        setError(e?.message ?? String(e))
      }
    })()
  }

  const submit = () => {
    const t = input.trim()
    if (t) { setInput(''); void send(t) }
  }

  const save = async () => {
    if (!draftComplete(draft) || saving) return
    setSaving(true)
    try {
      const payload = {
        name: draft.name!.trim(),
        target: draft.target!,
        brief: draft.brief!,
        params: draft.params ?? {},
        schedule: draft.schedule ?? undefined,
        report: { notify: draft.notify ?? true },
      }
      if (mode === 'edit' && automationId) {
        unwrap(await window.codey.automations.update(automationId, payload as any))
      } else {
        unwrap(await window.codey.automations.create({ ...payload, enabled: true } as any))
      }
      onDone()
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setSaving(false)
    }
  }

  const targetText = draft.target
    ? draft.target.kind === 'team'
      ? `team ${draft.target.teamName} (${draft.target.workspaceName})`
      : `${draft.target.workspaceName} (prompt)`
    : undefined

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div ref={scrollRef} style={chatScroll}>
          {messages.map((m, i) => (
            <div key={i} style={m.role === 'user' ? bubbleUser : bubbleAssistant}>{m.text}</div>
          ))}
          {busy && <div style={{ ...bubbleAssistant, color: C.fg3, fontStyle: 'italic' }}>Thinking…</div>}
          {failedText !== null && (
            <div style={{ ...bubbleAssistant, border: `1px solid ${C.red}`, color: C.red }}>
              Something went wrong.{' '}
              <button style={pillButton('ghost')} onClick={() => void send(failedText, true)}>Retry</button>
            </div>
          )}
          {sessionLost && (
            <div style={{ ...bubbleAssistant, border: `1px solid ${C.red}`, color: C.red }}>
              This session expired.{' '}
              <button style={pillButton('ghost')} onClick={startOver}>Start over</button>
            </div>
          )}
          {!busy && failedText === null && suggestions.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.map(sug => (
                <button key={sug} style={pillButton('ghost')} onClick={() => void send(sug)}>{sug}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '10px 20px', borderTop: `1px solid ${C.border}` }}>
          <input
            autoFocus
            style={{ ...inputStyle, flex: 1, width: 'auto' }}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder={sessionId ? 'Message…' : 'Starting…'}
            disabled={!sessionId || busy}
          />
          <button style={pillButton('ghost')} onClick={onCancel}>Cancel</button>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ color: C.fg, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
            {draft.name ?? <span style={dim}>New automation</span>}
          </div>
          <SummaryRow label="Runs" value={draft.schedule ? scheduleSummary(draft.schedule) : ready ? 'manual' : undefined} placeholder="schedule…" />
          <SummaryRow label="Where" value={targetText} placeholder="workspace…" />
          <SummaryRow label="Notify" value={draft.notify === undefined ? undefined : draft.notify ? 'on' : 'off'} placeholder="notify…" />
          {draft.params && Object.keys(draft.params).length > 0 && (
            <SummaryRow
              label="Knobs"
              value={Object.entries(draft.params).map(([k, v]) => `${k}=${v}`).join(', ')}
              placeholder=""
            />
          )}
          <div style={{ marginTop: 12 }}>
            <div style={panelLabel}>Brief</div>
            {draft.brief ? (
              <>
                <pre style={{ ...briefBox, maxHeight: briefOpen ? undefined : 96, overflow: 'hidden' }}>{draft.brief}</pre>
                <button style={{ ...pillButton('ghost'), marginTop: 4 }} onClick={() => setBriefOpen(o => !o)}>
                  {briefOpen ? 'Collapse' : 'Expand'}
                </button>
              </>
            ) : (
              <span style={dim}>synthesized as you chat…</span>
            )}
          </div>
        </div>
        {ready && draftComplete(draft) && (
          <button style={{ ...pillButton('primary'), marginTop: 10 }} disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create automation'}
          </button>
        )}
      </div>
    </div>
  )
}

const SummaryRow: React.FC<{ label: string; value?: string; placeholder: string }> = ({ label, value, placeholder }) => (
  <div style={{ display: 'flex', gap: 8, fontSize: 12, margin: '3px 0' }}>
    <span style={{ color: C.fg3, width: 56, flexShrink: 0 }}>{label}</span>
    {value ? (
      <span style={{ color: C.fg2, wordBreak: 'break-word' }}>{value}</span>
    ) : (
      <span style={dim}>{placeholder}</span>
    )}
  </div>
)

const dim: React.CSSProperties = { color: C.fg3, opacity: 0.55, fontStyle: 'italic' }

const chatScroll: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: '16px 20px',
  display: 'flex', flexDirection: 'column', gap: 8,
}

const bubbleBase: React.CSSProperties = {
  maxWidth: '82%', padding: '8px 12px', borderRadius: 12,
  fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}

const bubbleAssistant: React.CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-start', background: C.surface,
  border: `1px solid ${C.border}`, borderBottomLeftRadius: 4, color: C.fg,
}

const bubbleUser: React.CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-end', background: C.surface3,
  borderBottomRightRadius: 4, color: C.fg,
}

const panelStyle: React.CSSProperties = {
  width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column',
  borderLeft: `1px solid ${C.border}`, padding: '16px 16px 12px',
  overflow: 'hidden',
}

const panelLabel: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4,
}

const briefBox: React.CSSProperties = {
  margin: 0, padding: '8px 10px', borderRadius: 8, background: C.surface3, color: C.fg2,
  fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
