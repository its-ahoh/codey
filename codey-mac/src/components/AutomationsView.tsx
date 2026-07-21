import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { OverlayWindow } from './OverlayWindow'
import { pillButton, unwrap } from './settingsAtoms'
import { humanizeDelta, nextRunAt, scheduleSummary } from './automationsModel'
import { AutomationChatCreate } from './AutomationChatCreate'
import { AutomationOnePager } from './AutomationOnePager'
import { UIIcon } from './UIIcons'
import type { Automation, AutomationRun, AutomationTarget } from '../../../packages/core/src/types/automation'

interface Props {
  onClose: () => void
  /** Open the hidden chat a run executes in, to monitor its progress. */
  onOpenRunChat: (chatId: string) => void
}

type Panel =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'chat-edit'; id: string }
  | { kind: 'view'; id: string }

export const AutomationsView: React.FC<Props> = ({ onClose, onOpenRunChat }) => {
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

  // The view is open and the user is looking at it - mark finished/parked
  // runs seen as their events arrive, so they don't re-notify on next launch.
  useEffect(() => {
    const off = window.codey.automations.onEvent((ev) => {
      if (ev.type === 'run-finished' || ev.type === 'run-parked') {
        void window.codey.automations.markSeen(ev.automationId, ev.runId).catch(() => {})
      }
      void refresh()
    })
    return off
  }, [refresh])

  const atList = panel.kind === 'list'

  return (
    <OverlayWindow
      title="Automations"
      icon="activity"
      onClose={atList ? onClose : () => setPanel({ kind: 'list' })}
      closeTitle={atList ? 'Close (Esc)' : 'Back'}
      closeAriaLabel={atList ? 'Close' : 'Back'}
      onDismiss={atList ? onClose : null}
    >
      <div style={styles.body}>
          {error && <div style={styles.errorBanner}>{error}</div>}
          {panel.kind === 'list' && (
            <AutomationList
              automations={automations}
              loading={loading}
              onRefresh={refresh}
              onNew={() => setPanel({ kind: 'create' })}
              onOpen={(id) => setPanel({ kind: 'view', id })}
              onOpenRunChat={onOpenRunChat}
              setError={setError}
            />
          )}
          {(panel.kind === 'create' || panel.kind === 'chat-edit') && (
            <AutomationChatCreate
              key={panel.kind === 'chat-edit' ? panel.id : 'new'}
              mode={panel.kind === 'chat-edit' ? 'edit' : 'create'}
              automationId={panel.kind === 'chat-edit' ? panel.id : undefined}
              onDone={() => {
                setPanel(panel.kind === 'chat-edit' ? { kind: 'view', id: panel.id } : { kind: 'list' })
                void refresh()
              }}
              setError={setError}
            />
          )}
          {panel.kind === 'view' && (
            <AutomationOnePager
              key={panel.id}
              id={panel.id}
              onEditInChat={() => setPanel({ kind: 'chat-edit', id: panel.id })}
              onOpenRunChat={onOpenRunChat}
              onDeleted={() => { setPanel({ kind: 'list' }); void refresh() }}
              setError={setError}
            />
          )}
      </div>
    </OverlayWindow>
  )
}

// ---------------------------------------------------------------------------

interface ListProps {
  automations: Automation[]
  loading: boolean
  onRefresh: () => void
  onNew: () => void
  onOpen: (id: string) => void
  onOpenRunChat: (chatId: string) => void
  setError: (e: string | null) => void
}

