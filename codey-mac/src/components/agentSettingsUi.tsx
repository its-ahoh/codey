import React from 'react'
import { C } from '../theme'
import { UIIcon } from './UIIcons'

/**
 * The shared visual vocabulary of Settings ▸ Agents.
 *
 * The page had grown one style per feature — a flat bordered box per agent, a
 * grey 12px caption for one control and a white 13px label for the next, an
 * env editor with its own caption, buttons at three sizes. Everything here is
 * the same three shapes instead: an agent is a card, a setting is a row inside
 * it, and an action is a 28px icon button. Anything added later should reach
 * for these rather than invent a fourth.
 */

/** One agent. Header strip carries identity and actions; the body carries settings. */
export const cardStyle: React.CSSProperties = {
  marginBottom: 12, borderRadius: 12, overflow: 'hidden',
  background: C.surface2, border: `1px solid ${C.border2}`,
}
export const cardHeadStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '11px 14px', background: C.surface3, borderBottom: `1px solid ${C.border}`,
}
export const cardBodyStyle: React.CSSProperties = { padding: '0 14px' }

/** A setting: label (plus optional hint) on the left, one control on the right.
 *  The divider belongs to the row, so the last one drops it. */
export const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '11px 0', borderBottom: `1px solid ${C.border}`,
}
export const lastRowStyle: React.CSSProperties = { ...rowStyle, borderBottom: 'none' }
export const rowLabelStyle: React.CSSProperties = { color: C.fg, fontSize: 13 }
export const rowHintStyle: React.CSSProperties = { color: C.fg3, fontSize: 11, lineHeight: 1.45, marginTop: 3 }

/** Every action on this page is a square icon button; only the tint changes. */
export const iconButtonStyle = (opts: { accent?: boolean; danger?: boolean; disabled?: boolean } = {}): React.CSSProperties => ({
  display: 'grid', placeItems: 'center', width: 28, height: 28, padding: 0, flexShrink: 0,
  borderRadius: 8, cursor: opts.disabled ? 'default' : 'pointer', background: 'transparent',
  border: `1px solid ${opts.accent ? C.accent : opts.danger ? C.red + '55' : C.border2}`,
  color: opts.accent ? C.accent : opts.danger ? C.red : C.fg2,
  opacity: opts.disabled ? 0.45 : 1,
})

/** Text button for the one place a label is needed — the page-level Recheck. */
export const textButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 9px', fontSize: 12,
  background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`,
  borderRadius: 7, cursor: 'pointer',
}

/**
 * Whether the gateway will find this agent's CLI: probe in flight, installed,
 * or missing. The installed pill carries the resolved path as its tooltip, so
 * a stale binary on PATH is diagnosable without leaving the panel.
 */
export const AgentInstallChip: React.FC<{
  status?: { installed: boolean; path?: string }
  checking: boolean
  onInstall: () => void
}> = ({ status, checking, onInstall }) => {
  if (!status) {
    return <span style={{ color: C.fg3, fontSize: 11 }}>{checking ? 'checking…' : ''}</span>
  }
  if (status.installed) {
    return (
      <span
        title={status.path ? `Found at ${status.path}` : undefined}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, boxSizing: 'border-box',
          color: C.green, fontSize: 11, fontWeight: 600, padding: '0 10px', borderRadius: 8,
          background: 'rgba(52,199,89,0.12)', border: '1px solid rgba(52,199,89,0.35)',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 3, background: C.green }} />
        Installed
      </span>
    )
  }
  return (
    <button
      onClick={onInstall}
      title="Open the install instructions in your browser"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, boxSizing: 'border-box',
        color: C.warningFg, fontSize: 11, fontWeight: 600, padding: '0 10px', borderRadius: 8,
        background: 'rgba(255,159,10,0.12)', border: '1px solid rgba(255,159,10,0.35)',
        cursor: 'pointer',
      }}
    >
      Install
      <UIIcon name="link" size={11} />
    </button>
  )
}

const envInputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 8,
  color: C.fg, fontSize: 12, padding: '0 10px', height: 28, outline: 'none',
  boxSizing: 'border-box', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

/**
 * A KEY=VALUE list passed to the spawned CLI. Rows commit upward on every
 * edit; the parent persists with one IPC call. An empty key removes the row,
 * which is how a row is cleared without a delete.
 */
export const AgentEnvEditor: React.FC<{
  env: Record<string, string>
  onChange: (next: Record<string, string>) => void | Promise<void>
}> = ({ env, onChange }) => {
  // Local draft state preserves row order while the user is editing — using
  // the parent's record directly would re-sort on every keystroke because
  // object key order isn't stable across rebuilds.
  const [draft, setDraft] = React.useState<Array<{ k: string; v: string }>>(() =>
    Object.entries(env).map(([k, v]) => ({ k, v }))
  )
  // Resync when the parent's env actually changes (e.g. on reload), without
  // wiping in-flight edits when our own commit echoes back.
  React.useEffect(() => {
    const current = Object.fromEntries(
      draft.filter(r => r.k.trim().length > 0).map(r => [r.k.trim(), r.v])
    )
    const isSame = JSON.stringify(current) === JSON.stringify(env)
    if (!isSame) setDraft(Object.entries(env).map(([k, v]) => ({ k, v })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(env)])

  const commit = (rows: Array<{ k: string; v: string }>) => {
    const next: Record<string, string> = {}
    for (const r of rows) {
      const k = r.k.trim()
      if (k) next[k] = r.v
    }
    void onChange(next)
  }

  const updateRow = (idx: number, patch: Partial<{ k: string; v: string }>) => {
    const next = draft.map((r, i) => i === idx ? { ...r, ...patch } : r)
    setDraft(next)
    commit(next)
  }
  const removeRow = (idx: number) => {
    const next = draft.filter((_, i) => i !== idx)
    setDraft(next)
    commit(next)
  }
  const addRow = () => setDraft([...draft, { k: '', v: '' }])

  return (
    <div style={{ ...lastRowStyle, alignItems: 'stretch', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={rowLabelStyle}>Environment</div>
          <div style={rowHintStyle}>Variables passed to the spawned CLI.</div>
        </div>
        <button onClick={addRow} style={iconButtonStyle()} title="Add variable" aria-label="Add variable">
          <UIIcon name="add" size={14} />
        </button>
      </div>
      {draft.map((row, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 6 }}>
          <input
            value={row.k}
            onChange={e => updateRow(idx, { k: e.target.value })}
            placeholder="KEY"
            spellCheck={false}
            style={{ ...envInputStyle, flex: '0 0 180px' }}
          />
          <input
            value={row.v}
            onChange={e => updateRow(idx, { v: e.target.value })}
            placeholder="value"
            spellCheck={false}
            style={{ ...envInputStyle, flex: 1, minWidth: 0 }}
          />
          <button
            onClick={() => removeRow(idx)}
            style={iconButtonStyle({ danger: true })}
            title="Remove"
            aria-label="Remove variable"
          >
            <UIIcon name="trash" size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
