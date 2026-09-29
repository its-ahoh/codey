import { BotCreationGuide } from './BotCreationGuide'
import { useEffect, useState, useCallback, useRef } from 'react'
import { apiService, BotDto } from '../services/api'
import { AvatarPicker } from './AvatarPicker'
import { BotAvatar } from './BotAvatar'
import { resolveBotAvatar } from './botAvatarModel'
import { C } from '../theme'

type Mode = { kind: 'idle' } | { kind: 'select'; name: string } | { kind: 'create' }

export default function BotsTab({ initialName }: { initialName?: string }) {
  const [bots, setBots] = useState<BotDto[]>([])
  const [mode, setMode] = useState<Mode>(initialName ? { kind: 'select', name: initialName } : { kind: 'idle' })
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setBots(await apiService.listBots())
  }, [])

  useEffect(() => { reload() }, [reload])

  const selected = mode.kind === 'select' ? bots.find(w => w.name === mode.name) : undefined

  return (
    <div style={{ display: 'flex', height: '100%', background: C.bg, color: C.fg }}>
      <div style={{ width: 240, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {bots.map(w => (
            <button key={w.name} disabled={loading} onClick={() => setMode({ kind: 'select', name: w.name })}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', background: mode.kind === 'select' && mode.name === w.name ? C.surface2 : 'transparent', border: 'none', color: C.fg, cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><BotAvatar name={w.name} config={w.config.avatar} /><strong>{w.config.displayName || w.name}</strong></div>
              <div style={{ fontSize: 11, color: C.fg3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.personality.role}</div>
            </button>
          ))}
        </div>
        <button disabled={loading} onClick={() => setMode({ kind: 'create' })} style={{ margin: 12, padding: '8px 12px', background: C.accent, color: C.onAccent, border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>+ New Bot</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {mode.kind === 'idle' && <EmptyState />}
        {mode.kind === 'create' && <CreatePanel loading={loading} setLoading={setLoading} onCreated={async (w) => { await reload(); setMode({ kind: 'select', name: w.name }) }} onCancel={() => setMode({ kind: 'idle' })} />}
        {mode.kind === 'select' && selected && <EditorPanel key={selected.name} bot={selected}
          onSaved={reload}
          onDeleted={async () => { await reload(); setMode({ kind: 'idle' }) }} />}
      </div>
    </div>
  )
}

function EmptyState() {
  return <div style={{ padding: 40, color: C.fg3 }}>Select a bot on the left, or create a new one.</div>
}

function CreatePanel({ loading, setLoading, onCreated, onCancel }: { loading: boolean; setLoading: (b: boolean) => void; onCreated: (w: BotDto) => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const submit = async (prompt: string) => {
    if (!prompt.trim() || loading) return
    setLoading(true); setError(null)
    try {
      const bot = await apiService.generateBot(prompt)
      window.dispatchEvent(new Event('codey:bots-changed'))
      await onCreated(bot)
    } catch (err: any) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }
  return <div style={{ padding: 20, maxWidth: 640 }}>
    <BotCreationGuide busy={loading} error={error} onCreate={submit} onCancel={onCancel} />
  </div>
}

function EditorPanel({ bot, onSaved, onDeleted }: { bot: BotDto; onSaved: (name: string) => void; onDeleted: () => void }) {
  const [avatar, setAvatar] = useState(() => resolveBotAvatar(bot.name, bot.config.avatar))
  const [name, setName] = useState(bot.config.displayName || bot.name)
  const [editingName, setEditingName] = useState(false)
  const [role, setRole] = useState(bot.personality.role)
  const [soul, setSoul] = useState(bot.personality.soul)
  const [instructions, setInstructions] = useState(bot.personality.instructions)
  const [toolsText, setToolsText] = useState(bot.config.tools.join(', '))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const cancelNameEdit = useRef(false)
  const saveQueue = useRef(Promise.resolve())
  const revision = useRef(0)
  const snapshot = (nextAvatar = avatar) => ({
    personality: { role, soul, instructions },
    config: {
      ...bot.config,
      displayName: name.trim() || bot.config.displayName || bot.name,
      avatar: nextAvatar,
      tools: toolsText.split(',').map(s => s.trim()).filter(Boolean),
    },
  })
  const lastSaved = useRef(JSON.stringify(snapshot()))
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const save = (nextAvatar = avatar) => {
    const body = snapshot(nextAvatar)
    const serialized = JSON.stringify(body)
    const currentRevision = ++revision.current
    // Serialize writes so a slower earlier blur cannot overwrite a newer edit.
    saveQueue.current = saveQueue.current.then(async () => {
      if (serialized === lastSaved.current) return
      if (mounted.current) { setSaving(true); setSaved(false); setError(null) }
      await apiService.updateBot(bot.name, body)
      lastSaved.current = serialized
      window.dispatchEvent(new Event('codey:bots-changed'))
      await onSaved(bot.name)
    }).then(() => {
      if (mounted.current && currentRevision === revision.current) {
        setSaving(false); setSaved(true); setError(null)
      }
    }).catch((err: unknown) => {
      if (mounted.current && currentRevision === revision.current) {
        setSaving(false); setSaved(false)
        setError(err instanceof Error ? err.message : String(err))
      }
    })
  }

  const confirmDelete = async () => {
    if (!confirm(`Delete bot "${bot.config.displayName || bot.name}"? This also removes it from any team that references it.`)) return
    try {
      // Clicking Delete first blurs the active field; let that save finish.
      await saveQueue.current
      await apiService.deleteBot(bot.name)
      onDeleted()
    } catch (err: any) { setError(err.message || String(err)) }
  }

  const fieldStyle = { width: '100%', padding: 10, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' as const }
  const labelStyle = { display: 'block', fontSize: 11, color: C.fg3, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginTop: 16, marginBottom: 6 }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <AvatarPicker name={bot.name} value={avatar} onChange={value => { setAvatar(value); save(value) }} />
          {editingName
            ? <input autoFocus value={name} aria-label="Bot display name"
                onChange={e => { setName(e.target.value); setSaved(false) }}
                onBlur={() => {
                  setEditingName(false)
                  if (cancelNameEdit.current) { cancelNameEdit.current = false; return }
                  setName(name.trim() || bot.config.displayName || bot.name)
                  save()
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    e.currentTarget.blur()
                  }
                  if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                    cancelNameEdit.current = true
                    setName(bot.config.displayName || bot.name)
                    e.currentTarget.blur()
                  }
                }}
                style={{ fontSize: 18, fontWeight: 600, padding: '2px 6px', background: C.surface2, color: C.fg, border: `1px solid ${C.accent}`, borderRadius: 6, fontFamily: 'inherit', minWidth: 0 }} />
            : <button type="button" onClick={() => setEditingName(true)} title="Rename" aria-label={`Rename ${name}`}
                style={{ fontSize: 18, fontWeight: 600, padding: '2px 6px', margin: '0 -6px', background: 'transparent', color: C.fg, border: 'none', borderRadius: 6, cursor: 'text', fontFamily: 'inherit', textAlign: 'left' }}>
                {name}</button>}
        </div>
        <button onClick={confirmDelete} style={{ background: 'transparent', color: C.dangerFg, border: `1px solid ${C.dangerBorder}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Delete</button>
      </div>
      {error && <div role="alert" style={{ background: C.dangerBg, border: `1px solid ${C.dangerBorder}`, color: C.dangerFg, padding: 10, borderRadius: 6, fontSize: 12 }}>{error}</div>}

      <label style={labelStyle}>Role</label>
      <textarea value={role} onChange={e => { setRole(e.target.value); setSaved(false) }} onBlur={() => save()} style={{ ...fieldStyle, minHeight: 60 }} />

      <label style={labelStyle}>Soul</label>
      <textarea value={soul} onChange={e => { setSoul(e.target.value); setSaved(false) }} onBlur={() => save()} style={{ ...fieldStyle, minHeight: 90 }} />

      <label style={labelStyle}>Instructions</label>
      <textarea value={instructions} onChange={e => { setInstructions(e.target.value); setSaved(false) }} onBlur={() => save()} style={{ ...fieldStyle, minHeight: 140 }} />

      <label style={labelStyle}>Tools (comma-separated)</label>
      <input value={toolsText} onChange={e => { setToolsText(e.target.value); setSaved(false) }} onBlur={() => save()} style={fieldStyle} />

      <div role="status" aria-live="polite" style={{ marginTop: 16, minHeight: 18, fontSize: 12, color: C.fg3 }}>
        {saving ? 'Saving…' : saved ? 'Saved' : 'Changes save automatically when you leave a field.'}
      </div>
    </div>
  )
}