const AutomationList: React.FC<ListProps> = ({ automations, loading, onRefresh, onNew, onOpen, onOpenRunChat, setError }) => {
  const [lastStatus, setLastStatus] = useState<Record<string, AutomationRun | undefined>>({})
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(automations.map(async a => {
        try {
          const runs = unwrap(await window.codey.automations.history(a.id, 1))
          const last = runs[0]
          // Displaying the last-run status in the list counts as seeing it.
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
      // Resolve the run chat first, then fire the run without awaiting it and
      // jump to that chat so the user watches progress live. The outcome still
      // lands in run history and notifications.
      const { chatId } = unwrap(await window.codey.automations.runChat(id))
      void window.codey.automations.runNow(id).catch(() => { /* surfaced via run history */ })
      onOpenRunChat(chatId)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setRunningIds(prev => ({ ...prev, [id]: false }))
    }
  }

  const targetLabel = (t: AutomationTarget) => t.kind === 'team'
    ? `Team · ${t.teamName} · ${t.workspaceName}`
    : [t.workspaceName, t.agent && `${t.agent}${t.model ? ` · ${t.model}` : ''}`].filter(Boolean).join(' · ')

  const attentionCount = automations.filter(a => {
    const status = lastStatus[a.id]?.status
    return status === 'failed' || status === 'parked'
  }).length
  const activeCount = automations.filter(a => a.enabled).length
  const scheduledCount = automations.filter(a => a.enabled && a.schedule).length
  const ordered = [...automations].sort((a, b) => {
    const attention = (automation: Automation) => ['failed', 'parked'].includes(lastStatus[automation.id]?.status ?? '') ? 1 : 0
    return attention(b) - attention(a) || Number(b.enabled) - Number(a.enabled) || b.updatedAt - a.updatedAt
  })

  return (
    <div style={styles.list}>
      <div style={styles.listTop}>
        <div><div style={styles.listTitle}>Your automations</div><div style={styles.listSub}>Scheduled and manual workflows managed in one place.</div></div>
        {automations.length > 0 && (
          <button style={{ ...pillButton('primary'), display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={onNew}><UIIcon name="add" size={15} />New automation</button>
        )}
      </div>
      {loading ? (
        <div style={styles.loading}>Loading automations…</div>
      ) : automations.length === 0 ? (
        <div style={styles.emptyState}>
          <span style={styles.emptyIcon}><UIIcon name="activity" size={27} /></span>
          <div style={styles.emptyTitle}>Put routine work on autopilot</div>
          <div style={styles.emptyText}>Create an automation by chatting with Codey, then let it run unattended.</div>
          <button style={{ ...pillButton('primary'), marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={onNew}><UIIcon name="add" size={15} />Create automation</button>
        </div>
      ) : (
        <>
          <div style={styles.listSummary}>
            <ListStat value={activeCount} label="Active" tone={C.green} />
            <ListStat value={scheduledCount} label="Scheduled" tone={C.accent} />
            <ListStat value={attentionCount} label="Need attention" tone={attentionCount ? C.yellow : C.fg3} />
          </div>
          <div style={styles.cardList}>
          {ordered.map(a => {
            const last = lastStatus[a.id]
            const health = listHealth(a, last)
            const next = a.enabled && a.schedule ? nextRunAt(a.schedule, Date.now()) : null
            return (
              <div key={a.id} style={{ ...rowStyle, opacity: a.enabled ? 1 : .76 }}>
                <span style={{ ...statusRail, background: health.color }} />
                <button style={cardMain} onClick={() => onOpen(a.id)}>
                  <span style={automationIcon(a.enabled)}><UIIcon name={a.target.kind === 'team' ? 'users' : 'activity'} size={16} /></span>
                  <span style={cardCopy}>
                    <span style={nameRow}>
                      <strong style={automationName}>{a.name}</strong>
                      <span style={statusPill(health.color)}><span style={{ ...statusDot, background: health.color }} />{health.label}</span>
                    </span>
                    <span style={scheduleLine}>
                      <UIIcon name="activity" size={12} />
                      <span>{scheduleSummary(a.schedule)}</span>
                      {a.schedule && <span style={timezoneText}>{a.schedule.tz}</span>}
                    </span>
                    <span style={targetLine}>{targetLabel(a.target)}</span>
                  </span>
                </button>
                <div style={cardAside}>
                  <div style={runRecency}>
                    <span style={runRecencyLabel}>{last ? 'Last run' : next ? 'Next run' : 'Run history'}</span>
                    <strong style={{ color: last?.status === 'failed' ? C.red : C.fg2, fontSize: 10.5 }}>
                      {last ? runStatusText(last) : next ? humanizeDelta(next - Date.now()) : 'Not run yet'}
                    </strong>
                    {last && <span style={runDate}>{new Date(last.startedAt).toLocaleString()}</span>}
                  </div>
                  <label style={enableToggle} title={a.enabled ? 'Pause automation' : 'Enable automation'}>
                    <input type="checkbox" checked={a.enabled} onChange={() => void toggle(a)} />
                    {a.enabled ? 'On' : 'Off'}
                  </label>
                  <button style={runButton} disabled={!!runningIds[a.id]} onClick={() => void runNow(a.id)}>
                    <UIIcon name="play" size={12} />{runningIds[a.id] ? 'Starting…' : 'Run'}
                  </button>
                  <button style={openButton} title="Open details" aria-label={`Open ${a.name}`} onClick={() => onOpen(a.id)}><UIIcon name="chevron" size={15} /></button>
                </div>
              </div>
            )
          })}
          </div>
        </>
      )}
    </div>
  )
}

const ListStat: React.FC<{ value: number; label: string; tone: string }> = ({ value, label, tone }) => (
  <div style={listStat}><strong style={{ color: tone, fontSize: 15 }}>{value}</strong><span>{label}</span></div>
)

function listHealth(a: Automation, last?: AutomationRun): { label: string; color: string } {
  if (!a.enabled) return { label: 'Paused', color: C.fg3 }
  if (last?.status === 'parked') return { label: 'Needs input', color: C.yellow }
  if (last?.status === 'failed') return { label: 'Needs attention', color: C.red }
  return { label: a.schedule ? 'Scheduled' : 'Ready', color: C.green }
}

function runStatusText(run: AutomationRun): string {
  if (run.reportFailure) return 'Delivery failed'
  return { success: 'Completed', failed: 'Failed', parked: 'Needs input', resumed: 'Resumed' }[run.status]
}

// ---------------------------------------------------------------------------

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', position: 'relative', overflow: 'hidden',
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13,
  boxShadow: '0 5px 14px rgba(0,0,0,0.05)',
}
const statusRail: React.CSSProperties = { width: 3, flexShrink: 0 }
const cardMain: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 11, padding: '13px 14px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'inherit' }
const automationIcon = (enabled: boolean): React.CSSProperties => ({ width: 34, height: 34, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 10, background: enabled ? C.accentDim : C.surface3, color: enabled ? C.accent : C.fg3 })
const cardCopy: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }
const nameRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }
const automationName: React.CSSProperties = { color: C.fg, fontSize: 13, fontWeight: 720, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const statusPill = (color: string): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: '2px 6px', borderRadius: 999, color, background: C.surface3, fontSize: 9, fontWeight: 700 })
const statusDot: React.CSSProperties = { width: 5, height: 5, borderRadius: 999 }
const scheduleLine: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, color: C.fg2, fontSize: 10.5, minWidth: 0 }
const timezoneText: React.CSSProperties = { color: C.fg3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const targetLine: React.CSSProperties = { color: C.fg3, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const cardAside: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, padding: '10px 11px 10px 6px' }
const runRecency: React.CSSProperties = { width: 130, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, paddingRight: 5 }
const runRecencyLabel: React.CSSProperties = { color: C.fg3, fontSize: 8.5, fontWeight: 750, textTransform: 'uppercase', letterSpacing: .45 }
const runDate: React.CSSProperties = { color: C.fg3, fontSize: 8.5, whiteSpace: 'nowrap' }
const enableToggle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, color: C.fg3, fontSize: 9.5, cursor: 'pointer', padding: '5px 6px' }
const runButton: React.CSSProperties = { ...pillButton('ghost'), display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 9px', fontSize: 10.5 }
const openButton: React.CSSProperties = { width: 28, height: 28, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 8, background: 'transparent', color: C.fg3, cursor: 'pointer' }
const listStat: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 6, color: C.fg3, fontSize: 10.5, padding: '7px 11px', borderRight: `1px solid ${C.border}` }

const styles: Record<string, React.CSSProperties> = {
  body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  errorBanner: {
    margin: '10px 20px 0', background: C.dangerBg ?? (C.red + '22'), color: C.dangerFg ?? C.red,
    padding: 10, borderRadius: 8, fontSize: 12,
  },
  list: { padding: '22px 24px', flex: 1, overflowY: 'auto', background: C.bg },
  listTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 20 },
  listTitle: { color: C.fg, fontSize: 17, fontWeight: 750, letterSpacing: '-0.02em' },
  listSub: { color: C.fg3, fontSize: 12, marginTop: 4 },
  listSummary: { display: 'inline-flex', alignItems: 'center', border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, overflow: 'hidden', marginBottom: 12 },
  cardList: { display: 'flex', flexDirection: 'column', gap: 8 },
  loading: { color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 46 },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', maxWidth: 320, margin: '70px auto 0' },
  emptyIcon: { width: 60, height: 60, display: 'grid', placeItems: 'center', borderRadius: 18, background: C.accentDim, color: C.accent, border: `1px solid ${C.accent}` },
  emptyTitle: { color: C.fg, fontSize: 15, fontWeight: 700, marginTop: 15 },
  emptyText: { color: C.fg2, fontSize: 12, lineHeight: 1.55, marginTop: 6 },
}
