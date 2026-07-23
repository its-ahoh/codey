// Draft-first automation composer: assistant chat and deterministic form
// controls edit the same server-owned authoring session.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap, inputStyle, selectStyle } from './settingsAtoms'
import { Markdown } from './Markdown'
import {
  checkLabel, draftComplete, formatHHMM, NOTIFY_OPTIONS, scheduleSummary,
  slotsToSchedule, type NotifyMode, type ScheduleSlotInput,
} from './automationsModel'
import type { AutomationDraft } from '../../../packages/core/src/aide-automation'
import type { AutomationSchedule } from '../../../packages/core/src/types/automation'
import type { ChatStep } from '../../../packages/gateway/src/automations/chat'

interface Props {
  mode: 'create' | 'edit'
  automationId?: string
  onDone: () => void
  setError: (e: string | null) => void
}

interface Bubble { role: 'user' | 'assistant'; text: string }
type ComposerContext = ChatStep['context']
const DAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

const SendIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" />
  </svg>
)

export const AutomationChatCreate: React.FC<Props> = ({ mode, automationId, onDone, setError }) => {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const [messages, setMessages] = useState<Bubble[]>([])
  const [draft, setDraft] = useState<AutomationDraft>({})
  const [context, setContext] = useState<ComposerContext>({ workspaces: [], teams: [], agents: [], models: [], tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const [check, setCheck] = useState<ChatStep['check']>(undefined)
  const [checkDetail, setCheckDetail] = useState<string | undefined>()
  const [chatBusy, setChatBusy] = useState(false)
  const [formBusy, setFormBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failedText, setFailedText] = useState<string | null>(null)
  const [sessionLost, setSessionLost] = useState(false)
  const [input, setInput] = useState('')
  const [newParam, setNewParam] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // A check event can beat the request response that triggered it. A resolved
  // verdict wins over a stale pending response; callers clear first when they
  // intentionally re-arm a check.
  const applyCheck = (incoming: ChatStep['check']) =>
    setCheck(prev => incoming === 'pending' && prev !== undefined && prev !== 'pending' ? prev : incoming)

  const applyStep = (step: ChatStep, appendReply = false) => {
    setDraft(step.draft)
    setContext(step.context)
    setSuggestions(step.suggestions)
    setReady(step.ready)
    applyCheck(step.check)
    if (appendReply && step.reply) setMessages(prev => [...prev, { role: 'assistant', text: step.reply }])
  }

  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => () => {
    mountedRef.current = false
    const sid = sessionIdRef.current
    if (sid) void window.codey.automations.chatCancel(sid).catch(() => {})
  }, [])

  const begin = useCallback(async () => {
    const step: ChatStep = unwrap(await window.codey.automations.chatStart(mode, automationId))
    if (!mountedRef.current) {
      void window.codey.automations.chatCancel(step.sessionId).catch(() => {})
      return
    }
    setSessionId(step.sessionId)
    setMessages([{ role: 'assistant', text: step.reply }])
    setSessionLost(false)
    setCheckDetail(undefined)
    applyStep(step)
  }, [mode, automationId])

  useEffect(() => {
    let cancelled = false
    void begin().catch((e: any) => { if (!cancelled) setError(e?.message ?? String(e)) })
    return () => { cancelled = true }
  }, [begin, setError])

  useEffect(() => {
    if (!sessionId) return
    return window.codey.automations.onEvent(ev => {
      if (ev.type !== 'chat-check' || ev.sessionId !== sessionId) return
      applyCheck(ev.check)
      setCheckDetail(ev.detail)
      if (ev.message) setMessages(ms => [...ms, { role: 'assistant', text: ev.message! }])
    })
  }, [sessionId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, chatBusy])

  const send = useCallback(async (text: string, retry = false) => {
    const sid = sessionIdRef.current
    const trimmed = text.trim()
    if (!sid || !trimmed || chatBusy || formBusy) return
    setChatBusy(true)
    setFailedText(null)
    setSuggestions([])
    setCheck(undefined)
    if (!retry) setMessages(prev => [...prev, { role: 'user', text: trimmed }])
    try {
      const step: ChatStep = unwrap(await window.codey.automations.chatSend(sid, trimmed))
      applyStep(step, true)
    } catch (e: any) {
      if (/Unknown automation chat session/.test(e?.message ?? '')) {
        setSessionLost(true)
        setInput(trimmed)
      } else {
        setFailedText(trimmed)
      }
    } finally {
      setChatBusy(false)
    }
  }, [chatBusy, formBusy])

  const patchDraft = async (patch: Partial<AutomationDraft>) => {
    const sid = sessionIdRef.current
    if (!sid || formBusy || chatBusy) return
    setFormBusy(true)
    setCheck(undefined)
    try {
      const step: ChatStep = unwrap(await window.codey.automations.chatPatch(sid, patch as any))
      applyStep(step)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setFormBusy(false)
    }
  }

  const submit = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    void send(text)
  }

  const save = async (allowUnchecked = false) => {
    const sid = sessionIdRef.current
    if (!sid || saving) return
    if (allowUnchecked && !confirm('The unattended check failed. Save this automation anyway?')) return
    setSaving(true)
    setCheck(undefined)
    try {
      // Flush the visible form before finalizing. Text fields intentionally
      // keep local state while typing, so relying only on blur can otherwise
      // race a click on Save and persist the previous value.
      const synced: ChatStep = unwrap(await window.codey.automations.chatPatch(sid, {
        name: (draft.name?.trim() || null) as any,
        target: (draft.target ?? null) as any,
        schedule: (draft.schedule ?? null) as any,
        notify: draft.notify ?? 'none',
        brief: (draft.brief?.trim() || null) as any,
        params: draft.params ?? {},
      }))
      applyStep(synced)
      if (synced.check === 'pending') {
        // Execution-relevant form edits need the same unattended verification
        // as chat edits. The check event will re-enable Save when it finishes.
        setSaving(false)
        return
      }
      unwrap(await window.codey.automations.chatSave(sid, allowUnchecked))
      sessionIdRef.current = null
      onDone()
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setSaving(false)
    }
  }

  const retryCheck = async () => {
    const sid = sessionIdRef.current
    if (!sid) return
    setCheck(undefined)
    try {
      const step: ChatStep = unwrap(await window.codey.automations.chatRetryCheck(sid))
      applyStep(step)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const setTargetKind = (kind: 'prompt' | 'team') => {
    const workspaceName = draft.target?.workspaceName || context.workspaces[0] || ''
    const target = kind === 'team'
      ? { kind, workspaceName, teamName: context.teams[0] || '' } as const
      : { kind, workspaceName } as const
    void patchDraft({ target })
  }

  const setWorkspace = (workspaceName: string) => {
    const target = draft.target?.kind === 'team'
      ? { ...draft.target, workspaceName }
      : { kind: 'prompt' as const, ...draft.target, workspaceName }
    void patchDraft({ target })
  }

  const setSchedule = (schedule?: AutomationSchedule) =>
    void patchDraft({ schedule: (schedule ?? null) as any })

  const scheduleSlots: ScheduleSlotInput[] = draft.schedule?.slots.map(slot => ({
    time: formatHHMM(slot.hour, slot.minute),
    days: [...(slot.daysOfWeek ?? [])],
  })) ?? [{ time: '09:00', days: [] }]
  const rebuildSchedule = (slots: ScheduleSlotInput[]) => {
    const next = slotsToSchedule(slots, draft.schedule?.tz ?? context.tz)
    if (next) setSchedule(next)
  }

  const addParam = () => {
    const key = newParam.trim()
    if (!key || Object.prototype.hasOwnProperty.call(draft.params ?? {}, key)) return
    setNewParam('')
    void patchDraft({ params: { ...(draft.params ?? {}), [key]: '' } })
  }

  const missing = [
    !draft.name?.trim() && 'name',
    !draft.target?.workspaceName?.trim() && 'workspace',
    draft.target?.kind === 'team' && !draft.target.teamName?.trim() && 'team',
    !draft.brief?.trim() && 'instructions',
  ].filter(Boolean) as string[]
  const checkInfo = checkLabel(check)
  const locked = chatBusy || formBusy || saving || sessionLost

  return (
    <div style={shellStyle}>
      <section style={chatColumn}>
        <div style={columnHeader}>
          <div>
            <div style={eyebrow}>AI ASSISTANT</div>
            <div style={columnTitle}>{mode === 'edit' ? 'Optional editing assistant' : 'Describe the outcome'}</div>
          </div>
          <span style={helperText}>{mode === 'edit' ? 'Edit the form directly, or ask for a specific change.' : 'Chat fills the setup; every field remains editable.'}</span>
        </div>
        <div ref={scrollRef} style={chatScroll}>
          {messages.map((message, index) => message.role === 'user'
            ? <div key={index} style={bubbleUser}>{message.text}</div>
            : <div key={index} style={{ ...bubbleAssistant, whiteSpace: 'normal' }}><Markdown>{message.text}</Markdown></div>)}
          {chatBusy && <div style={{ ...bubbleAssistant, color: C.fg3, fontStyle: 'italic' }}>Refining the automation…</div>}
          {failedText && (
            <div style={{ ...bubbleAssistant, borderColor: C.red, color: C.red }}>
              That message did not go through. <button style={inlineButton} onClick={() => void send(failedText, true)}>Retry</button>
            </div>
          )}
          {sessionLost && (
            <div style={{ ...bubbleAssistant, borderColor: C.red, color: C.red }}>
              This draft session expired. <button style={inlineButton} onClick={() => void begin()}>Start a new draft</button>
            </div>
          )}
          {!chatBusy && !failedText && suggestions.length > 0 && (
            <div style={suggestionRow}>{suggestions.map(s => <button key={s} style={pillButton('ghost')} onClick={() => void send(s)}>{s}</button>)}</div>
          )}
        </div>
        <div style={composerBar}>
          <textarea
            autoFocus value={input} disabled={!sessionId || locked}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            placeholder="Describe a workflow, or ask the assistant to refine the current setup…"
            style={composerInput}
          />
          <button style={{ ...sendButton, background: input.trim() && !locked ? C.accent : C.surface3 }} disabled={!input.trim() || locked} onClick={submit}>
            <SendIcon color={input.trim() && !locked ? C.onAccent : C.fg3} />
          </button>
        </div>
      </section>

      <section style={setupColumn}>
        <div style={setupScroll}>
          <div style={setupHeading}>
            <div>
              <div style={eyebrow}>{mode === 'edit' ? 'EDIT AUTOMATION' : 'NEW AUTOMATION'}</div>
              <div style={{ ...columnTitle, fontSize: 18 }}>{draft.name?.trim() || 'Untitled automation'}</div>
            </div>
            {draft.schedule && <span style={summaryPill}>{scheduleSummary(draft.schedule)}</span>}
          </div>

          <SetupSection title="Basics" description="A clear name and the workspace where this runs.">
            <Field label="Name" required>
              <input
                value={draft.name ?? ''} disabled={locked} style={wideInput}
                placeholder="Weekly release notes"
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                onBlur={e => void patchDraft({ name: (e.target.value.trim() || null) as any })}
              />
            </Field>
            <div style={twoColumns}>
              <Field label="Run as" required>
                <select value={draft.target?.kind ?? 'prompt'} disabled={locked} style={wideSelect} onChange={e => setTargetKind(e.target.value as 'prompt' | 'team')}>
                  <option value="prompt">Single agent</option>
                  <option value="team" disabled={context.teams.length === 0}>Worker team</option>
                </select>
              </Field>
              <Field label="Workspace" required>
                <select value={draft.target?.workspaceName ?? ''} disabled={locked} style={wideSelect} onChange={e => setWorkspace(e.target.value)}>
                  <option value="" disabled>Select workspace</option>
                  {context.workspaces.map(w => <option key={w} value={w}>{w}</option>)}
                </select>
              </Field>
            </div>
            {draft.target?.kind === 'team' && (
              <Field label="Team" required>
                <select value={draft.target.teamName} disabled={locked} style={wideSelect}
                  onChange={e => void patchDraft({ target: { ...draft.target!, teamName: e.target.value } as any })}>
                  <option value="" disabled>Select team</option>
                  {context.teams.map(team => <option key={team} value={team}>{team}</option>)}
                </select>
              </Field>
            )}
            {draft.target?.kind === 'prompt' && (
              <div style={twoColumns}>
                <Field label="Agent override">
                  <select value={draft.target.agent ?? ''} disabled={locked} style={wideSelect}
                    onChange={e => void patchDraft({ target: { ...draft.target!, agent: (e.target.value || undefined) as any } as any })}>
                    <option value="">Gateway default</option>
                    {(context.agents ?? []).map(agent => <option key={agent} value={agent}>{agent}</option>)}
                  </select>
                </Field>
                <Field label="Model override">
                  <select value={draft.target.model ?? ''} disabled={locked} style={wideSelect}
                    onChange={e => void patchDraft({ target: { ...draft.target!, model: e.target.value || undefined } as any })}>
                    <option value="">Agent default</option>
                    {(context.models ?? []).map(model => <option key={model} value={model}>{model}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </SetupSection>

          <SetupSection title="Instructions" description="The exact brief used for every unattended run.">
            <textarea
              value={draft.brief ?? ''} disabled={locked} style={briefInput}
              placeholder="The assistant will synthesize a self-contained run brief here. You can edit it directly."
              onChange={e => setDraft(d => ({ ...d, brief: e.target.value }))}
              onBlur={e => void patchDraft({ brief: (e.target.value.trim() || null) as any })}
            />
          </SetupSection>

          <SetupSection title="Variables" description="Values you expect to tune without rewriting the instructions.">
            {Object.entries(draft.params ?? {}).length === 0 && <div style={emptyHint}>No variables yet. The assistant adds them when useful.</div>}
            {Object.entries(draft.params ?? {}).map(([key, value]) => (
              <div key={key} style={paramRow}>
                <code style={paramKey}>{key}</code>
                <input value={value} disabled={locked} style={{ ...wideInput, flex: 1 }}
                  onChange={e => setDraft(d => ({ ...d, params: { ...(d.params ?? {}), [key]: e.target.value } }))}
                  onBlur={e => void patchDraft({ params: { ...(draft.params ?? {}), [key]: e.target.value } })} />
                <button title="Remove variable" style={removeButton} disabled={locked} onClick={() => {
                  const params = { ...(draft.params ?? {}) }; delete params[key]; void patchDraft({ params })
                }}>×</button>
              </div>
            ))}
            <div style={paramAddRow}>
              <input value={newParam} disabled={locked} style={{ ...wideInput, flex: 1 }} placeholder="New variable name"
                onChange={e => setNewParam(e.target.value.replace(/[^\w.-]/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter') addParam() }} />
              <button style={pillButton('ghost')} disabled={!newParam.trim() || locked} onClick={addParam}>Add</button>
            </div>
          </SetupSection>

          <SetupSection title="Schedule & alerts" description={`Times use ${draft.schedule?.tz ?? context.tz}. Leave scheduling off to run manually.`}>
            <Field label="Scheduled">
              <label style={toggleLabel}>
                <input type="checkbox" checked={!!draft.schedule} disabled={locked}
                  onChange={e => e.target.checked
                    ? setSchedule({ slots: [{ hour: 9, minute: 0 }], tz: context.tz })
                    : setSchedule(undefined)} />
                <span>{draft.schedule ? 'On' : 'Manual only'}</span>
              </label>
            </Field>
            {draft.schedule && (
              <>
                <Field label="Time slots">
                  <div style={slotList}>
                    {scheduleSlots.map((slot, slotIndex) => (
                      <div key={slotIndex} style={slotCard}>
                        <div style={slotTopRow}>
                          <input type="time" value={slot.time} disabled={locked} style={compactInput}
                            aria-label={`Time slot ${slotIndex + 1}`}
                            onChange={e => rebuildSchedule(scheduleSlots.map((item, index) => index === slotIndex ? { ...item, time: e.target.value } : item))} />
                          <span style={slotDaySummary}>{slot.days.length ? `${slot.days.length} selected days` : 'Every day'}</span>
                          {scheduleSlots.length > 1 && <button title="Remove time slot" style={removeButton}
                            onClick={() => rebuildSchedule(scheduleSlots.filter((_, index) => index !== slotIndex))}>×</button>}
                        </div>
                        <div style={dayRow}>{DAY.map((day, dayIndex) => {
                          const selected = slot.days.length === 0 || slot.days.includes(dayIndex)
                          return <button key={dayIndex} title={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayIndex]}
                            style={dayButton(selected)} disabled={locked} onClick={() => {
                              const current = slot.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : slot.days
                              const days = current.includes(dayIndex) ? current.filter(d => d !== dayIndex) : [...current, dayIndex].sort()
                              rebuildSchedule(scheduleSlots.map((item, index) => index === slotIndex
                                ? { ...item, days: days.length === 7 ? [] : days }
                                : item))
                            }}>{day}</button>
                        })}</div>
                      </div>
                    ))}
                    <button style={addSlotButton} disabled={locked}
                      onClick={() => rebuildSchedule([...scheduleSlots, { time: '12:00', days: [] }])}>+ Add another time slot</button>
                  </div>
                </Field>
              </>
            )}
            <Field label="Notify">
              <select value={draft.notify ?? 'none'} disabled={locked} style={wideSelect}
                onChange={e => void patchDraft({ notify: e.target.value as NotifyMode })}>
                {NOTIFY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
          </SetupSection>
        </div>

        <footer style={footerStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {missing.length > 0 ? (
              <div style={statusMuted}>Complete: {missing.join(', ')}</div>
            ) : checkInfo ? (
              <div style={{ color: checkInfo.tone === 'good' ? C.green : checkInfo.tone === 'warn' ? C.yellow : C.fg3, fontSize: 12 }}>
                {checkInfo.text}
                {check === 'gaps' && ' — answer the assistant’s questions'}
                {check === 'error' && <button style={inlineButton} title={checkDetail} onClick={() => void retryCheck()}>Retry</button>}
              </div>
            ) : (
              <div style={statusMuted}>Ready for unattended check</div>
            )}
          </div>
          {ready && draftComplete(draft) && check === 'clean' && (
            <button style={pillButton('primary')} disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create automation'}</button>
          )}
          {ready && draftComplete(draft) && check === 'pending' && <button style={pillButton('primary')} disabled>Checking…</button>}
          {ready && draftComplete(draft) && check === 'error' && (
            <button style={pillButton('ghost')} disabled={saving} onClick={() => void save(true)}>Save anyway…</button>
          )}
        </footer>
      </section>
    </div>
  )
}

const SetupSection: React.FC<{ title: string; description: string; children: React.ReactNode }> = ({ title, description, children }) => (
  <div style={sectionCard}>
    <div style={{ marginBottom: 12 }}>
      <div style={sectionTitle}>{title}</div>
      <div style={sectionDescription}>{description}</div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
  </div>
)

const Field: React.FC<{ label: string; required?: boolean; children: React.ReactNode }> = ({ label, required, children }) => (
  <label style={fieldBlock}>
    <span style={fieldLabel}>{label}{required && <span style={{ color: C.accent }}> *</span>}</span>
    {children}
  </label>
)

const shellStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(320px, 0.9fr) minmax(430px, 1.1fr)', flex: 1, minHeight: 0, background: C.bg }
const chatColumn: React.CSSProperties = { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border}`, background: C.surface }
const setupColumn: React.CSSProperties = { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
const columnHeader: React.CSSProperties = { padding: '18px 20px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-end' }
const eyebrow: React.CSSProperties = { color: C.accent, fontSize: 9, fontWeight: 800, letterSpacing: 1.1, marginBottom: 4 }
const columnTitle: React.CSSProperties = { color: C.fg, fontSize: 14, fontWeight: 720, letterSpacing: '-0.01em' }
const helperText: React.CSSProperties = { color: C.fg3, fontSize: 10, lineHeight: 1.4, maxWidth: 180, textAlign: 'right' }
const chatScroll: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 9 }
const bubbleBase: React.CSSProperties = { maxWidth: '86%', padding: '9px 12px', borderRadius: 12, fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const bubbleAssistant: React.CSSProperties = { ...bubbleBase, alignSelf: 'flex-start', background: C.bg, border: `1px solid ${C.border}`, borderBottomLeftRadius: 4, color: C.fg }
const bubbleUser: React.CSSProperties = { ...bubbleBase, alignSelf: 'flex-end', background: C.surface3, borderBottomRightRadius: 4, color: C.fg }
const suggestionRow: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }
const composerBar: React.CSSProperties = { display: 'flex', gap: 8, padding: '12px 14px', borderTop: `1px solid ${C.border}`, alignItems: 'flex-end' }
const composerInput: React.CSSProperties = { ...inputStyle, flex: 1, width: 'auto', resize: 'none', minHeight: 40, maxHeight: 100, lineHeight: 1.45, fontFamily: 'inherit' }
const sendButton: React.CSSProperties = { width: 40, height: 40, borderRadius: 10, border: 'none', display: 'grid', placeItems: 'center', flexShrink: 0 }
const setupScroll: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '20px 22px 28px' }
const setupHeading: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', marginBottom: 16 }
const summaryPill: React.CSSProperties = { padding: '5px 9px', borderRadius: 999, background: C.accentDim, color: C.accent, fontSize: 10, fontWeight: 650 }
const sectionCard: React.CSSProperties = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 15px', marginBottom: 12 }
const sectionTitle: React.CSSProperties = { color: C.fg, fontSize: 12, fontWeight: 700 }
const sectionDescription: React.CSSProperties = { color: C.fg3, fontSize: 10.5, lineHeight: 1.4, marginTop: 2 }
const fieldBlock: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 }
const fieldLabel: React.CSSProperties = { color: C.fg2, fontSize: 10.5, fontWeight: 650 }
const wideInput: React.CSSProperties = { ...inputStyle, boxSizing: 'border-box', width: '100%' }
const wideSelect: React.CSSProperties = { ...selectStyle, boxSizing: 'border-box', width: '100%' }
const compactInput: React.CSSProperties = { ...inputStyle, width: 104, padding: '6px 8px' }
const briefInput: React.CSSProperties = { ...wideInput, minHeight: 128, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }
const twoColumns: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }
const emptyHint: React.CSSProperties = { color: C.fg3, fontSize: 11, fontStyle: 'italic' }
const paramRow: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'center' }
const paramKey: React.CSSProperties = { color: C.accent, fontSize: 10.5, width: 92, overflow: 'hidden', textOverflow: 'ellipsis' }
const paramAddRow: React.CSSProperties = { display: 'flex', gap: 7 }
const removeButton: React.CSSProperties = { width: 27, height: 27, borderRadius: 7, border: `1px solid ${C.border}`, background: 'transparent', color: C.fg3, cursor: 'pointer' }
const toggleLabel: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'center', color: C.fg2, fontSize: 12 }
const slotList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const slotCard: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 11px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2 }
const slotTopRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
const slotDaySummary: React.CSSProperties = { color: C.fg3, fontSize: 10, flex: 1 }
const addSlotButton: React.CSSProperties = { ...pillButton('ghost'), alignSelf: 'flex-start', padding: '6px 10px' }
const dayRow: React.CSSProperties = { display: 'flex', gap: 5 }
const dayButton = (selected: boolean): React.CSSProperties => ({ width: 29, height: 29, borderRadius: 8, border: `1px solid ${selected ? C.accent : C.border2}`, background: selected ? C.accentDim : C.surface3, color: selected ? C.accent : C.fg3, cursor: 'pointer', fontSize: 10, fontWeight: 700 })
const footerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderTop: `1px solid ${C.border}`, background: C.surface }
const statusMuted: React.CSSProperties = { color: C.fg3, fontSize: 11 }
const inlineButton: React.CSSProperties = { border: 'none', background: 'transparent', color: C.accent, cursor: 'pointer', fontSize: 'inherit', padding: '0 4px', textDecoration: 'underline' }
