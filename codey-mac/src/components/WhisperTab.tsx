import React, { useState, useEffect, useCallback, useRef } from 'react'
import { C } from '../theme'

interface WhisperTabProps {
  isGatewayRunning: boolean
}

interface VoiceCfg {
  enabled: boolean
  hotkey: string
  language: string
  injection: 'paste' | 'ax'
  provider: 'api' | 'local'
  apiUrl: string
  apiKey: string
  apiModel: string
  localModel: string
}

const VOICE_DEFAULT: VoiceCfg = {
  enabled: false,
  hotkey: 'Fn',
  language: 'auto',
  injection: 'paste',
  provider: 'api',
  apiUrl: 'https://api.openai.com/v1',
  apiKey: '',
  apiModel: 'whisper-1',
  localModel: 'openai_whisper-large-v3_turbo_954MB',
}

// Values must match real folder names in argmaxinc/whisperkit-coreml on HF.
// The helper strips the `openai_whisper-` prefix before passing to WhisperKit.
const LOCAL_MODELS: Array<{ value: string; label: string; note: string }> = [
  { value: 'openai_whisper-large-v3_turbo_954MB', label: 'large-v3 turbo · 954MB (recommended)', note: '量化版, 速度=small, 质量≈large, 多语言' },
  { value: 'openai_whisper-large-v3_turbo', label: 'large-v3 turbo · ~1.6GB', note: '全精度 turbo, 质量最佳' },
  { value: 'openai_whisper-large-v3', label: 'large-v3 · ~3GB (full precision)', note: '原版 large-v3, 最准但最慢, 不是 turbo' },
  { value: 'openai_whisper-large-v3-v20240930_turbo_632MB', label: 'large-v3 turbo · Sep 2024 · 632MB', note: '更小的量化 turbo, 中文略弱' },
  { value: 'openai_whisper-small_216MB', label: 'small · 216MB', note: '量化版, 中等质量, 中文一般' },
  { value: 'openai_whisper-small', label: 'small · ~480MB', note: '全精度 small' },
  { value: 'openai_whisper-base', label: 'base · ~150MB', note: '低质量, 仅作 quick test' },
  { value: 'openai_whisper-tiny', label: 'tiny · ~75MB', note: '最小, 中文几乎不可用' },
]

const VOICE_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
]

// ── Style atoms ─────────────────────────────────────────────────────

const sectionStyle: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase', marginTop: 22, marginBottom: 8,
}
const fieldStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 0', borderBottom: `1px solid ${C.border}`,
}
const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red + '22' : C.surface3,
  color: variant === 'primary' ? '#fff' : variant === 'danger' ? C.red : C.fg2,
})

const Section: React.FC<{ title: string; right?: React.ReactNode }> = ({ title, right }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...sectionStyle }}>
    <span>{title}</span>
    {right}
  </div>
)

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

// ── Hotkey recorder ─────────────────────────────────────────────────

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])
const LOCK_KEYS = new Set(['CapsLock', 'NumLock', 'ScrollLock'])

function formatKeyCombo(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key) || LOCK_KEYS.has(e.key)) return null

  const parts: string[] = []
  if (e.metaKey) parts.push('⌘')
  if (e.ctrlKey) parts.push('⌃')
  if (e.altKey) parts.push('⌥')
  if (e.shiftKey) parts.push('⇧')

  const keyMap: Record<string, string> = {
    ' ': 'Space', 'ArrowUp': '↑', 'ArrowDown': '↓',
    'ArrowLeft': '←', 'ArrowRight': '→', 'Backspace': '⌫',
    'Delete': '⌦', 'Enter': '↵', 'Tab': '⇥', 'Escape': '⎋',
  }
  const keyLabel = keyMap[e.key] ?? e.key.toUpperCase()
  parts.push(keyLabel)

  return parts.join('')
}

function formatHotkeyString(hotkey: string): string {
  if (!hotkey) return ''
  if (/[⌘⌃⌥⇧]/.test(hotkey)) return hotkey

  const parts = hotkey.split('+').map(s => s.trim())
  const result: string[] = []
  let mainKey = ''

  for (const p of parts) {
    switch (p.toLowerCase()) {
      case 'meta': case 'cmd': case 'command': result.push('⌘'); break
      case 'ctrl': case 'control': result.push('⌃'); break
      case 'alt': case 'option': result.push('⌥'); break
      case 'shift': result.push('⇧'); break
      default: mainKey = p; break
    }
  }
  if (mainKey) result.push(mainKey)
  return result.join('')
}

