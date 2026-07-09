import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap, inputStyle, selectStyle } from './settingsAtoms'
import { scheduleSummary, canSchedule, timeOfDayToSchedule } from './automationsModel'
import type { Automation, AutomationRun, AutomationTarget } from '../../../packages/core/src/types/automation'
import type { InterviewStep } from '../../../packages/gateway/src/automations/interview'

interface Props { onClose: () => void }

type Panel =
  | { kind: 'list' }
  | { kind: 'edit'; id: string | null }
  | { kind: 'history'; id: string }

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export const AutomationsView: React.FC<Props> = ({ onClose }) => {
  const [panel, setPanel] = useState<Panel>({ kind: 'list' })
  const [automations, setAutomations] = useState<Automation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setAutomations(unwrap(await window.codey.automations.list()))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Addition 1: the view is open and the user is looking at it — mark
  // finished/parked runs seen as their events arrive, so they don't
  // re-notify on next launch.
  useEffect(() => {
    const off = window.codey.automations.onEvent((ev) => {
      if (ev.type === 'run-finished' || ev.type === 'run-parked') {
        void window.codey.automations.markSeen(ev.automationId, ev.runId).catch(() => {})
      }
      void refresh()
    })
    return off
  }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && panel.kind === 'list') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, panel.kind])

  return (
    <div style={styles.backdrop} onClick={panel.kind === 'list' ? onClose : undefined}>
      <div style={styles.window} onClick={e => e.stopPropagation()}>
        <div style={styles.titleBar}>
          <button
            onClick={panel.kind === 'list' ? onClose : () => setPanel({ kind: 'list' })}
            style={styles.closeBtn}
            title={panel.kind === 'list' ? 'Close (Esc)' : 'Back'}
            aria-label={panel.kind === 'list' ? 'Close' : 'Back'}
          >
            <span style={styles.closeDot} />
          </button>
          <div style={styles.titleText}>Automations</div>
          <div style={{ width: 60 }} />
        </div>
        <div style={styles.body}>
          {error && <div style={styles.errorBanner}>{error}</div>}
          {panel.kind === 'list' && (
            <AutomationList
              automations={automations}
              loading={loading}
              onRefresh={refresh}
              onNew={() => setPanel({ kind: 'edit', id: null })}
              onEdit={(id) => setPanel({ kind: 'edit', id })}
              onHistory={(id) => setPanel({ kind: 'history', id })}
              setError={setError}
            />
          )}
          {panel.kind === 'edit' && (
            <AutomationEditor
              key={panel.id ?? 'new'}
              id={panel.id}
              automation={panel.id ? automations.find(a => a.id === panel.id) ?? null : null}
              onDone={() => { setPanel({ kind: 'list' }); void refresh() }}
              onCancel={() => setPanel({ kind: 'list' })}
              setError={setError}
            />
          )}
          {panel.kind === 'history' && (
            <RunHistory key={panel.id} id={panel.id} setError={setError} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface ListProps {
  automations: Automation[]
  loading: boolean
  onRefresh: () => void
  onNew: () => void
  onEdit: (id: string) => void
  onHistory: (id: string) => void
  setError: (e: string | null) => void
}

const AutomationList: React.FC<ListProps> = ({ automations, loading, onRefresh, onNew, onEdit, onHistory, setError }) => {
  const [lastStatus, setLastStatus] = useState<Record<string, AutomationRun | undefined>>({})
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(automations.map(async a => {
        try {
          const runs = unwrap(await window.codey.automations.history(a.id, 1))
          const last = runs[0]
          // Displaying the last-run status in the list counts as seeing it:
          // mark it seen (from the fresh data just fetched) so the launch
          // scan doesn't re-notify / re-badge list-viewed runs on every
          // subsequent app start.
          if (last && last.endedAt && !last.seenAt) {
            void window.codey.automations.markSeen(a.id, last.runId).catch(() => {})
          }
          return [a.id, last] as const
        } catch {
          return [a.id, undefined] as const
        }
      }))
      if (!cancelled) setLastStatus(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
  }, [automations])

  const toggle = async (a: Automation) => {
    try {
      await window.codey.automations.setEnabled(a.id, !a.enabled)
      onRefresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const runNow = async (id: string) => {
    setRunningIds(prev => ({ ...prev, [id]: true }))
    try {
      unwrap(await window.codey.automations.runNow(id))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setRunningIds(prev => ({ ...prev, [id]: false }))
    }
  }

  const targetLabel = (t: AutomationTarget) =>
    t.kind === 'team' ? `team: ${t.teamName} (${t.workspaceName})` : `prompt: ${t.workspaceName}`

  return (
    <div style={{ padding: '16px 20px', flex: 1, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button style={pillButton('primary')} onClick={onNew}>+ New automation</button>
      </div>
      {loading ? (
        <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>Loading…</div>
      ) : automations.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '36px 20px', color: C.fg3, fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>⏱</div>
          <div style={{ fontWeight: 500, color: C.fg2, marginBottom: 4 }}>No automations yet</div>
          <div style={{ fontSize: 12 }}>
            Create one — Codey will interview you to remove every runtime ambiguity, then it can run unattended.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {automations.map(a => {
            const last = lastStatus[a.id]
            return (
              <div key={a.id} style={rowStyle}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={() => void toggle(a)}
                  title={a.enabled ? 'Enabled' : 'Disabled'}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: C.fg, fontSize: 13, fontWeight: 600 }}>{a.name}</span>
                    <span style={{ color: C.fg3, fontSize: 11 }}>{scheduleSummary(a.schedule)}</span>
                  </div>
                  <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{targetLabel(a.target)}</div>
                  {last && (
                    <div style={{ color: last.status === 'failed' ? C.red : C.fg3, fontSize: 11, marginTop: 2 }}>
                      last run: {last.status}{last.reportFailure ? ' ⚠ report delivery failed' : ''}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button style={pillButton('ghost')} onClick={() => onEdit(a.id)}>Edit</button>
                  <button style={pillButton('ghost')} onClick={() => onHistory(a.id)}>History</button>
                  <button style={pillButton('ghost')} disabled={!!runningIds[a.id]} onClick={() => void runNow(a.id)}>
                    {runningIds[a.id] ? 'Running…' : 'Run now'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface EditorProps {
  id: string | null
  automation: Automation | null
  onDone: () => void
  onCancel: () => void
  setError: (e: string | null) => void
}

const AutomationEditor: React.FC<EditorProps> = ({ id, automation, onDone, onCancel, setError }) => {
  const [name, setName] = useState(automation?.name ?? '')
  const [targetKind, setTargetKind] = useState<'prompt' | 'team'>(automation?.target.kind ?? 'prompt')
  const [teamName, setTeamName] = useState(automation?.target.kind === 'team' ? automation.target.teamName : '')
  const [workspaceName, setWorkspaceName] = useState(automation?.target.workspaceName ?? '')
  const [teams, setTeams] = useState<string[]>([])
  const [workspaces, setWorkspaces] = useState<string[]>([])

  const [goal, setGoal] = useState('')
  const [brief, setBrief] = useState(automation?.brief ?? '')
  const [params, setParams] = useState<Record<string, string>>(automation?.params ?? {})

  const [sessionId, setSessionId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [question, setQuestion] = useState<{ question: string; why?: string } | null>(null)
  const [qaLog, setQaLog] = useState<Array<{ q: string; a: string }>>([])
  const [answer, setAnswer] = useState('')
  const [interviewBusy, setInterviewBusy] = useState(false)

  const [notify, setNotify] = useState(automation?.report.notify ?? true)
  const [scheduleOn, setScheduleOn] = useState(!!automation?.schedule)
  const [time, setTime] = useState(automation?.schedule ? `${String(automation.schedule.hour).padStart(2, '0')}:${String(automation.schedule.minute).padStart(2, '0')}` : '09:00')
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(automation?.schedule?.daysOfWeek ?? [])

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testRunning, setTestRunning] = useState(false)

  useEffect(() => {
    window.codey.workspaces?.list?.().then(r => setWorkspaces(unwrap(r))).catch(() => {})
    window.codey.globalTeams?.get?.().then(r => setTeams(Object.keys(unwrap(r)))).catch(() => {})
  }, [])

  // Addition 4: cancel an in-progress interview when the editor unmounts or
  // the user navigates away, instead of leaking the session server-side.
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current
      if (sid) void window.codey.automations.interviewCancel(sid).catch(() => {})
    }
  }, [])

  const cancelInterview = useCallback(() => {
    if (sessionId) void window.codey.automations.interviewCancel(sessionId).catch(() => {})
    setSessionId(null)
    setQuestion(null)
    setQaLog([])
  }, [sessionId])

  const startInterview = async () => {
    if (!goal.trim()) return
    setInterviewBusy(true)
    try {
      const targetContext = targetKind === 'team'
        ? `team: ${teamName || '(unnamed)'}`
        : 'plain prompt to a coding agent'
      const step: InterviewStep = unwrap(await window.codey.automations.interviewStart(goal.trim(), targetContext))
      applyStep(step)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setInterviewBusy(false)
    }
  }

  const applyStep = (step: InterviewStep) => {
    setSessionId(step.done ? null : step.sessionId)
    if (step.done) {
      setBrief(step.brief ?? '')
      setParams(step.params ?? {})
      setQuestion(null)
    } else if (step.question) {
      setQuestion({ question: step.question.question, why: step.question.why })
    }
  }

  const submitAnswer = async () => {
    if (!sessionId || !question || !answer.trim()) return
    setInterviewBusy(true)
    const asked = question.question
    const given = answer.trim()
    try {
      const step: InterviewStep = unwrap(await window.codey.automations.interviewAnswer(sessionId, given))
      // Log the Q/A pair only after the answer was accepted, so an IPC
      // failure + retry doesn't duplicate the entry.
      setQaLog(prev => [...prev, { q: asked, a: given }])
      setAnswer('')
      applyStep(step)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setInterviewBusy(false)
    }
  }

  const canSave = name.trim().length > 0 && brief.trim().length > 0

  const buildTarget = (): AutomationTarget =>
    targetKind === 'team'
      ? { kind: 'team', teamName, workspaceName }
      : { kind: 'prompt', workspaceName }

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const schedule = scheduleOn && canSchedule({ brief }) ? timeOfDayToSchedule(time, TZ, daysOfWeek.length ? daysOfWeek : undefined) : undefined
      if (scheduleOn && !schedule) throw new Error('Invalid time')
      const payload = {
        name: name.trim(),
        target: buildTarget(),
        brief,
        params,
        schedule: schedule ?? undefined,
        report: { notify },
      }
      if (id) {
        unwrap(await window.codey.automations.update(id, payload as any))
      } else {
        unwrap(await window.codey.automations.create({ ...payload, enabled: true } as any))
      }
      onDone()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  const testRun = async () => {
    if (!id) return
    setTestRunning(true)
    try {
      unwrap(await window.codey.automations.runNow(id))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setTestRunning(false)
    }
  }

  const del = async () => {
    if (!id) return
    if (!confirm(`Delete automation "${name}"?`)) return
    setDeleting(true)
    try {
      unwrap(await window.codey.automations.delete(id))
      onDone()
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setDeleting(false)
    }
  }

  const back = () => {
    cancelInterview()
    onCancel()
  }

  return (
    <div style={{ padding: '16px 20px', flex: 1, overflowY: 'auto' }}>
      <label style={fieldLabel}>Name</label>
      <input style={{ ...inputStyle, width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Morning news digest" />

      <label style={fieldLabel}>Target</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select style={selectStyle} value={targetKind} onChange={e => setTargetKind(e.target.value as 'prompt' | 'team')}>
          <option value="prompt">Plain prompt</option>
          <option value="team">Team</option>
        </select>
        {targetKind === 'team' && (
          teams.length > 0 ? (
            <select style={selectStyle} value={teamName} onChange={e => setTeamName(e.target.value)}>
              <option value="">— Select team —</option>
              {teams.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : (
            <span style={{ color: C.fg3, fontSize: 12, alignSelf: 'center' }}>No teams available</span>
          )
        )}
        {workspaces.length > 0 ? (
          <select style={selectStyle} value={workspaceName} onChange={e => setWorkspaceName(e.target.value)}>
            <option value="">— Select workspace —</option>
            {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        ) : (
          <span style={{ color: C.fg3, fontSize: 12, alignSelf: 'center' }}>No workspaces available</span>
        )}
      </div>

      {!brief && (
        <>
          <label style={fieldLabel}>Goal</label>
          <textarea
            style={{ ...inputStyle, width: '100%', minHeight: 60, resize: 'vertical' }}
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder="What should this automation do?"
            disabled={!!sessionId}
          />
          {!sessionId && (
            <div style={{ marginTop: 8 }}>
              <button style={pillButton('primary')} disabled={!goal.trim() || interviewBusy} onClick={() => void startInterview()}>
                {interviewBusy ? 'Starting…' : 'Start clarification interview'}
              </button>
            </div>
          )}
        </>
      )}

      {sessionId && (
        <div style={{ marginTop: 12, ...cardStyle }}>
          {qaLog.length > 0 && (
            <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {qaLog.map((row, i) => (
                <div key={i} style={{ fontSize: 12 }}>
                  <div style={{ color: C.fg2 }}>Q: {row.q}</div>
                  <div style={{ color: C.fg3 }}>A: {row.a}</div>
                </div>
              ))}
            </div>
          )}
          {question && (
            <div>
              <div style={{ color: C.fg, fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{question.question}</div>
              {question.why && <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>{question.why}</div>}
              <input
                autoFocus
                style={{ ...inputStyle, width: '100%' }}
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submitAnswer() }}
                placeholder="Your answer…"
                disabled={interviewBusy}
              />
            </div>
          )}
        </div>
      )}

      {brief && (
        <>
          <label style={fieldLabel}>Brief (frozen by the interview)</label>
          <pre style={briefStyle}>{brief}</pre>
          {Object.keys(params).length > 0 && (
            <>
              <label style={fieldLabel}>Params</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(params).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: C.fg3, fontSize: 12, width: 100, flexShrink: 0 }}>{k}</span>
                    <input
                      style={{ ...inputStyle, flex: 1, width: 'auto' }}
                      value={v}
                      onChange={e => setParams(prev => ({ ...prev, [k]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
          <button style={{ ...pillButton('ghost'), marginTop: 8 }} onClick={() => { setBrief(''); setParams({}); setGoal('') }}>
            Re-run interview
          </button>
        </>
      )}

      <label style={fieldLabel}>
        <input type="checkbox" checked={scheduleOn} disabled={!canSchedule({ brief })} onChange={e => setScheduleOn(e.target.checked)} />
        {' '}Schedule{!canSchedule({ brief }) ? ' (complete the interview first)' : ''}
      </label>
      {scheduleOn && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="time" style={inputStyle} value={time} onChange={e => setTime(e.target.value)} />
          <span style={{ color: C.fg3, fontSize: 11 }}>{TZ}</span>
        </div>
      )}

      <label style={fieldLabel}>
        <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
        {' '}Notify on completion
      </label>

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <button style={pillButton('primary')} disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {id && (
          <button style={pillButton('ghost')} disabled={testRunning} onClick={() => void testRun()}>
            {testRunning ? 'Running…' : 'Test run now'}
          </button>
        )}
        {id && (
          <button style={{ ...pillButton('danger') }} disabled={deleting} onClick={() => void del()}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button style={pillButton('ghost')} onClick={back}>Cancel</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface HistoryProps { id: string; setError: (e: string | null) => void }

const RunHistory: React.FC<HistoryProps> = ({ id, setError }) => {
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  // Per-run in-flight guard so a double-click on an option (or a second
  // Enter on the text answer) can't fire resume twice for the same run.
  const [resuming, setResuming] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    try {
      const fresh = unwrap(await window.codey.automations.history(id, 50))
      setRuns(fresh)
      // Addition 2: mark unseen ended runs from the FRESH data just fetched,
      // not from a stale closure over the previous `runs` state.
      const toMark = fresh.filter(r => r.endedAt && !r.seenAt)
      await Promise.all(toMark.map(r => window.codey.automations.markSeen(id, r.runId).catch(() => {})))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [id, setError])

  useEffect(() => { void refresh() }, [refresh])

  const resume = async (runId: string, option: string) => {
    if (resuming[runId]) return
    setResuming(prev => ({ ...prev, [runId]: true }))
    try {
      unwrap(await window.codey.automations.resume(id, runId, option))
      void refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setResuming(prev => ({ ...prev, [runId]: false }))
    }
  }

  return (
    <div style={{ padding: '16px 20px', flex: 1, overflowY: 'auto' }}>
      {runs.length === 0 ? (
        <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>No runs yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {runs.map(r => (
            <div key={r.runId} style={cardStyle}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: C.fg, fontSize: 12, fontWeight: 600 }}>{new Date(r.startedAt).toLocaleString()}</span>
                <span style={{ color: C.fg3, fontSize: 11 }}>{r.trigger}</span>
                <span style={{ color: r.status === 'failed' ? C.red : C.fg3, fontSize: 11 }}>{r.status}</span>
                {r.reportFailure && <span style={{ color: C.red, fontSize: 11 }}>⚠ report delivery failed</span>}
              </div>
              {r.status === 'parked' && r.question && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ color: C.fg2, fontSize: 12, marginBottom: 6 }}>{r.question}</div>
                  {r.options && r.options.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      {r.options.map(opt => (
                        <button
                          key={opt}
                          style={pillButton('ghost')}
                          disabled={!!resuming[r.runId]}
                          onClick={() => void resume(r.runId, opt)}
                        >{opt}</button>
                      ))}
                    </div>
                  )}
                  <input
                    style={{ ...inputStyle, width: '100%' }}
                    placeholder={resuming[r.runId] ? 'Resuming…' : 'Free-text answer…'}
                    disabled={!!resuming[r.runId]}
                    value={answers[r.runId] ?? ''}
                    onChange={e => setAnswers(prev => ({ ...prev, [r.runId]: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const v = (answers[r.runId] ?? '').trim()
                        if (v) void resume(r.runId, v)
                      }
                    }}
                  />
                </div>
              )}
              {r.output && <pre style={preStyle}>{r.output}</pre>}
              {r.error && <pre style={{ ...preStyle, color: C.red }}>{r.error}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

const rowStyle: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'flex-start',
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
  padding: '12px 14px',
}

const cardStyle: React.CSSProperties = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px',
}

const fieldLabel: React.CSSProperties = {
  display: 'block', color: C.fg3, fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 16, marginBottom: 6,
}

const briefStyle: React.CSSProperties = {
  margin: 0, padding: '10px 12px', borderRadius: 8, background: C.surface3, color: C.fg2,
  fontSize: 12, lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}

const preStyle: React.CSSProperties = {
  marginTop: 8, padding: '8px 10px', borderRadius: 6, background: C.codeBg ?? C.surface3, color: C.codeFg ?? C.fg2,
  fontSize: 11, lineHeight: '1.5', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(3px)',
    WebkitBackdropFilter: 'blur(3px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  window: {
    width: 'min(900px, 92%)',
    height: 'min(620px, 88%)',
    background: C.bg,
    border: `1px solid ${C.border2}`,
    borderRadius: 10,
    boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  titleBar: {
    height: 40, flexShrink: 0, display: 'flex', alignItems: 'center',
    borderBottom: `1px solid ${C.border}`, padding: '0 12px',
  },
  closeBtn: {
    width: 24, height: 24, borderRadius: '50%', border: 'none',
    background: 'transparent', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  closeDot: { width: 12, height: 12, borderRadius: '50%', background: C.red },
  titleText: { flex: 1, textAlign: 'center', color: C.fg, fontSize: 13, fontWeight: 600 },
  body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  errorBanner: {
    margin: '10px 20px 0', background: C.dangerBg ?? (C.red + '22'), color: C.dangerFg ?? C.red,
    padding: 10, borderRadius: 8, fontSize: 12,
  },
}
