// codey-mac/src/components/AutomationOnePager.tsx
// One-pager for an existing automation: Overview / Runs tabs, parked banner,
// inline knobs. Behavioral edits go through "Edit in chat".
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap, inputStyle, selectStyle } from './settingsAtoms'
import {
  scheduleSummary, timesToSchedule, nextRunAt, humanizeDelta,
  knobsFrom, knobsEqual, NOTIFY_OPTIONS, type Knobs, type NotifyMode,
} from './automationsModel'
import type { Automation, AutomationRun } from '../../../packages/core/src/types/automation'
import { UIIcon } from './UIIcons'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface Props {
  id: string
  onEditInChat: () => void
  onOpenRunChat: (chatId: string) => void
  onDeleted: () => void
  setError: (e: string | null) => void
}

/** Options + free-text input for answering a parked run's question.
 *  Shared by the header banner and the Runs-tab rows. */
const ParkedPrompt: React.FC<{
  run: AutomationRun
  resuming: boolean
  answer: string
  onAnswerChange: (v: string) => void
  onResume: (option: string) => void
}> = ({ run, resuming, answer, onAnswerChange, onResume }) => (
  <>
    {run.options && run.options.length > 0 && (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {run.options.map(opt => (
          <button key={opt} style={pillButton('ghost')} disabled={resuming}
            onClick={() => onResume(opt)}>{opt}</button>
        ))}
      </div>
    )}
    <input
      style={{ ...inputStyle, width: '100%' }}
      placeholder={resuming ? 'Resuming…' : 'Free-text answer…'}
      disabled={resuming}
      value={answer}
      onChange={e => onAnswerChange(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          const v = answer.trim()
          if (v) onResume(v)
        }
      }}
    />
  </>
)