const HotkeyRecorder: React.FC<{
  value: string
  onChange: (hotkey: string) => void
}> = ({ value, onChange }) => {
  const [recording, setRecording] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (LOCK_KEYS.has(e.key)) return

    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      setRecording(false)
      return
    }

    const combo = formatKeyCombo(e)
    if (combo) {
      const parts: string[] = []
      if (e.metaKey) parts.push('Meta')
      if (e.ctrlKey) parts.push('Control')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (!MODIFIER_KEYS.has(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
      onChange(parts.join('+'))
      setRecording(false)
    }
  }, [onChange])

  useEffect(() => {
    if (!recording) return
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, handleKeyDown])

  useEffect(() => {
    if (!recording) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setRecording(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [recording])

  const displayValue = recording ? 'Press keys...' : (value ? formatHotkeyString(value) : 'Not set')

  return (
    <div ref={containerRef} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        ...inputStyle,
        width: 140,
        textAlign: 'center',
        cursor: 'pointer',
        color: recording ? C.accent : value ? C.fg : C.fg3,
        border: recording ? `1px solid ${C.accent}` : inputStyle.border,
        background: recording ? C.accentDim : inputStyle.background,
        animation: recording ? 'pulse 1.5s ease-in-out infinite' : 'none',
        userSelect: 'none',
      }} onClick={() => setRecording(true)}>
        {displayValue}
      </div>
      {value && !recording && (
        <button onClick={() => onChange('')} style={pillButton('ghost')} title="Clear hotkey">
          Reset
        </button>
      )}
      {recording && (
        <span style={{ color: C.fg3, fontSize: 11 }}>Esc to cancel</span>
      )}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  )
}

// ── WhisperTab ──────────────────────────────────────────────────────

