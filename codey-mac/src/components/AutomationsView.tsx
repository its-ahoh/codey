import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { OverlayWindow } from './OverlayWindow'
import { pillButton, unwrap } from './settingsAtoms'
import { scheduleSummary } from './automationsModel'
import { AutomationChatCreate } from './AutomationChatCreate'
import { AutomationOnePager } from './AutomationOnePager'
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
            Create one by chatting with Codey - it will pin down every detail, then run unattended.
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
                <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpen(a.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                  <button style={pillButton('ghost')} onClick={() => onOpen(a.id)}>Open</button>
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

const rowStyle: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'flex-start',
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
  padding: '12px 14px',
}

const styles: Record<string, React.CSSProperties> = {
  body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  errorBanner: {
    margin: '10px 20px 0', background: C.dangerBg ?? (C.red + '22'), color: C.dangerFg ?? C.red,
    padding: 10, borderRadius: 8, fontSize: 12,
  },
}