export const AutomationOnePager: React.FC<Props> = ({ id, onEditInChat, onOpenRunChat, onDeleted, setError }) => {
  const [a, setA] = useState<Automation | null>(null)
  const [tab, setTab] = useState<'overview' | 'runs'>('overview')
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [knobs, setKnobs] = useState<Knobs | null>(null)
  const [running, setRunning] = useState(false)
  const [savingKnobs, setSavingKnobs] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [resuming, setResuming] = useState<Record<string, boolean>>({})
  // Last automation the knobs were seeded from — lets refresh() tell "user is
  // mid-edit" apart from "an external edit changed the automation".
  const aRef = useRef<Automation | null>(null)

  const refresh = useCallback(async () => {
    try {
      const fresh: Automation = unwrap(await window.codey.automations.get(id))
      setA(fresh)
      // Re-seed knobs from fresh data unless the user has in-progress edits;
      // otherwise an external edit (e.g. Edit in chat) would leave a stale
      // "Save knobs" that reverts it.
      // Snapshot the previous baseline before setKnobs: the functional
      // updater runs deferred, so reading aRef.current inside it would see
      // `fresh`, not the baseline the user's edits were made against.
      const prevA = aRef.current
      aRef.current = fresh
      setKnobs(prev =>
        prev === null || prevA === null || knobsEqual(prev, prevA)
          ? knobsFrom(fresh)
          : prev,
      )
      const freshRuns: AutomationRun[] = unwrap(await window.codey.automations.history(id, 50))
      setRuns(freshRuns)
      // Viewing the one-pager counts as seeing its results.
      const toMark = freshRuns.filter(r => r.endedAt && !r.seenAt)
      await Promise.all(toMark.map(r => window.codey.automations.markSeen(id, r.runId).catch(() => {})))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [id, setError])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => window.codey.automations.onEvent(() => { void refresh() }), [refresh])

  const runNow = async () => {
    setRunning(true)
    try {
      // Resolve the run chat first, then fire the run without awaiting it and
      // jump to that chat so the user watches progress live. The outcome still
      // lands in run history and notifications.
      const { chatId } = unwrap(await window.codey.automations.runChat(id))
      void window.codey.automations.runNow(id).catch(() => { /* surfaced via run history */ })
      onOpenRunChat(chatId)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setRunning(false)
    }
  }

  const toggleEnabled = async () => {
    if (!a) return
    try {
      unwrap(await window.codey.automations.setEnabled(id, !a.enabled))
      setA({ ...a, enabled: !a.enabled })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const del = async () => {
    if (!a || !confirm(`Delete automation "${a.name}"?`)) return
    setDeleting(true)
    try {
      unwrap(await window.codey.automations.delete(id))
      onDeleted()
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setDeleting(false)
    }
  }

  const resume = async (runId: string, option: string) => {
    if (resuming[runId]) return
    setResuming(prev => ({ ...prev, [runId]: true }))
    try {
      unwrap(await window.codey.automations.resume(id, runId, option))
      setAnswers(prev => { const next = { ...prev }; delete next[runId]; return next })
      void refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setResuming(prev => ({ ...prev, [runId]: false }))
    }
  }

  const knobsDirty = !!a && !!knobs && !knobsEqual(knobs, a)

  const saveKnobs = async () => {
    if (!a || !knobs || savingKnobs) return
    setSavingKnobs(true)
    try {
      const schedule = knobs.scheduleOn
        ? timesToSchedule(knobs.times, a.schedule?.tz ?? TZ, knobs.days.length ? knobs.days : undefined)
        : undefined
      if (knobs.scheduleOn && !schedule) throw new Error('Invalid time')
      const fresh: Automation = unwrap(await window.codey.automations.update(id, {
        params: knobs.params,
        schedule: schedule ?? undefined,
        report: { ...a.report, notify: knobs.notify },
      }))
      setA(fresh)
      setKnobs(knobsFrom(fresh))
      aRef.current = fresh
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSavingKnobs(false)
    }
  }

  if (!a) return <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 24 }}>Loading…</div>

  const next = a.schedule && a.enabled ? nextRunAt(a.schedule, Date.now()) : null
  const subtitle = a.schedule
    ? `${scheduleSummary(a.schedule)} (${a.schedule.tz})${next ? ` · next run ${humanizeDelta(next - Date.now())}` : ''}`
    : 'manual only'
  const latest = runs[0]

  return (
    <div style={{ padding: '14px 20px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: C.fg, fontSize: 15, fontWeight: 600 }}>{a.name}</div>
          <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{subtitle}</div>
        </div>
        <button style={{ ...pillButton('primary'), display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={running} onClick={() => void runNow()}>
          <UIIcon name="play" size={14} />{running ? 'Running…' : 'Run now'}
        </button>
        <button style={{ ...pillButton('ghost'), display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={onEditInChat}><UIIcon name="chat" size={14} />Edit in chat</button>
        <label style={{ color: C.fg3, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={a.enabled} onChange={() => void toggleEnabled()} />
          Enabled
        </label>
        <button style={{ ...pillButton('danger'), display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={deleting} onClick={() => void del()}>
          <UIIcon name="trash" size={14} />{deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {latest?.status === 'parked' && latest.question && (
        <div style={parkedBanner}>
          <div style={{ color: C.fg, fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
            Waiting on you: {latest.question}
          </div>
          <ParkedPrompt
            run={latest}
            resuming={!!resuming[latest.runId]}
            answer={answers[latest.runId] ?? ''}
            onAnswerChange={v => setAnswers(prev => ({ ...prev, [latest.runId]: v }))}
            onResume={opt => void resume(latest.runId, opt)}
          />
        </div>
      )}

      <div style={tabBar}>
        <button style={{ ...tabStyle(tab === 'overview'), display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setTab('overview')}><UIIcon name="activity" size={13} />Overview</button>
        <button style={{ ...tabStyle(tab === 'runs'), display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setTab('runs')}><UIIcon name="archive" size={13} />Runs ({runs.length})</button>
      </div>

      {tab === 'overview' && knobs && (
        <div>
          <div style={sectLabel}>What it does</div>
          <pre style={briefBox}>{a.brief}</pre>

          <div style={sectLabel}>Knobs — edit directly</div>
          {Object.entries(knobs.params).map(([k, v]) => (
            <div key={k} style={knobRow}>
              <span style={knobKey}>{k}</span>
              <input style={{ ...inputStyle, flex: 1, width: 'auto' }} value={v}
                onChange={e => setKnobs({ ...knobs, params: { ...knobs.params, [k]: e.target.value } })} />
            </div>
          ))}
          <div style={knobRow}>
            <span style={knobKey}>schedule</span>
            <input type="checkbox" checked={knobs.scheduleOn}
              onChange={e => setKnobs({ ...knobs, scheduleOn: e.target.checked })} />
            {knobs.scheduleOn && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {knobs.times.map((t, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="time" style={inputStyle} value={t}
                        onChange={e => setKnobs({ ...knobs, times: knobs.times.map((x, j) => j === i ? e.target.value : x) })} />
                      {knobs.times.length > 1 && (
                        <button style={{ ...pillButton('ghost'), padding: '2px 7px' }} title="Remove this time"
                          onClick={() => setKnobs({ ...knobs, times: knobs.times.filter((_, j) => j !== i) })}>×</button>
                      )}
                    </div>
                  ))}
                  <button style={{ ...pillButton('ghost'), alignSelf: 'flex-start', padding: '2px 7px', fontSize: 10 }}
                    onClick={() => setKnobs({ ...knobs, times: [...knobs.times, '12:00'] })}>+ time</button>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {DAY.map((d, i) => (
                    <button key={d}
                      style={{ ...pillButton(knobs.days.includes(i) ? 'primary' : 'ghost'), padding: '2px 7px', fontSize: 10 }}
                      onClick={() => setKnobs({
                        ...knobs,
                        days: knobs.days.includes(i) ? knobs.days.filter(x => x !== i) : [...knobs.days, i].sort(),
                      })}
                    >{d}</button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div style={knobRow}>
            <span style={knobKey}>notify</span>
            <select style={selectStyle} value={knobs.notify}
              onChange={e => setKnobs({ ...knobs, notify: e.target.value as NotifyMode })}>
              {NOTIFY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {knobsDirty && (
            <button style={{ ...pillButton('primary'), marginTop: 8 }} disabled={savingKnobs} onClick={() => void saveKnobs()}>
              {savingKnobs ? 'Saving…' : 'Save knobs'}
            </button>
          )}

          <div style={sectLabel}>Setup</div>
          <div style={setupRow}><span style={knobKey}>Runs in</span>
            <span>{a.target.kind === 'team' ? `team ${a.target.teamName} (${a.target.workspaceName})` : `workspace ${a.target.workspaceName} (prompt)`}</span>
          </div>
          <div style={setupRow}><span style={knobKey}>Created</span><span>{new Date(a.createdAt).toLocaleString()}</span></div>
          <div style={setupRow}><span style={knobKey}>Updated</span><span>{new Date(a.updatedAt).toLocaleString()}</span></div>
        </div>
      )}

      {tab === 'runs' && (
        runs.length === 0 ? (
          <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>No runs yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {runs.map(r => (
              <div key={r.runId} style={cardStyle}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: C.fg, fontSize: 12, fontWeight: 600 }}>{new Date(r.startedAt).toLocaleString()}</span>
                  <span style={{ color: C.fg3, fontSize: 11 }}>{r.trigger}</span>
                  <span style={{ color: r.status === 'failed' ? C.red : C.fg3, fontSize: 11 }}>{r.status}</span>
                  {r.reportFailure && <span style={{ color: C.red, fontSize: 11 }}>report delivery failed</span>}
                </div>
                {r.status === 'parked' && r.question && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ color: C.fg2, fontSize: 12, marginBottom: 6 }}>{r.question}</div>
                    <ParkedPrompt
                      run={r}
                      resuming={!!resuming[r.runId]}
                      answer={answers[r.runId] ?? ''}
                      onAnswerChange={v => setAnswers(prev => ({ ...prev, [r.runId]: v }))}
                      onResume={opt => void resume(r.runId, opt)}
                    />
                  </div>
                )}
                {r.output && <pre style={preStyle}>{r.output}</pre>}
                {r.error && <pre style={{ ...preStyle, color: C.red }}>{r.error}</pre>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

const parkedBanner: React.CSSProperties = {
  marginTop: 12, padding: '10px 12px', borderRadius: 8,
  border: `1px solid ${C.border2}`, background: C.surface3,
}

const tabBar: React.CSSProperties = {
  display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, margin: '14px 0 12px',
}

const tabStyle = (on: boolean): React.CSSProperties => ({
  padding: '5px 14px', fontSize: 12, border: 'none', cursor: 'pointer',
  borderRadius: '6px 6px 0 0', background: on ? C.surface : 'transparent',
  color: on ? C.fg : C.fg3, fontWeight: on ? 600 : 400,
})

const sectLabel: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 16, marginBottom: 6,
}

const briefBox: React.CSSProperties = {
  margin: 0, padding: '10px 12px', borderRadius: 8, background: C.surface3, color: C.fg2,
  fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}

const knobRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0',
}

const knobKey: React.CSSProperties = {
  color: C.fg3, fontSize: 12, width: 90, flexShrink: 0,
}

const setupRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'baseline', margin: '2px 0',
  color: C.fg2, fontSize: 12,
}

const cardStyle: React.CSSProperties = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px',
}

const preStyle: React.CSSProperties = {
  marginTop: 8, padding: '8px 10px', borderRadius: 6,
  background: C.codeBg ?? C.surface3, color: C.codeFg ?? C.fg2,
  fontSize: 11, lineHeight: 1.5, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
