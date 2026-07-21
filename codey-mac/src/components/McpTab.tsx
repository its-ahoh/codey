import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { inputStyle, pillButton, unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { parseArgsLine, parseEnvLines } from './mcp-form'
import type { ExternalMcpServer } from '../codey-api'

// Matches the toggle idiom already used by AppearanceTab / PluginsTab.
const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <div onClick={() => onChange(!on)} style={{
    width: 36, height: 20, borderRadius: 10, flexShrink: 0,
    background: on ? C.accent : C.surface3,
    border: `1px solid ${on ? C.accent : C.border2}`,
    cursor: 'pointer', position: 'relative', transition: 'all 0.2s',
  }}>
    <div style={{
      position: 'absolute', top: 1, left: on ? 17 : 1,
      width: 16, height: 16, borderRadius: '50%', background: '#fff',
      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    }}/>
  </div>
)

interface FormState {
  name: string
  transport: 'stdio' | 'remote'
  command: string
  args: string
  env: string
  url: string
}

const EMPTY_FORM: FormState = { name: '', transport: 'stdio', command: '', args: '', env: '', url: '' }

const toForm = (server: ExternalMcpServer): FormState => ({
  name: server.name,
  transport: server.transport,
  command: server.command ?? '',
  args: (server.args ?? []).join(' '),
  env: Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  url: server.url ?? '',
})

