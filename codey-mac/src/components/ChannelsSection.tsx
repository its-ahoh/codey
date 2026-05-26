import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'

// Mirrors the renderer-side channel config shape. Kept local since this is
// the only consumer.
interface ChannelsCfg {
  telegram?: { enabled: boolean; botToken: string }
  discord?:  { enabled: boolean; botToken: string }
  imessage?: { enabled: boolean; allowedSenders?: string[]; pollIntervalMs?: number }
}

const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
const pillButton = (variant: 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: C.surface3, color: C.fg2,
})

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

interface ChannelField {
  label: string
  value: string
  secret?: boolean
  onChange: (next: string) => boolean | void
}

const ChannelEditor: React.FC<{
  label: string
  enabled: boolean
  liveStatus?: 'connected' | 'disabled'
  onToggle: (enabled: boolean) => Promise<void> | void
  fields: ChannelField[]
  note?: string
  confirmMessage?: string
}> = ({ label, enabled, liveStatus, onToggle, fields, note, confirmMessage }) => {
  const [open, setOpen] = useState(false)
  const [drafts, setDrafts] = useState<string[]>(fields.map(f => f.value))
  useEffect(() => { setDrafts(fields.map(f => f.value)) }, [fields.map(f => f.value).join('|')])

  const isDirty = drafts.some((d, i) => d !== fields[i]?.value)

  const handleSave = () => {
    const msg = confirmMessage ?? `Save changes to ${label} configuration?`
    if (!window.confirm(msg)) return
    for (let i = 0; i < fields.length; i++) {
      if (drafts[i] !== fields[i].value) {
        fields[i].onChange(drafts[i] ?? '')
      }
    }
  }

  return (
    <div style={{
      background: C.surface2, border: `1px solid ${C.border}`,
      borderRadius: 8, marginBottom: 8, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10}}>
          <span style={{ color: C.fg, fontSize: 13, flex: 0.3 }}>{label}</span>
          {(fields.length > 0 || note) && (
            <button
            onClick={() => setOpen(o => !o)}
            style={{ ...pillButton('ghost'), padding: '2px 8px', fontSize: 11, flex: 0.7 }}>
              {open ? 'Hide' : 'Configure'}
            </button>
          )}
          {liveStatus && (
            <span style={{
              alignSelf: 'flex-end',
              fontSize: 10, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
              color: liveStatus === 'connected' ? C.green : C.fg3,
            }}>
              {liveStatus === 'connected' ? '● Connected' : '○ Off'}
            </span>
          )}
        </div>

        <Toggle on={enabled} onChange={v => { void onToggle(v) }}/>
      </div>
      {open && (
        <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${C.border}` }}>
          {note && <div style={{ color: C.fg3, fontSize: 11, padding: '10px 0' }}>{note}</div>}
          {fields.map((f, i) => (
            <div key={f.label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center', marginTop: 10 }}>
              <label style={{ color: C.fg3, fontSize: 12 }}>{f.label}</label>
              <input
                type={f.secret ? 'password' : 'text'}
                value={drafts[i] ?? ''}
                onChange={e => setDrafts(d => { const n = d.slice(); n[i] = e.target.value; return n })}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              disabled={!isDirty}
              onClick={handleSave}
              style={{
                padding: '6px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                border: 'none', cursor: isDirty ? 'pointer' : 'default',
                background: isDirty ? C.accent : C.surface3,
                color: isDirty ? '#fff' : C.fg3,
                opacity: isDirty ? 1 : 0.5,
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const unwrap = <T,>(r: { ok: boolean; data?: T; error?: string }): T => {
  if (!r?.ok) throw new Error(r?.error ?? 'IPC failed')
  return r.data as T
}

export interface ChannelsSectionProps {
  liveStatus?: { telegram?: boolean; discord?: boolean; imessage?: boolean }
  isGatewayRunning: boolean
}

export const ChannelsSection: React.FC<ChannelsSectionProps> = ({ liveStatus, isGatewayRunning }) => {
  const [channels, setChannels] = useState<ChannelsCfg>({})
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const cfg = unwrap(await window.codey.config.get())
      setChannels((cfg as any)?.channels ?? {})
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { if (isGatewayRunning) reload() }, [isGatewayRunning, reload])

  if (!isGatewayRunning) return null

  // ConfigManager.update() does Object.assign on channels, so we must send
  // the full per-channel object rather than a partial — otherwise omitted
  // fields would be wiped.
  const persist = async (next: ChannelsCfg, key: keyof ChannelsCfg) => {
    setChannels(next)
    const patch: any = { [key]: next[key] }
    await unwrap(await window.codey.config.set({ channels: patch }))
  }
  const setTelegram = (patch: Partial<NonNullable<ChannelsCfg['telegram']>>) => {
    const cur = channels.telegram ?? { enabled: false, botToken: '' }
    return persist({ ...channels, telegram: { ...cur, ...patch } }, 'telegram')
  }
  const setDiscord = (patch: Partial<NonNullable<ChannelsCfg['discord']>>) => {
    const cur = channels.discord ?? { enabled: false, botToken: '' }
    return persist({ ...channels, discord: { ...cur, ...patch } }, 'discord')
  }
  const setIMessage = (patch: Partial<NonNullable<ChannelsCfg['imessage']>>) => {
    const cur = channels.imessage ?? { enabled: false, allowedSenders: [] }
    return persist({ ...channels, imessage: { ...cur, ...patch } }, 'imessage')
  }

  const liveLabel = (active?: boolean): 'connected' | 'disabled' =>
    active ? 'connected' : 'disabled'

  return (
    <div>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}
      <ChannelEditor
        label="Telegram"
        enabled={!!channels.telegram?.enabled}
        liveStatus={liveLabel(liveStatus?.telegram)}
        onToggle={enabled => {
          if (enabled && !channels.telegram?.botToken) {
            setError('Add a Bot Token before enabling Telegram.')
            return
          }
          setError(null)
          return setTelegram({ enabled })
        }}
        fields={[
          { label: 'Bot Token', value: channels.telegram?.botToken ?? '', secret: true,
            onChange: v => { setTelegram({ botToken: v }) } },
        ]}
        confirmMessage="Changing the Bot Token will disconnect all linked Telegram chats. Users will need to re-pair. Save?"
        note={!channels.telegram?.botToken ? 'A Bot Token is required to enable Telegram.' : undefined}
      />
      <ChannelEditor
        label="Discord"
        enabled={!!channels.discord?.enabled}
        liveStatus={liveLabel(liveStatus?.discord)}
        onToggle={enabled => setDiscord({ enabled })}
        fields={[
          { label: 'Bot Token', value: channels.discord?.botToken ?? '', secret: true,
            onChange: v => { setDiscord({ botToken: v }) } },
        ]}
        confirmMessage="Changing the Bot Token will disconnect all linked Discord chats. Users will need to re-pair. Save?"
      />
      <ChannelEditor
        label="iMessage"
        enabled={!!channels.imessage?.enabled}
        liveStatus={liveLabel(liveStatus?.imessage)}
        onToggle={enabled => {
          const senders = channels.imessage?.allowedSenders ?? []
          if (enabled && senders.length === 0) {
            setError('Add at least one Allowed Sender before enabling iMessage.')
            return
          }
          setError(null)
          return setIMessage({ enabled })
        }}
        fields={[
          { label: 'Allowed Senders', value: (channels.imessage?.allowedSenders ?? []).join(', '),
            onChange: v => {
              const senders = v.split(',').map(s => s.trim()).filter(Boolean)
              setIMessage({ allowedSenders: senders })
            } },
        ]}
        confirmMessage="Save iMessage configuration?"
        note="Phone numbers or Apple IDs (comma-separated, e.g. +8613800138000)."
      />
    </div>
  )
}
