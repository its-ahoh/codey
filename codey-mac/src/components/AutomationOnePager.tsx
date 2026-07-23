// codey-mac/src/components/AutomationOnePager.tsx
// One-pager for an existing automation: Overview / Runs tabs, parked banner,
// inline knobs. Behavioral edits go through "Edit in chat".
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap, inputStyle, selectStyle } from './settingsAtoms'
import {
  scheduleSummary, slotsToSchedule, nextRunAt, humanizeDelta,
  knobsFrom, knobsEqual, NOTIFY_OPTIONS, type Knobs, type NotifyMode,
} from './automationsModel'
import type { Automation, AutomationRun } from '../../../packages/core/src/types/automation'
import { UIIcon, type IconName } from './UIIcons'
import { Markdown } from './Markdown'

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
      style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
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
  // Per-run activity log expander: open flags + lazily fetched text
  // (undefined = not fetched, null = fetched but no log exists).
  const [logOpen, setLogOpen] = useState<Record<string, boolean>>({})
  const [logText, setLogText] = useState<Record<string, string | null>>({})
  const [outputOpen, setOutputOpen] = useState<Record<string, boolean>>({})
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

  const toggleLog = async (runId: string) => {
    const opening = !logOpen[runId]
    setLogOpen(prev => ({ ...prev, [runId]: opening }))
    if (!opening || logText[runId] !== undefined) return
    try {
      const text = unwrap(await window.codey.automations.runLog(id, runId))
      setLogText(prev => ({ ...prev, [runId]: text }))
    } catch {
      setLogText(prev => ({ ...prev, [runId]: null }))
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
        ? slotsToSchedule(knobs.slots, a.schedule?.tz ?? TZ)
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
  const latest = runs[0]
  const health = automationHealth(a, latest)
  const targetTitle = a.target.kind === 'team' ? a.target.teamName : a.target.workspaceName
  const targetDetail = a.target.kind === 'team'
    ? `Team · ${a.target.workspaceName}`
    : [a.target.agent ?? 'Default agent', a.target.model].filter(Boolean).join(' · ')
  const notifyTitle = NOTIFY_OPTIONS.find(option => option.value === a.report.notify)?.label ?? 'Never'

  return (
    <div style={pageStyle}>
      <header style={heroStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={eyebrow}>AUTOMATION</div>
          <div style={titleRow}>
            <h2 style={titleStyle}>{a.name}</h2>
            <span style={healthBadge(health.color)}><span style={healthDot(health.color)} />{health.label}</span>
          </div>
          <div style={subtitleStyle}>
            {a.schedule ? `${scheduleSummary(a.schedule)} · ${a.schedule.tz}` : 'Runs manually'}
          </div>
        </div>
        <div style={heroActions}>
          <label style={enabledControl} title={a.enabled ? 'Pause scheduled runs' : 'Enable scheduled runs'}>
            <input type="checkbox" checked={a.enabled} onChange={() => void toggleEnabled()} />
            {a.enabled ? 'Enabled' : 'Paused'}
          </label>
          <button style={iconButton} onClick={onEditInChat}><UIIcon name="settings" size={14} />Edit setup</button>
          <button style={{ ...pillButton('primary'), ...actionButton }} disabled={running} onClick={() => void runNow()}>
            <UIIcon name="play" size={14} />{running ? 'Starting…' : 'Run now'}
          </button>
        </div>
      </header>

      {latest?.status === 'parked' && latest.question && (
        <div style={parkedBanner}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={attentionIcon}>!</span>
            <div style={{ flex: 1 }}>
              <div style={{ color: C.fg, fontSize: 12, fontWeight: 700 }}>This automation needs your input</div>
              <div style={{ color: C.fg2, fontSize: 12, margin: '3px 0 8px' }}>{latest.question}</div>
              <ParkedPrompt
                run={latest}
                resuming={!!resuming[latest.runId]}
                answer={answers[latest.runId] ?? ''}
                onAnswerChange={v => setAnswers(prev => ({ ...prev, [latest.runId]: v }))}
                onResume={opt => void resume(latest.runId, opt)}
              />
            </div>
          </div>
        </div>
      )}

      <div style={summaryGrid}>
        <SummaryCard label="Next run" icon="activity"
          value={!a.enabled ? 'Paused' : next ? humanizeDelta(next - Date.now()) : a.schedule ? 'Not scheduled' : 'Manual only'}
          detail={next ? new Date(next).toLocaleString() : a.schedule ? scheduleSummary(a.schedule) : 'Use Run now whenever needed'} />
        <SummaryCard label="Last run" icon="archive"
          value={latest ? statusLabel(latest.status) : 'No runs yet'}
          detail={latest ? new Date(latest.startedAt).toLocaleString() : 'History will appear after the first run'}
          tone={latest?.status === 'failed' ? C.red : latest?.status === 'parked' ? C.yellow : undefined} />
        <SummaryCard label="Runs in" icon={a.target.kind === 'team' ? 'users' : 'workspace'} value={targetTitle} detail={targetDetail} />
        <SummaryCard label="Notifications" icon="bot" value={notifyTitle}
          detail={a.report.channel ? `Also posts to ${a.report.channel.platform}` : 'Mac notifications'} />
      </div>

      <div style={tabBar}>
        <button style={{ ...tabStyle(tab === 'overview'), display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setTab('overview')}><UIIcon name="overview" size={13} />Overview</button>
        <button style={{ ...tabStyle(tab === 'runs'), display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setTab('runs')}><UIIcon name="archive" size={13} />Runs ({runs.length})</button>
      </div>

      {tab === 'overview' && knobs && (
        <div style={overviewGrid}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DetailCard title="What it does" description="The frozen instructions sent at the beginning of each run." action={
              <button style={textButton} onClick={onEditInChat}>Edit instructions</button>
            }>
              <div style={briefBox}><Markdown variant="assistant">{a.brief}</Markdown></div>
            </DetailCard>

            <DetailCard title="Variables" description="Tune these values without changing the underlying instructions.">
              {Object.keys(knobs.params).length === 0 ? (
                <div style={emptyState}>No editable variables. Add them from Edit setup.</div>
              ) : Object.entries(knobs.params).map(([key, value]) => (
                <label key={key} style={settingRow}>
                  <span style={settingLabel}><code>{key}</code></span>
                  <input style={settingInput} value={value}
                    onChange={e => setKnobs({ ...knobs, params: { ...knobs.params, [key]: e.target.value } })} />
                </label>
              ))}
            </DetailCard>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DetailCard title="Schedule" description={`Times are interpreted in ${a.schedule?.tz ?? TZ}.`}>
              <label style={settingRow}>
                <span style={settingLabel}>Scheduled runs</span>
                <span style={inlineToggle}><input type="checkbox" checked={knobs.scheduleOn}
                  onChange={e => setKnobs({ ...knobs, scheduleOn: e.target.checked })} />{knobs.scheduleOn ? 'On' : 'Off'}</span>
              </label>
              {knobs.scheduleOn && (
                <>
                  <div style={scheduleSlotList}>
                    {knobs.slots.map((slot, slotIndex) => (
                      <div key={slotIndex} style={scheduleSlotCard}>
                        <div style={slotHeader}>
                          <input type="time" style={compactInput} value={slot.time} aria-label={`Time slot ${slotIndex + 1}`}
                            onChange={e => setKnobs({ ...knobs, slots: knobs.slots.map((item, index) => index === slotIndex ? { ...item, time: e.target.value } : item) })} />
                          <span style={slotSummary}>{slot.days.length ? `${slot.days.length} selected days` : 'Every day'}</span>
                          {knobs.slots.length > 1 && <button style={removeButton} title="Remove time slot"
                            onClick={() => setKnobs({ ...knobs, slots: knobs.slots.filter((_, index) => index !== slotIndex) })}>×</button>}
                        </div>
                        <div style={dayEditor}>{DAY.map((day, dayIndex) => {
                          const active = slot.days.length === 0 || slot.days.includes(dayIndex)
                          return <button key={dayIndex} style={dayButton(active)} title={day}
                            onClick={() => {
                              const current = slot.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : slot.days
                              const days = current.includes(dayIndex) ? current.filter(x => x !== dayIndex) : [...current, dayIndex].sort()
                              setKnobs({ ...knobs, slots: knobs.slots.map((item, index) => index === slotIndex
                                ? { ...item, days: days.length === 7 ? [] : days }
                                : item) })
                            }}>{day.slice(0, 1)}</button>
                        })}</div>
                      </div>
                    ))}
                    <button style={{ ...smallButton, alignSelf: 'flex-start' }}
                      onClick={() => setKnobs({ ...knobs, slots: [...knobs.slots, { time: '12:00', days: [] }] })}>+ Add another time slot</button>
                  </div>
                </>
              )}
            </DetailCard>

            <DetailCard title="Notifications" description="Choose which run outcomes should interrupt you.">
              <label style={settingRow}>
                <span style={settingLabel}>Mac notification</span>
                <select style={settingSelect} value={knobs.notify}
                  onChange={e => setKnobs({ ...knobs, notify: e.target.value as NotifyMode })}>
                  {NOTIFY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              {a.report.channel && <div style={infoRow}><span>Channel delivery</span><strong>{a.report.channel.platform}</strong></div>}
            </DetailCard>

            <DetailCard title="Details" description="Execution target and record metadata.">
              <div style={infoRow}><span>Target</span><strong>{targetTitle}</strong></div>
              <div style={infoRow}><span>Created</span><strong>{new Date(a.createdAt).toLocaleDateString()}</strong></div>
              <div style={infoRow}><span>Updated</span><strong>{new Date(a.updatedAt).toLocaleDateString()}</strong></div>
            </DetailCard>
          </div>

          {knobsDirty && (
            <div style={saveBar}>
              <div style={noticeCopy}><strong>Unsaved settings</strong><span>Your schedule, variables, or notifications changed.</span></div>
              <div style={{ display: 'flex', gap: 7 }}>
                <button style={pillButton('ghost')} disabled={savingKnobs} onClick={() => setKnobs(knobsFrom(a))}>Discard</button>
                <button style={pillButton('primary')} disabled={savingKnobs} onClick={() => void saveKnobs()}>{savingKnobs ? 'Saving…' : 'Save settings'}</button>
              </div>
            </div>
          )}

          <div style={dangerCard}>
            <div style={noticeCopy}><strong>Delete automation</strong><span>Removes its definition, run history, logs, and hidden run chat.</span></div>
            <button style={compactDeleteButton} disabled={deleting} onClick={() => void del()}><UIIcon name="trash" size={11} />{deleting ? 'Deleting…' : 'Delete'}</button>
          </div>
        </div>
      )}

      {tab === 'runs' && (
        runs.length === 0 ? (
          <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>No runs yet.</div>
        ) : (
          <div style={runsList}>
            {runs.map(r => (
              <div key={r.runId} style={runCard}>
                <div style={runHeader}>
                  <span style={runStatusIcon(statusColor(r.status))}><UIIcon name={r.status === 'success' || r.status === 'resumed' ? 'check' : r.status === 'parked' ? 'chat' : 'close'} size={14} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                      <strong style={{ color: C.fg, fontSize: 12 }}>{statusLabel(r.status)}</strong>
                      <span style={triggerBadge}>{r.trigger === 'manual' ? 'Manual' : 'Scheduled'}</span>
                    </div>
                    <div style={runMeta}>{new Date(r.startedAt).toLocaleString()}{r.endedAt ? ` · ${formatDuration(r.endedAt - r.startedAt)}` : ''}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {r.output && <button style={smallButton} onClick={() => setOutputOpen(prev => ({ ...prev, [r.runId]: !prev[r.runId] }))}>{outputOpen[r.runId] ? 'Hide result' : 'View result'}</button>}
                    <button style={smallButton} onClick={() => void toggleLog(r.runId)}>{logOpen[r.runId] ? 'Hide activity' : 'Activity log'}</button>
                  </div>
                </div>
                {r.reportFailure && <div style={errorNotice}>Report delivery failed: {r.reportFailure}</div>}
                {r.status === 'parked' && r.question && (
                  <div style={runBody}>
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
                {r.output && outputOpen[r.runId] && <div style={outputStyle}><Markdown variant="assistant">{r.output}</Markdown></div>}
                {r.error && <pre style={{ ...preStyle, color: C.red }}>{r.error}</pre>}
                {logOpen[r.runId] && (
                  logText[r.runId] === undefined
                    ? <div style={{ color: C.fg3, fontSize: 11, marginTop: 6 }}>Loading…</div>
                    : logText[r.runId]
                      ? <pre style={{ ...preStyle, maxHeight: 320, overflowY: 'auto' }}>{logText[r.runId]}</pre>
                      : <div style={{ color: C.fg3, fontSize: 11, marginTop: 6 }}>No activity log for this run.</div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

const SummaryCard: React.FC<{ label: string; value: string; detail: string; icon: IconName; tone?: string }> = ({ label, value, detail, icon, tone }) => (
  <div style={summaryCard}>
    <span style={summaryIcon}><UIIcon name={icon} size={15} /></span>
    <div style={{ minWidth: 0 }}>
      <div style={summaryLabel}>{label}</div>
      <div style={{ ...summaryValue, color: tone ?? C.fg }}>{value}</div>
      <div style={summaryDetail} title={detail}>{detail}</div>
    </div>
  </div>
)

const DetailCard: React.FC<{ title: string; description: string; action?: React.ReactNode; children: React.ReactNode }> = ({ title, description, action, children }) => (
  <section style={detailCard}>
    <div style={cardHeading}>
      <div>
        <div style={cardTitle}>{title}</div>
        <div style={cardDescription}>{description}</div>
      </div>
      {action}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>{children}</div>
  </section>
)

function statusLabel(status: AutomationRun['status']): string {
  return { success: 'Completed', failed: 'Failed', parked: 'Needs input', resumed: 'Resumed' }[status]
}

function statusColor(status: AutomationRun['status']): string {
  if (status === 'failed') return C.red
  if (status === 'parked') return C.yellow
  return C.green
}

function automationHealth(a: Automation, latest?: AutomationRun): { label: string; color: string } {
  if (!a.enabled) return { label: 'Paused', color: C.fg3 }
  if (latest?.status === 'parked') return { label: 'Needs input', color: C.yellow }
  if (latest?.status === 'failed') return { label: 'Last run failed', color: C.red }
  return { label: 'Healthy', color: C.green }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

const pageStyle: React.CSSProperties = { padding: '18px 22px 28px', flex: 1, overflowY: 'auto', background: C.bg }
const heroStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 18 }
const eyebrow: React.CSSProperties = { color: C.accent, fontSize: 9, fontWeight: 800, letterSpacing: 1.1, marginBottom: 4 }
const titleRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }
const titleStyle: React.CSSProperties = { color: C.fg, fontSize: 19, lineHeight: 1.2, fontWeight: 750, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const subtitleStyle: React.CSSProperties = { color: C.fg3, fontSize: 11, marginTop: 4 }
const heroActions: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'center', flexShrink: 0 }
const actionButton: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 }
const iconButton: React.CSSProperties = { ...pillButton('ghost'), ...actionButton }
const enabledControl: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 9px', color: C.fg2, fontSize: 11, border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }
const healthBadge = (color: string): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 999, color, background: C.surface3, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' })
const healthDot = (color: string): React.CSSProperties => ({ width: 6, height: 6, borderRadius: 999, background: color, boxShadow: `0 0 0 3px ${C.surface2}` })

const parkedBanner: React.CSSProperties = {
  marginTop: 14, padding: '12px 14px', borderRadius: 11,
  border: `1px solid ${C.yellow}`, background: C.warningBg,
}
const attentionIcon: React.CSSProperties = { width: 24, height: 24, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 8, background: C.yellow, color: C.bg, fontWeight: 900, fontSize: 12 }

const summaryGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 9, marginTop: 15 }
const summaryCard: React.CSSProperties = { display: 'flex', gap: 10, minWidth: 0, padding: '11px 12px', border: `1px solid ${C.border}`, borderRadius: 11, background: C.surface }
const summaryIcon: React.CSSProperties = { width: 30, height: 30, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 9, background: C.accentDim, color: C.accent }
const summaryLabel: React.CSSProperties = { color: C.fg3, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }
const summaryValue: React.CSSProperties = { fontSize: 12, fontWeight: 700, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const summaryDetail: React.CSSProperties = { color: C.fg3, fontSize: 9.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const tabBar: React.CSSProperties = {
  display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, margin: '18px 0 14px',
}

const tabStyle = (on: boolean): React.CSSProperties => ({
  padding: '7px 13px', fontSize: 11.5, border: 'none', cursor: 'pointer',
  borderBottom: `2px solid ${on ? C.accent : 'transparent'}`, background: 'transparent',
  color: on ? C.fg : C.fg3, fontWeight: on ? 700 : 500,
})

const overviewGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start', gap: 12 }
const detailCard: React.CSSProperties = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 15px' }
const cardHeading: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }
const cardTitle: React.CSSProperties = { color: C.fg, fontSize: 12.5, fontWeight: 750 }
const cardDescription: React.CSSProperties = { color: C.fg3, fontSize: 10.5, lineHeight: 1.4, marginTop: 2 }
const textButton: React.CSSProperties = { border: 'none', background: 'transparent', color: C.accent, cursor: 'pointer', fontSize: 10.5, whiteSpace: 'nowrap' }

const briefBox: React.CSSProperties = {
  padding: '10px 12px', borderRadius: 9, background: C.surface3, color: C.fg2,
  fontSize: 12, lineHeight: 1.55, wordBreak: 'break-word',
}
const settingRow: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }
const settingLabel: React.CSSProperties = { color: C.fg2, fontSize: 11, minWidth: 90 }
const settingInput: React.CSSProperties = { ...inputStyle, boxSizing: 'border-box', flex: 1, width: 'auto', minWidth: 0 }
const settingSelect: React.CSSProperties = { ...selectStyle, width: 155 }
const inlineToggle: React.CSSProperties = { display: 'flex', gap: 5, alignItems: 'center', color: C.fg2, fontSize: 11 }
const compactInput: React.CSSProperties = { ...inputStyle, width: 88, padding: '5px 7px', fontSize: 11 }
const removeButton: React.CSSProperties = { width: 25, height: 25, borderRadius: 7, border: `1px solid ${C.border}`, background: C.surface3, color: C.fg3, cursor: 'pointer' }
const smallButton: React.CSSProperties = { padding: '5px 8px', borderRadius: 7, border: `1px solid ${C.border2}`, background: C.surface3, color: C.fg2, cursor: 'pointer', fontSize: 10 }
const scheduleSlotList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const scheduleSlotCard: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: '9px 10px', border: `1px solid ${C.border}`, borderRadius: 9, background: C.surface2 }
const slotHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7 }
const slotSummary: React.CSSProperties = { color: C.fg3, fontSize: 10, flex: 1 }
const dayEditor: React.CSSProperties = { display: 'flex', gap: 4 }
const dayButton = (active: boolean): React.CSSProperties => ({ width: 25, height: 25, borderRadius: 7, border: `1px solid ${active ? C.accent : C.border2}`, background: active ? C.accentDim : C.surface3, color: active ? C.accent : C.fg3, cursor: 'pointer', fontSize: 9, fontWeight: 750 })
const infoRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, color: C.fg3, fontSize: 10.5, padding: '2px 0' }
const emptyState: React.CSSProperties = { color: C.fg3, fontSize: 11, padding: '8px 0', fontStyle: 'italic' }
const saveBar: React.CSSProperties = { gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, position: 'sticky', bottom: 8, zIndex: 2, padding: '11px 13px', border: `1px solid ${C.accent}`, borderRadius: 11, background: C.surface2, boxShadow: '0 8px 25px rgba(0,0,0,.22)', color: C.fg, fontSize: 11 }
const dangerCard: React.CSSProperties = { gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 2, padding: '12px 14px', border: `1px solid ${C.dangerBorder}`, borderRadius: 11, background: C.dangerBg, color: C.dangerFg, fontSize: 11 }
const noticeCopy: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const compactDeleteButton: React.CSSProperties = { ...pillButton('danger'), display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 8px', borderRadius: 7, fontSize: 10, fontWeight: 600 }

const runsList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 9 }
const runCard: React.CSSProperties = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 11, overflow: 'hidden' }
const runHeader: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '11px 13px' }
const runStatusIcon = (color: string): React.CSSProperties => ({ width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 9, background: C.surface3, color, flexShrink: 0 })
const triggerBadge: React.CSSProperties = { padding: '2px 6px', borderRadius: 999, background: C.surface3, color: C.fg3, fontSize: 9.5 }
const runMeta: React.CSSProperties = { color: C.fg3, fontSize: 10, marginTop: 3 }
const runBody: React.CSSProperties = { borderTop: `1px solid ${C.border}`, padding: '11px 13px', background: C.surface2 }
const errorNotice: React.CSSProperties = { borderTop: `1px solid ${C.dangerBorder}`, padding: '8px 13px', background: C.dangerBg, color: C.dangerFg, fontSize: 10.5 }

const outputStyle: React.CSSProperties = {
  borderTop: `1px solid ${C.border}`, padding: '10px 13px',
  background: C.codeBg ?? C.surface3, color: C.codeFg ?? C.fg2,
  fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word',
}

const preStyle: React.CSSProperties = {
  margin: 0, padding: '10px 13px', borderTop: `1px solid ${C.border}`,
  background: C.codeBg ?? C.surface3, color: C.codeFg ?? C.fg2,
  fontSize: 11, lineHeight: 1.5, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
