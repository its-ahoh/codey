import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { OverlayWindow } from './OverlayWindow'
import { pillButton, unwrap } from './settingsAtoms'
import { scheduleSummary } from './automationsModel'
import { AutomationChatCreate } from './AutomationChatCreate'
import { AutomationOnePager } from './AutomationOnePager'
import { UIIcon } from './UIIcons'
import type { Automation, AutomationRun, AutomationTarget } from '../../../packages/core/src/types/automation'

interface Props { onClose: () => void }

type Panel =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'chat-edit'; id: string }
  | { kind: 'view'; id: string }

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
              onCancel={() => setPanel(panel.kind === 'chat-edit' ? { kind: 'view', id: panel.id } : { kind: 'list' })}
              setError={setError}
            />
          )}
          {panel.kind === 'view' && (
            <AutomationOnePager
              key={panel.id}
              id={panel.id}
              onEditInChat={() => setPanel({ kind: 'chat-edit', id: panel.id })}
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
  setError: (e: string | null) => void
}

const AutomationList: React.FC<ListProps> = ({ automations, loading, onRefresh, onNew, onOpen, setError }) => {
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
    <div style={styles.list}>
      <div style={styles.listTop}>
        <div><div style={styles.listTitle}>Automations</div><div style={styles.listSub}>Let Codey run routine work on a schedule.</div></div>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {automations.map(a => {
            const last = lastStatus[a.id]
            return (
              <div key={a.id} style={{ ...rowStyle, borderColor: a.enabled ? C.border2 : C.border }}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={() => void toggle(a)}
                  title={a.enabled ? 'Enabled' : 'Disabled'}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpen(a.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: a.enabled ? C.accentDim : C.surface3, color: a.enabled ? C.accent : C.fg3 }}><UIIcon name="activity" size={15} /></span>
                    <span style={{ color: C.fg, fontSize: 13, fontWeight: 600 }}>{a.name}</span>
                    <span style={{ color: C.fg3, fontSize: 11 }}>{scheduleSummary(a.schedule)}</span>
                  </div>
                  <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{targetLabel(a.target)}</div>
                  {last && (
                    <div style={{ color: last.status === 'failed' ? C.red : C.fg3, fontSize: 11, marginTop: 2 }}>
                      last run: {last.status}{last.reportFailure ? ' - report delivery failed' : ''}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button style={pillButton('ghost')} onClick={() => onOpen(a.id)}>Details</button>
                  <button style={{ ...pillButton('ghost'), display: 'inline-flex', alignItems: 'center', gap: 5 }} disabled={!!runningIds[a.id]} onClick={() => void runNow(a.id)}>
                    <UIIcon name="play" size={13} />{runningIds[a.id] ? 'Running…' : 'Run'}
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

const rowStyle: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'flex-start',
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13,
  padding: '14px 15px', boxShadow: '0 5px 14px rgba(0,0,0,0.06)',
}

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
  loading: { color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 46 },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', maxWidth: 320, margin: '70px auto 0' },
  emptyIcon: { width: 60, height: 60, display: 'grid', placeItems: 'center', borderRadius: 18, background: C.accentDim, color: C.accent, border: `1px solid ${C.accent}` },
  emptyTitle: { color: C.fg, fontSize: 15, fontWeight: 700, marginTop: 15 },
  emptyText: { color: C.fg2, fontSize: 12, lineHeight: 1.55, marginTop: 6 },
}