export const McpTab: React.FC = () => {
  const [servers, setServers] = useState<ExternalMcpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setServers(unwrap(await window.codey.mcp.list()))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggle = async (server: ExternalMcpServer) => {
    setBusy(server.name)
    setError(null)
    try {
      unwrap(await window.codey.mcp.setEnabled(server.name, !server.enabled))
      await reload()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (server: ExternalMcpServer) => {
    if (!window.confirm(`Remove MCP server "${server.name}"?`)) return
    setBusy(server.name)
    setError(null)
    try {
      unwrap(await window.codey.mcp.remove(server.name))
      await reload()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!form) return
    const name = form.name.trim()
    // Adding under an existing name would silently overwrite (and disable) it.
    if (!editing && servers.some(s => s.name === name)) {
      setError(`A server named "${name}" already exists — edit it instead.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const env = parseEnvLines(form.env)
      const existing = editing ? servers.find(s => s.name === editing) : undefined
      unwrap(await window.codey.mcp.save({
        name,
        transport: form.transport,
        command: form.command,
        args: parseArgsLine(form.args),
        env,
        url: form.url,
        enabled: existing?.enabled ?? false,
      }))
      setForm(null)
      setEditing(null)
      await reload()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading && servers.length === 0) return <div style={styles.note}>Loading MCP servers…</div>

  return (
    <div>
      <div style={styles.intro}>
        External MCP servers give agents extra tools. Enabled servers are passed to every
        task-performing agent run. Remote servers are not passed to Codex (no remote MCP support).
      </div>
      {error && <div style={styles.errorBanner}>{error}</div>}

      {servers.map(server => (
        <div key={server.name} style={styles.card}>
          <div style={styles.cardIcon}><UIIcon name="server" size={18} /></div>
          <div style={styles.cardBody}>
            <div style={styles.cardName}>
              {server.name}
              <span style={styles.badge}>{server.transport}</span>
            </div>
            <div style={styles.cardDesc}>
              {server.transport === 'remote'
                ? server.url
                : [server.command, ...(server.args ?? [])].join(' ')}
            </div>
          </div>
          <button
            style={pillButton('ghost')}
            onClick={() => { setForm(toForm(server)); setEditing(server.name) }}
          >Edit</button>
          <button
            style={pillButton('danger')}
            disabled={busy === server.name}
            onClick={() => void remove(server)}
          ><UIIcon name="trash" size={13} /></button>
          <div style={busy === server.name ? styles.toggleBusy : undefined}>
            <Toggle on={server.enabled} onChange={() => { if (busy !== server.name) void toggle(server) }} />
          </div>
        </div>
      ))}

      {servers.length === 0 && !form && (
        <div style={styles.empty}>No external MCP servers yet. Add one to get started.</div>
      )}

      {form ? (
        <div style={styles.form}>
          <div style={styles.formTitle}>{editing ? `Edit ${editing}` : 'Add MCP server'}</div>
          <label style={styles.label}>Name
            <input
              style={inputStyle}
              value={form.name}
              disabled={!!editing}
              placeholder="github"
              onChange={e => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label style={styles.label}>Transport
            <div style={styles.transportRow}>
              {(['stdio', 'remote'] as const).map(t => (
                <button
                  key={t}
                  style={{ ...styles.transportBtn, ...(form.transport === t ? styles.transportBtnActive : null) }}
                  onClick={() => setForm({ ...form, transport: t })}
                >{t === 'stdio' ? 'Local (stdio)' : 'Remote (URL)'}</button>
              ))}
            </div>
          </label>
          {form.transport === 'stdio' ? (
            <>
              <label style={styles.label}>Command
                <input
                  style={inputStyle}
                  value={form.command}
                  placeholder="npx"
                  onChange={e => setForm({ ...form, command: e.target.value })}
                />
              </label>
              <label style={styles.label}>Arguments (space-separated)
                <input
                  style={inputStyle}
                  value={form.args}
                  placeholder="-y @modelcontextprotocol/server-github"
                  onChange={e => setForm({ ...form, args: e.target.value })}
                />
              </label>
              <label style={styles.label}>Environment (one KEY=VALUE per line)
                <textarea
                  style={{ ...inputStyle, minHeight: 64, resize: 'vertical', fontFamily: 'monospace' }}
                  value={form.env}
                  placeholder={'GITHUB_TOKEN=ghp_...'}
                  onChange={e => setForm({ ...form, env: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label style={styles.label}>URL
              <input
                style={inputStyle}
                value={form.url}
                placeholder="https://mcp.example.com/sse"
                onChange={e => setForm({ ...form, url: e.target.value })}
              />
            </label>
          )}
          <div style={styles.formActions}>
            <button style={pillButton('primary')} disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button style={pillButton('ghost')} disabled={saving} onClick={() => { setForm(null); setEditing(null) }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button style={styles.addBtn} onClick={() => { setForm(EMPTY_FORM); setEditing(null) }}>
          <UIIcon name="add" size={15} /> Add MCP server
        </button>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  note: { color: C.fg3, fontSize: 12, padding: 8 },
  intro: { color: C.fg2, fontSize: 12, marginBottom: 14 },
  errorBanner: {
    background: C.dangerBg, color: C.dangerFg, border: `1px solid ${C.dangerBorder}`,
    padding: '9px 11px', borderRadius: 9, marginBottom: 14, fontSize: 12,
  },
  card: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
    border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface2, marginBottom: 10,
  },
  cardIcon: { color: C.accent, flexShrink: 0 },
  cardBody: { flex: 1, minWidth: 0 },
  cardName: { color: C.fg, fontSize: 13, fontWeight: 700, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 8 },
  cardDesc: {
    color: C.fg3, fontSize: 11.5, lineHeight: 1.45, fontFamily: 'monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  badge: {
    fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
    color: C.fg3, border: `1px solid ${C.border2}`, borderRadius: 5, padding: '1px 6px',
  },
  toggleBusy: { opacity: 0.5, cursor: 'wait', pointerEvents: 'none' },
  empty: { color: C.fg3, fontSize: 12, padding: '18px 0', textAlign: 'center' },
  form: {
    border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface2,
    padding: '14px 16px', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10,
  },
  formTitle: { color: C.fg, fontSize: 13, fontWeight: 700 },
  label: { color: C.fg2, fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 4 },
  transportRow: { display: 'flex', gap: 8 },
  transportBtn: {
    padding: '6px 12px', borderRadius: 8, border: `1px solid ${C.border2}`,
    background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 12,
  },
  transportBtnActive: { background: C.accentDim, color: C.fg, border: `1px solid ${C.accent}` },
  formActions: { display: 'flex', gap: 8, marginTop: 4 },
  addBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4,
    border: `1px dashed ${C.border2}`, borderRadius: 10, padding: '9px 14px',
    background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 12, fontWeight: 650,
  },
}