export const WhisperTab: React.FC<WhisperTabProps> = ({ isGatewayRunning }) => {
  const [voice, setVoice] = useState<VoiceCfg>(VOICE_DEFAULT)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dlState, setDlState] = useState<{ active: boolean; model: string; fraction: number; msg: string | null }>({
    active: false, model: '', fraction: 0, msg: null,
  })
  // Variants currently on disk. Stored as raw folder names from the WhisperKit
  // cache dir; isDownloaded() matches either form (with or without the
  // `openai_whisper-` prefix that UI values carry).
  const [downloaded, setDownloaded] = useState<string[]>([])
  const [warmed, setWarmed] = useState<string[]>([])
  // Warm state: which model is being warmed, when it started (for elapsed counter),
  // and any error from the last attempt. Errors don't block — first Fn press
  // still works, just slower.
  const [warmState, setWarmState] = useState<{ active: boolean; model: string; startedAt: number; error: string | null }>({
    active: false, model: '', startedAt: 0, error: null,
  })
  const [warmElapsed, setWarmElapsed] = useState(0)
  // Models that failed to warm this session — never auto-retry, otherwise the
  // auto-warm useEffect spins in a loop (warm fails → warmState.active flips
  // false → deps change → re-fires → "model folder is not set" flicker).
  // User can manually retry by switching model and back.
  const [warmFailed, setWarmFailed] = useState<Set<string>>(new Set())

  const refreshDownloaded = useCallback(async () => {
    try {
      const res = await window.codey.voice.listDownloadedModels()
      if (res.ok) setDownloaded(res.data)
    } catch { /* ignore — list is best-effort UI hint */ }
  }, [])
  const refreshWarmed = useCallback(async () => {
    try {
      const res = await window.codey.voice.listWarmedModels()
      if (res.ok) setWarmed(res.data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    refreshDownloaded()
    refreshWarmed()
  }, [refreshDownloaded, refreshWarmed])

  useEffect(() => {
    return window.codey.voice.onDownloadProgress(({ model, fraction }) => {
      setDlState(s => (s.active && s.model === model ? { ...s, fraction } : s))
    })
  }, [])

  useEffect(() => {
    const offStart = window.codey.voice.onWarmStart(({ model }) => {
      setWarmState({ active: true, model, startedAt: Date.now(), error: null })
    })
    const offDone = window.codey.voice.onWarmDone(({ model }) => {
      // Optimistically mark warmed before flipping active=false, otherwise the
      // auto-warm useEffect re-fires in the gap before refreshWarmed() resolves
      // and we get a flashing loop.
      setWarmed(prev => prev.includes(model) ? prev : [...prev, model])
      setWarmState(s => s.model === model ? { active: false, model, startedAt: s.startedAt, error: null } : s)
      refreshWarmed()
    })
    const offErr = window.codey.voice.onWarmError(({ model, error }) => {
      setWarmFailed(prev => {
        if (prev.has(model)) return prev
        const next = new Set(prev); next.add(model); return next
      })
      setWarmState(s => s.model === model ? { active: false, model, startedAt: s.startedAt, error } : s)
    })
    return () => { offStart(); offDone(); offErr() }
  }, [refreshWarmed])

  // Elapsed-seconds ticker while warming — CoreML compile shows no progress
  // signal, so we at least show the user time is advancing.
  useEffect(() => {
    if (!warmState.active) { setWarmElapsed(0); return }
    const tick = () => setWarmElapsed(Math.round((Date.now() - warmState.startedAt) / 1000))
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [warmState.active, warmState.startedAt])

  const matchVariant = useCallback((list: string[], modelValue: string): boolean => {
    if (list.length === 0) return false
    const bare = modelValue.startsWith('openai_whisper-')
      ? modelValue.slice('openai_whisper-'.length)
      : modelValue
    return list.some(d => d === modelValue || d === bare || d === `openai_whisper-${bare}`)
  }, [])
  const isDownloaded = useCallback((m: string) => matchVariant(downloaded, m), [matchVariant, downloaded])
  const isWarmed = useCallback((m: string) => matchVariant(warmed, m), [matchVariant, warmed])

  const warmModel = useCallback(async (model: string) => {
    if (warmState.active) return
    // Manual call clears the failed marker so the auto-warm effect (and this
    // call) actually run instead of being short-circuited by the loop guard.
    setWarmFailed(prev => {
      if (!prev.has(model)) return prev
      const next = new Set(prev); next.delete(model); return next
    })
    try { await window.codey.voice.warmModel(model) } catch { /* error surfaces via onWarmError */ }
  }, [warmState.active])

  const deleteModel = async (model: string) => {
    if (dlState.active || warmState.active) return
    const label = LOCAL_MODELS.find(m => m.value === model)?.label ?? model
    if (!window.confirm(`Delete "${label}"?\n\nThis removes the model files from disk. You can re-download anytime.`)) return
    try {
      const res = await window.codey.voice.deleteModel(model)
      if (!res.ok) {
        setError(res.error)
        return
      }
      await refreshDownloaded()
      await refreshWarmed()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const downloadModel = async (model: string) => {
    setDlState({ active: true, model, fraction: 0, msg: null })
    try {
      const res = await window.codey.voice.downloadModel(model)
      if (res.ok) {
        setDlState({ active: false, model, fraction: 1, msg: 'Downloaded' })
        await refreshDownloaded()
        setTimeout(() => setDlState(s => (s.model === model ? { ...s, msg: null } : s)), 3000)
        // Chain warm right after download — user just waited for ~1GB to
        // download, the +30-90s compile is the same "preparing model" arc.
        // Avoids the surprise 90s freeze on first Fn press.
        warmModel(model)
      } else {
        setDlState({ active: false, model, fraction: 0, msg: res.error })
      }
    } catch (e: any) {
      setDlState({ active: false, model, fraction: 0, msg: e?.message ?? String(e) })
    }
  }

  const reload = useCallback(async () => {
    setError(null)
    try {
      const cfg = await unwrap(await window.codey.config.get())
      setVoice({ ...VOICE_DEFAULT, ...(cfg?.voice ?? {}) })
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { if (isGatewayRunning) reload() }, [isGatewayRunning, reload])

  // Auto-warm: whenever the selected local model is downloaded but not warmed
  // (and we're not already busy with download/warm), kick a background warm.
  // Covers both "user switched to a different downloaded model" and "app boot
  // with a model that was downloaded in a prior session but never warmed".
  useEffect(() => {
    if (voice.provider !== 'local') return
    const m = voice.localModel
    if (!m) return
    if (dlState.active || warmState.active) return
    if (!isDownloaded(m)) return
    if (isWarmed(m)) return
    if (warmFailed.has(m)) return
    warmModel(m)
  }, [voice.provider, voice.localModel, downloaded, warmed, dlState.active, warmState.active, isDownloaded, isWarmed, warmModel, warmFailed])

  if (!isGatewayRunning) {
    return (
      <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  const updateVoice = async (patch: Partial<VoiceCfg>) => {
    const next = { ...voice, ...patch }
    setVoice(next)
    try {
      await unwrap(await window.codey.config.set({ voice: next }))
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(null), 1500)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <Section title="Voice input" right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {savedMsg && <span style={{ color: C.green, fontSize: 11 }}>{savedMsg}</span>}
          <span style={{ color: C.fg3, fontSize: 11 }}>{voice.enabled ? 'Enabled' : 'Disabled'}</span>
          <Toggle on={voice.enabled} onChange={enabled => updateVoice({ enabled })}/>
        </div>
      }/>
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
        System-wide voice input via the native <code>codey-voice</code> helper (macOS). Press the hotkey anywhere to start/stop recording — transcribed text is injected at your cursor. Requires the helper app running with Microphone + Accessibility permissions.
      </div>

      <div style={fieldStyle}>
        <span style={{ color: C.fg, fontSize: 13 }}>Hotkey</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => updateVoice({ hotkey: 'Fn' })}
            style={{
              ...pillButton(voice.hotkey === 'Fn' ? 'primary' : 'ghost'),
              fontSize: 11,
            }}
            title="Fn key cannot be captured from the browser — bundled helper monitors it directly"
          >
            Use Fn
          </button>
          <HotkeyRecorder value={voice.hotkey} onChange={hotkey => updateVoice({ hotkey })}/>
        </div>
      </div>
      {voice.hotkey === 'Fn' && (
        <div style={{ color: C.fg3, fontSize: 11, marginTop: 4 }}>
          Fn is handled by the bundled native helper. Make sure Codey Voice has Accessibility permission (System Settings → Privacy &amp; Security → Accessibility).
        </div>
      )}

      <div style={fieldStyle}>
        <span style={{ color: C.fg, fontSize: 13 }}>Language</span>
        <select
          value={voice.language}
          onChange={e => updateVoice({ language: e.target.value })}
          style={selectStyle}
        >
          {VOICE_LANGUAGES.map(l => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </div>

      <div style={fieldStyle}>
        <span style={{ color: C.fg, fontSize: 13 }}>Injection mode</span>
        <select
          value={voice.injection}
          onChange={e => updateVoice({ injection: e.target.value as 'paste' | 'ax' })}
          style={selectStyle}
        >
          <option value="paste">Paste (⌘V — works everywhere)</option>
          <option value="ax">Accessibility API (no clipboard touch)</option>
        </select>
      </div>

      <Section title="Transcription backend"/>
      {/* Provider row + descriptive note grouped as a single block: the divider
          lives on the outer block, not the row itself, so the note doesn't get
          orphaned below a row-divider with awkward gap. */}
      <div style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0' }}>
          <span style={{ color: C.fg, fontSize: 13 }}>Provider</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => updateVoice({ provider: 'api' })}
              style={pillButton(voice.provider === 'api' ? 'primary' : 'ghost')}
            >Cloud API</button>
            <button
              onClick={() => updateVoice({ provider: 'local' })}
              style={pillButton(voice.provider === 'local' ? 'primary' : 'ghost')}
            >Local (WhisperKit)</button>
          </div>
        </div>
        <div style={{ color: C.fg3, fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>
          {voice.provider === 'local'
            ? 'On-device transcription via WhisperKit (CoreML + Neural Engine). Model auto-downloads from HuggingFace on first use (~800MB for large-v3-turbo). Idle pipeline auto-releases after 30s.'
            : 'Sends audio to an OpenAI-compatible /audio/transcriptions endpoint. Works with OpenAI, Groq, or self-hosted Whisper servers.'}
        </div>
      </div>

      {voice.provider === 'local' && (() => {
        const selectedDownloaded = isDownloaded(voice.localModel)
        const selectedWarmed = isWarmed(voice.localModel)
        const downloadingThis = dlState.active && dlState.model === voice.localModel
        const warmingThis = warmState.active && warmState.model === voice.localModel
        const warmErrorForThis = !warmState.active && warmState.error && warmState.model === voice.localModel
        const downloadErrorForThis = dlState.msg && !dlState.active && !selectedDownloaded
        const note = LOCAL_MODELS.find(m => m.value === voice.localModel)?.note ?? ''

        // Three states per model: ⚡ warmed (instant), ✓ downloaded but not
        // warmed (first use = 30-90s compile), ⬇ not downloaded.
        const prefixFor = (m: string) => isWarmed(m) ? '⚡ ' : isDownloaded(m) ? '✓ ' : '⬇ '

        let statusLine: React.ReactNode = note
        let statusColor: string = C.fg3
        if (downloadErrorForThis) {
          statusLine = dlState.msg
          statusColor = C.red
        } else if (warmErrorForThis) {
          statusLine = `Warm-up failed: ${warmState.error}. First voice press will trigger CoreML compile (~30-90s).`
          statusColor = C.red
        } else if (warmingThis) {
          statusLine = `Compiling for your Mac… ${warmElapsed}s (one-time, ~30-90s on first use)`
          statusColor = C.accent
        } else if (selectedWarmed) {
          statusLine = '⚡ Ready — instant load on next Fn press'
          statusColor = C.green
        } else if (selectedDownloaded) {
          statusLine = 'Downloaded. First Fn press will compile model for your Mac (30-90s, one-time).'
          statusColor = C.fg3
        }

        return (
          <div style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0' }}>
              <span style={{ color: C.fg, fontSize: 13 }}>Local model</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <select
                  value={voice.localModel}
                  onChange={e => updateVoice({ localModel: e.target.value })}
                  style={{ ...selectStyle, width: 280 }}
                >
                  {LOCAL_MODELS.map(m => (
                    <option key={m.value} value={m.value}>
                      {prefixFor(m.value)}{m.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => !downloadingThis && !selectedDownloaded && downloadModel(voice.localModel)}
                  disabled={dlState.active || selectedDownloaded}
                  title={selectedDownloaded ? 'Already downloaded' : downloadingThis ? 'Downloading…' : 'Download model'}
                  style={{
                    ...pillButton(selectedDownloaded ? 'ghost' : downloadingThis ? 'ghost' : 'primary'),
                    opacity: dlState.active || selectedDownloaded ? 0.7 : 1,
                    cursor: dlState.active || selectedDownloaded ? 'default' : 'pointer',
                    minWidth: 120,
                  }}
                >
                  {selectedDownloaded
                    ? (selectedWarmed ? '⚡ Ready' : '✓ Downloaded')
                    : downloadingThis
                      ? `Downloading… ${Math.round(dlState.fraction * 100)}%`
                      : 'Download'}
                </button>
                {selectedDownloaded && !downloadingThis && !warmingThis && (
                  <button
                    onClick={() => deleteModel(voice.localModel)}
                    title="Delete this model from disk"
                    style={pillButton('danger')}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            {downloadingThis && (
              <div style={{ height: 4, background: C.surface3, borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
                <div style={{ height: '100%', width: `${Math.max(2, dlState.fraction * 100)}%`, background: C.accent, transition: 'width 0.2s' }}/>
              </div>
            )}
            {warmingThis && (
              <div style={{ height: 4, background: C.surface3, borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
                <div style={{
                  height: '100%', width: '40%', background: C.accent,
                  animation: 'warmSlide 1.4s ease-in-out infinite',
                }}/>
                <style>{`@keyframes warmSlide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }`}</style>
              </div>
            )}
            <div style={{ color: statusColor, fontSize: 11, lineHeight: 1.5, marginTop: 6 }}>
              {statusLine}
            </div>
          </div>
        )
      })()}

      {voice.provider === 'api' && (
      <>
      <Section title="Transcription API"/>

      <div style={{ ...fieldStyle, alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
        <span style={{ color: C.fg, fontSize: 13 }}>API base URL</span>
        <input
          value={voice.apiUrl}
          onChange={e => setVoice({ ...voice, apiUrl: e.target.value })}
          onBlur={() => updateVoice({ apiUrl: voice.apiUrl })}
          placeholder="https://api.openai.com/v1"
          style={{ ...inputStyle, width: '100%' }}
        />
        <span style={{ color: C.fg3, fontSize: 11 }}>
          POSTs to <code>{voice.apiUrl || '&lt;base&gt;'}/audio/transcriptions</code>. Works with OpenAI, Groq, or any OpenAI-compatible server.
        </span>
      </div>
      <div style={{ ...fieldStyle, alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
        <span style={{ color: C.fg, fontSize: 13 }}>API key</span>
        <input
          type="password"
          value={voice.apiKey}
          onChange={e => setVoice({ ...voice, apiKey: e.target.value })}
          onBlur={() => updateVoice({ apiKey: voice.apiKey })}
          placeholder="sk-..."
          style={{ ...inputStyle, width: '100%' }}
        />
      </div>
      <div style={fieldStyle}>
        <span style={{ color: C.fg, fontSize: 13 }}>Model</span>
        <input
          value={voice.apiModel}
          onChange={e => setVoice({ ...voice, apiModel: e.target.value })}
          onBlur={() => updateVoice({ apiModel: voice.apiModel })}
          placeholder="whisper-1"
          style={inputStyle}
        />
      </div>
      </>
      )}
    </div>
  )
}

function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (r.ok) return r.data
  throw new Error(r.error)
}
