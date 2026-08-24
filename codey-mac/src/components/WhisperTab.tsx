import React, { useState, useEffect, useCallback, useRef } from 'react'
import { C } from '../theme'
import { HotkeyRecorder } from './HotkeyRecorder'
import { Toggle } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { normalizeVocabulary, vocabularyToDraft, draftToVocabulary, countAliases, type VocabularyEntry, type VocabularyDraftRow } from './voiceVocabulary'

interface WhisperTabProps {
  isGatewayRunning: boolean
  onAddVoiceKey?: () => void
}

interface VoiceCfg {
  /** Legacy aggregate: true while either global voice hotkey is enabled. */
  enabled: boolean
  /** Controls only the global shortcut; the composer action stays available. */
  dictationEnabled: boolean
  /** Controls only the global shortcut; the composer action stays available. */
  conversationEnabled: boolean
  hotkey: string
  /** Second hotkey: start/stop a spoken conversation in the focused chat. */
  converseHotkey: string
  language: string
  injection: 'paste' | 'ax'
  provider: 'api' | 'local' | 'realtime'
  apiUrl: string
  apiKeyRef: string
  apiModel: string
  localModel: string
  realtimeUrl: string
  realtimeModel: string
  /** Legacy setting kept for config compatibility. The two hotkeys now have fixed destinations. */
  mode: 'inject' | 'converse'
  /** Custom vocabulary. See VocabularyEntry. */
  vocabulary: VocabularyEntry[]
  /** Learn mis-hearings from corrections made in a Codey chat before sending. */
  vocabularyAutoLearn: boolean
  tts: TtsCfg
}

interface TtsCfg {
  enabled: boolean
  provider: 'api' | 'local'
  apiUrl: string
  /** Independently selected key for API speech synthesis. */
  apiKeyRef: string
  apiModel: string
  voiceId: string
  /** Browser/macOS system voice URI. Empty means automatic by language. */
  systemVoice: string
  /** How much of a reply gets spoken. See speech-digest.ts. */
  verbosity: 'full' | 'digest' | 'auto'
}

const VOICE_DEFAULT: VoiceCfg = {
  enabled: false,
  dictationEnabled: false,
  conversationEnabled: false,
  hotkey: 'Fn',
  converseHotkey: 'Shift+Fn',
  language: 'auto',
  injection: 'paste',
  provider: 'api',
  apiUrl: 'https://api.openai.com/v1',
  apiKeyRef: '',
  apiModel: 'gpt-4o-mini-transcribe',
  localModel: 'openai_whisper-large-v3_turbo_954MB',
  realtimeUrl: 'wss://api.openai.com/v1/realtime?intent=transcription',
  realtimeModel: 'gpt-4o-mini-transcribe',
  mode: 'inject',
  vocabulary: [],
  vocabularyAutoLearn: true,
  tts: {
    enabled: false,
    provider: 'api',
    apiUrl: 'https://api.openai.com/v1',
    apiKeyRef: '',
    apiModel: 'gpt-4o-mini-tts',
    voiceId: 'alloy',
    systemVoice: '',
    verbosity: 'auto',
  },
}

const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']
interface SavedApiKey { name: string; apiKey: string; openaiBaseUrl?: string; purpose?: 'general' | 'voice' }

// Values must match real folder names in argmaxinc/whisperkit-coreml on HF.
// The helper strips the `openai_whisper-` prefix before passing to WhisperKit.
const LOCAL_MODELS: Array<{ value: string; label: string; note: string }> = [
  { value: 'openai_whisper-large-v3_turbo_954MB', label: 'large-v3 turbo · 954MB (recommended)', note: 'Quantized — near large-v3 quality at small-model speed. Best balance for most users.' },
  { value: 'openai_whisper-large-v3_turbo', label: 'large-v3 turbo · ~1.6GB', note: 'Full-precision turbo. Highest accuracy, but larger download and slower inference.' },
  { value: 'openai_whisper-large-v3', label: 'large-v3 · ~3GB (full precision)', note: 'Original large-v3 (non-turbo). Maximum accuracy at the cost of speed and disk space.' },
  { value: 'openai_whisper-large-v3-v20240930_turbo_632MB', label: 'large-v3 turbo · Sep 2024 · 632MB', note: 'Compact quantized turbo. Lower disk usage but slightly weaker on non-English languages.' },
  { value: 'openai_whisper-small_216MB', label: 'small · 216MB', note: 'Quantized small. Moderate quality, acceptable for English; weaker on other languages.' },
  { value: 'openai_whisper-small', label: 'small · ~480MB', note: 'Full-precision small. Mid-range accuracy and speed.' },
  { value: 'openai_whisper-base', label: 'base · ~150MB', note: 'Minimal footprint. Low accuracy — useful only for quick testing.' },
  { value: 'openai_whisper-tiny', label: 'tiny · ~75MB', note: 'Smallest model. Very fast but accuracy is poor; not recommended for real use.' },
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
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 16, padding: '13px 15px',
  background: C.surface3, borderBottom: `1px solid ${C.border}`,
}
const sectionCardStyle: React.CSSProperties = {
  marginTop: 14, borderRadius: 12, overflow: 'hidden',
  background: C.surface2, border: `1px solid ${C.border2}`,
}
const sectionBodyStyle: React.CSSProperties = { padding: '2px 15px 14px' }
const settingRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 0',
}
const settingBlockStyle: React.CSSProperties = {
  borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 4,
}
const fieldStyle: React.CSSProperties = {
  ...settingRowStyle, borderBottom: `1px solid ${C.border}`,
}
const lastFieldStyle: React.CSSProperties = { ...settingRowStyle }
const lastSettingBlockStyle: React.CSSProperties = { paddingBottom: 0, marginBottom: 0 }
const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red + '22' : C.surface3,
  color: variant === 'primary' ? C.onAccent : variant === 'danger' ? C.red : C.fg2,
})

const Section: React.FC<{ title: string; description: string; right?: React.ReactNode }> = ({ title, description, right }) => (
  <div style={sectionStyle}>
    <div>
      <div style={{ color: C.fg, fontSize: 14, fontWeight: 680 }}>{title}</div>
      <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{description}</div>
    </div>
    {right}
  </div>
)

const Subsection: React.FC<{ title: string }> = ({ title }) => (
  <div style={{ color: C.fg2, fontSize: 11, fontWeight: 700, letterSpacing: 0.55, textTransform: 'uppercase', padding: '16px 0 7px' }}>
    {title}
  </div>
)

// ── WhisperTab ──────────────────────────────────────────────────────

export const WhisperTab: React.FC<WhisperTabProps> = ({ isGatewayRunning, onAddVoiceKey }) => {
  const [voice, setVoice] = useState<VoiceCfg>(VOICE_DEFAULT)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedVoiceKeys, setSavedVoiceKeys] = useState<SavedApiKey[]>([])
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([])
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
  // Dictionary rows are edited as free text — aliases live as one blob while
  // the user types, so a half-typed line isn't eaten mid-keystroke. Parsed
  // back into string[] only on commit.
  const [vocabDraft, setVocabDraft] = useState<VocabularyDraftRow[]>([])
  // Which row has its mis-hearings open. One at a time: the list is a scan
  // target, and the aliases are the rare thing you come here to change.
  const [expandedVocabRow, setExpandedVocabRow] = useState<number | null>(null)

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
      const keys = await unwrap(await window.codey.apiKeys.list()) as SavedApiKey[]
      setSavedVoiceKeys(keys.filter(key => key.purpose === 'voice').sort((a, b) => a.name.localeCompare(b.name)))
      const storedVoice = cfg?.voice ?? {}
      const vocabulary = normalizeVocabulary(storedVoice.vocabulary)
      setVocabDraft(vocabularyToDraft(vocabulary))
      const legacyEnabled = storedVoice.enabled ?? false
      const dictationEnabled = storedVoice.dictationEnabled ?? legacyEnabled
      const conversationEnabled = storedVoice.conversationEnabled ?? legacyEnabled
      // tts merges one level deeper: a config written before a tts field
      // existed would otherwise blank out that field's default.
      setVoice({
        ...VOICE_DEFAULT,
        ...storedVoice,
        enabled: dictationEnabled || conversationEnabled,
        dictationEnabled,
        conversationEnabled,
        // Dictation and talk-to-chat now have separate triggers. Migrate old
        // configs so the primary hotkey always keeps its dictation meaning.
        mode: 'inject',
        vocabulary,
        tts: { ...VOICE_DEFAULT.tts, ...(cfg?.voice?.tts ?? {}) },
      })
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { if (isGatewayRunning) reload() }, [isGatewayRunning, reload])

  // The learner writes straight to config from the main process, so the open
  // editor has to be told — every save here sends the whole `voice` object,
  // and a stale copy would silently drop whatever was just learned. The
  // config state is therefore always refreshed; only the visible rows wait,
  // because rewriting a textarea under someone mid-edit is worse than showing
  // them one word out of date until they collapse it.
  useEffect(() => {
    return window.codey.voice.onVocabularyLearned(entries => {
      const normalized = normalizeVocabulary(entries)
      setVoice(prev => ({ ...prev, vocabulary: normalized }))
      if (expandedVocabRow === null) setVocabDraft(vocabularyToDraft(normalized))
    })
  }, [expandedVocabRow])

  useEffect(() => {
    const load = () => setSystemVoices(
      [...window.speechSynthesis.getVoices()].sort((a, b) =>
        a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name)),
    )
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

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

  const updateTts = (patch: Partial<TtsCfg>) => updateVoice({ tts: { ...voice.tts, ...patch } })

  const updateVoice = async (patch: Partial<VoiceCfg>) => {
    const patched = { ...voice, ...patch }
    const next = {
      ...patched,
      enabled: patched.dictationEnabled || patched.conversationEnabled,
      mode: 'inject' as const,
    }
    setVoice(next)
    try {
      await unwrap(await window.codey.config.set({ voice: next }))
      window.dispatchEvent(new CustomEvent('codey:voice-config-changed', { detail: next }))
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(null), 1500)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const commitVocabulary = (draft: VocabularyDraftRow[]) => {
    updateVoice({ vocabulary: draftToVocabulary(draft) })
  }

  const patchVocabRow = (index: number, patch: Partial<VocabularyDraftRow>) => {
    setVocabDraft(rows => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeVocabRow = (index: number) => {
    const next = vocabDraft.filter((_, i) => i !== index)
    setVocabDraft(next)
    commitVocabulary(next)
  }

  const handleHotkeyRecordingChange = useCallback((active: boolean) => {
    void window.codey.voice.setHotkeyCaptureActive(active)
  }, [])

  const renderVoiceKeyField = (
    label: string,
    description: string,
    value: string,
    onChange: (value: string) => void,
    emptyLabel = 'No key selected',
  ) => {
    const addNewValue = '__add_new_voice_key__'
    return (
    <div style={settingBlockStyle}>
      <div style={{ ...settingRowStyle, alignItems: 'flex-start' }}>
        <div>
          <div style={{ color: C.fg, fontSize: 13 }}>{label}</div>
          <div style={{ color: C.fg3, fontSize: 11, marginTop: 3 }}>{description}</div>
        </div>
        <select
          value={value}
          onChange={e => {
            if (e.target.value === addNewValue) {
              onAddVoiceKey?.()
              return
            }
            onChange(e.target.value)
          }}
          style={{ ...selectStyle, width: 220 }}
        >
          <option value="">{emptyLabel}</option>
          {savedVoiceKeys.map(key => <option key={key.name} value={key.name}>{key.name}</option>)}
          <option disabled>──────────</option>
          <option value={addNewValue}>+ Add new key…</option>
        </select>
      </div>
    </div>
    )
  }

  // "API" groups the two cloud modes (batch Whisper + Realtime WebSocket); they
  // share the same API key and only differ in transport. "Local" is on-device.
  const isApi = voice.provider === 'api' || voice.provider === 'realtime'

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, color: C.fg3, fontSize: 11, lineHeight: 1.5 }}>
        <span>The switches control global hotkeys only; both composer actions remain available. Dictation and Conversation share the recognition settings below.</span>
        {savedMsg && <span style={{ color: C.green, flexShrink: 0 }}>Saved</span>}
      </div>

      <div style={sectionCardStyle}>
        <Section
          title="Dictation"
          description="Global hotkey for typing speech at the cursor"
          right={<Toggle on={voice.dictationEnabled} onChange={dictationEnabled => updateVoice({ dictationEnabled })}/>}
        />
        <div style={sectionBodyStyle}>

      <div style={fieldStyle}>
        <span style={{ color: C.fg, fontSize: 13 }}>Dictation hotkey</span>
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
          <HotkeyRecorder
            value={voice.hotkey}
            onChange={hotkey => updateVoice({ hotkey })}
            onRecordingChange={handleHotkeyRecordingChange}
          />
        </div>
      </div>

      <div style={lastFieldStyle}>
        <span style={{ color: C.fg, fontSize: 13 }}>Insertion</span>
        <select
          value={voice.injection}
          onChange={e => updateVoice({ injection: e.target.value as 'paste' | 'ax' })}
          style={selectStyle}
        >
          <option value="paste">Paste (⌘V — works everywhere)</option>
          <option value="ax">Accessibility API (no clipboard touch)</option>
        </select>
      </div>
        </div>
      </div>

      <div style={sectionCardStyle}>
        <Section
          title="Conversation"
          description="Global hotkey for talking to the focused chat"
          right={<Toggle on={voice.conversationEnabled} onChange={conversationEnabled => updateVoice({ conversationEnabled })}/>}
        />
        <div style={sectionBodyStyle}>

      <div style={settingBlockStyle}>
        <div style={settingRowStyle}>
          <span style={{ color: C.fg, fontSize: 13 }}>Talk-to-chat hotkey</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => updateVoice({ converseHotkey: 'Shift+Fn' })}
              style={{
                ...pillButton(voice.converseHotkey === 'Shift+Fn' ? 'primary' : 'ghost'),
                fontSize: 11,
              }}
              title="Use Control + Fn; Fn combinations cannot be captured in the browser"
            >
              Use ⇧Fn
            </button>
            <HotkeyRecorder
              value={voice.converseHotkey}
              onChange={converseHotkey => updateVoice({ converseHotkey })}
              onRecordingChange={handleHotkeyRecordingChange}
            />
          </div>
        </div>
        <div style={{ color: C.fg3, fontSize: 11 }}>
          Press once to start listening and again to send.
          {voice.converseHotkey.trim().toLowerCase().endsWith('fn') && ' Fn shortcuts require Accessibility permission.'}
        </div>
      </div>

      <div style={{ padding: '15px 16px', borderRadius: 10, background: C.surface3, border: `1px solid ${C.border2}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: C.fg, fontSize: 13, fontWeight: 600 }}>Spoken replies</span>
          <select
            value={voice.tts.enabled ? 'api' : 'system'}
            onChange={e => updateTts({ enabled: e.target.value === 'api' })}
            style={selectStyle}
          >
            <option value="system">System</option>
            <option value="api">OpenAI</option>
          </select>
        </div>
        <div style={{ color: C.fg3, fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
          {voice.tts.enabled
            ? 'OpenAI synthesizes replies with the selected key and voice. Failures fall back to the saved system voice.'
            : 'Uses an installed macOS voice offline with no API key.'}
        </div>

        {!voice.tts.enabled ? (
          <div style={{ ...settingRowStyle, padding: '16px 0 0' }}>
              <div>
                <div style={{ color: C.fg, fontSize: 13 }}>System voice</div>
                <div style={{ color: C.fg3, fontSize: 11, marginTop: 3 }}>Installed macOS voices; Automatic follows the reply language.</div>
              </div>
              <select
                value={voice.tts.systemVoice}
                onChange={e => updateTts({ systemVoice: e.target.value })}
                style={{ ...selectStyle, maxWidth: 260 }}
              >
                <option value="">Automatic by language</option>
                {voice.tts.systemVoice && !systemVoices.some(item => item.voiceURI === voice.tts.systemVoice) && (
                  <option value={voice.tts.systemVoice}>Saved voice (currently unavailable)</option>
                )}
                {systemVoices.map(item => (
                  <option key={item.voiceURI} value={item.voiceURI}>
                    {item.name} — {item.lang}{item.default ? ' · Default' : ''}
                  </option>
                ))}
              </select>
          </div>
        ) : (
          <>
              {renderVoiceKeyField(
                'TTS key',
                'Select the Voice key used for OpenAI speech synthesis.',
                voice.tts.apiKeyRef,
                apiKeyRef => updateTts({ apiKeyRef }),
                'No key selected',
              )}
              <div style={fieldStyle}>
                <span style={{ color: C.fg, fontSize: 13 }}>Speech API URL</span>
                <input
                  value={voice.tts.apiUrl}
                  onChange={e => setVoice({ ...voice, tts: { ...voice.tts, apiUrl: e.target.value } })}
                  onBlur={e => updateTts({ apiUrl: e.target.value })}
                  style={inputStyle}
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              <div style={fieldStyle}>
                <span style={{ color: C.fg, fontSize: 13 }}>Speech model</span>
                <input
                  value={voice.tts.apiModel}
                  onChange={e => setVoice({ ...voice, tts: { ...voice.tts, apiModel: e.target.value } })}
                  onBlur={e => updateTts({ apiModel: e.target.value })}
                  style={inputStyle}
                  placeholder="gpt-4o-mini-tts"
                />
              </div>

              <div style={{ ...fieldStyle, borderBottom: 'none', paddingBottom: 0 }}>
                <span style={{ color: C.fg, fontSize: 13 }}>Voice</span>
                <select
                  value={voice.tts.voiceId}
                  onChange={e => updateTts({ voiceId: e.target.value })}
                  style={selectStyle}
                >
                  {TTS_VOICES.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
          </>
        )}
      </div>

      <div style={lastSettingBlockStyle}>
        <div style={settingRowStyle}>
          <div>
            <div style={{ color: C.fg, fontSize: 13 }}>Spoken reply length</div>
            <div style={{ color: C.fg3, fontSize: 11, marginTop: 3 }}>
              Choose how much Codey reads aloud. Say &ldquo;more detail&rdquo; to hear the full response.
            </div>
          </div>
          <select
            value={voice.tts.verbosity}
            onChange={e => updateTts({ verbosity: e.target.value as TtsCfg['verbosity'] })}
            style={selectStyle}
          >
            <option value="auto">Smart — summarize long replies</option>
            <option value="digest">Summary only</option>
            <option value="full">Full reply</option>
          </select>
        </div>
      </div>
        </div>
      </div>

      <div style={sectionCardStyle}>
        <Section
          title="Speech recognition"
          description="Used by both Dictation and Conversation"
        />
        <div style={sectionBodyStyle}>

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

      {/* Provider row + descriptive note grouped as a single block: the divider
          lives on the outer block, not the row itself, so the note doesn't get
          orphaned below a row-divider with awkward gap. */}
      <div style={settingBlockStyle}>
        <div style={settingRowStyle}>
          <span style={{ color: C.fg, fontSize: 13 }}>Transcription source</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => { if (!isApi) updateVoice({ provider: 'api' }) }}
              style={pillButton(isApi ? 'primary' : 'ghost')}
            >API</button>
            <button
              onClick={() => updateVoice({ provider: 'local' })}
              style={pillButton(voice.provider === 'local' ? 'primary' : 'ghost')}
            >On-device</button>
          </div>
        </div>
        {isApi && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 8px' }}>
            <span style={{ color: C.fg3, fontSize: 12 }}>API mode</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => updateVoice({ provider: 'api' })}
                style={{ ...pillButton(voice.provider === 'api' ? 'primary' : 'ghost'), fontSize: 11 }}
              >Standard</button>
              <button
                onClick={() => updateVoice({ provider: 'realtime' })}
                style={{ ...pillButton(voice.provider === 'realtime' ? 'primary' : 'ghost'), fontSize: 11 }}
              >Real-time</button>
            </div>
          </div>
        )}
        <div style={{ color: C.fg3, fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>
          {voice.provider === 'local'
            ? 'Runs privately on this Mac with WhisperKit. The selected model downloads once before first use.'
            : voice.provider === 'realtime'
              ? 'Streams audio to OpenAI for lower-latency partial transcripts while you speak.'
              : 'Uploads each completed recording to an OpenAI-compatible transcription endpoint.'}
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

        // Three states per model: warmed (instant), downloaded but not warmed
        // (first use = 30-90s compile), or not downloaded.
        const prefixFor = (m: string) => isWarmed(m) ? 'Ready · ' : isDownloaded(m) ? 'Downloaded · ' : 'Not downloaded · '

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
          statusLine = 'Ready — instant load on next Fn press'
          statusColor = C.green
        } else if (selectedDownloaded) {
          statusLine = 'Downloaded. First Fn press will compile model for your Mac (30-90s, one-time).'
          statusColor = C.fg3
        }

        return (
          <div style={lastSettingBlockStyle}>
            <div style={settingRowStyle}>
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
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}
                >
                  {selectedDownloaded
                    ? <>{selectedWarmed ? <UIIcon name="check" size={14} /> : <UIIcon name="archive" size={14} />}{selectedWarmed ? 'Ready' : 'Downloaded'}</>
                    : downloadingThis
                      ? `Downloading… ${Math.round(dlState.fraction * 100)}%`
                      : <><UIIcon name="archive" size={14} />Download</>}
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

      {(voice.provider === 'api' || voice.provider === 'realtime') && (
      <>
      <Subsection title="API transcription"/>

      {renderVoiceKeyField(
        'Transcription key',
        'Used by Standard and Real-time API transcription.',
        voice.apiKeyRef,
        apiKeyRef => updateVoice({ apiKeyRef }),
      )}

      {voice.provider === 'api' && (
      <>
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
      <div style={lastFieldStyle}>
        <span style={{ color: C.fg, fontSize: 13 }}>Model</span>
        <input
          value={voice.apiModel}
          onChange={e => setVoice({ ...voice, apiModel: e.target.value })}
          onBlur={() => updateVoice({ apiModel: voice.apiModel })}
          placeholder="gpt-4o-mini-transcribe"
          style={inputStyle}
        />
      </div>
      </>
      )}

      {voice.provider === 'realtime' && (
      <>
      <div style={{ ...fieldStyle, alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
        <span style={{ color: C.fg, fontSize: 13 }}>WebSocket URL</span>
        <input
          value={voice.realtimeUrl}
          onChange={e => setVoice({ ...voice, realtimeUrl: e.target.value })}
          onBlur={() => updateVoice({ realtimeUrl: voice.realtimeUrl })}
          placeholder="wss://api.openai.com/v1/realtime?intent=transcription"
          style={{ ...inputStyle, width: '100%' }}
        />
        <span style={{ color: C.fg3, fontSize: 11 }}>
          Connects via WebSocket to an OpenAI Realtime transcription endpoint. Requires <code>?intent=transcription</code>.
        </span>
      </div>
      <div style={lastSettingBlockStyle}>
        <div style={settingRowStyle}>
          <span style={{ color: C.fg, fontSize: 13 }}>Realtime model</span>
          <input
            value={voice.realtimeModel}
            onChange={e => setVoice({ ...voice, realtimeModel: e.target.value })}
            onBlur={() => updateVoice({ realtimeModel: voice.realtimeModel })}
            placeholder="gpt-4o-mini-transcribe"
            style={inputStyle}
          />
        </div>
        <div style={{ color: C.fg3, fontSize: 11, lineHeight: 1.5, padding: '8px 12px', background: C.surface3, borderRadius: 7 }}>
          <strong style={{ color: C.fg2 }}>ℹ️ Cost notice:</strong> Realtime API is billed per minute of audio. See <a href="https://openai.com/pricing" target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>OpenAI pricing</a> for current rates. If the WebSocket connection fails mid-utterance, the helper falls back to batch API for that utterance.
        </div>
      </div>
      </>
      )}
      </>
      )}
        </div>
      </div>

      <div style={sectionCardStyle}>
        <Section
          title="Dictionary"
          description="Names the recognizer keeps getting wrong"
          right={<Toggle on={voice.vocabularyAutoLearn} onChange={vocabularyAutoLearn => updateVoice({ vocabularyAutoLearn })}/>}
        />
        <div style={sectionBodyStyle}>

      <div style={{ color: C.fg3, fontSize: 11, lineHeight: 1.55, padding: '10px 12px', background: C.surface3, borderRadius: 7, marginTop: 10 }}>
        Every word here is passed to the recognizer as a hint <em>before</em> it transcribes,
        so it can reach spellings it would otherwise never produce. Open a word to also list
        what it gets <em>heard as</em> — those are rewritten back after transcribing, for
        mistakes that come out the same way every time. Applies to all three providers.
        <div style={{ marginTop: 7 }}>
          The toggle above controls learning: with it on, when you dictate into a Codey chat
          and fix a word before sending, that fix is added here automatically.
        </div>
      </div>

      {/* Chips rather than a column of inputs: the list is a scan target -
          "is this word already in here?" - and a wrapping row of words answers
          that at a glance where a stack of text fields does not. Editing is
          the rare action, so it lives in one panel below rather than inline,
          which would also break the wrap. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '14px 0 4px' }}>
        {vocabDraft.map((row, i) => {
          const aliases = countAliases(row.aliasText)
          const selected = expandedVocabRow === i
          const label = row.term.trim() || 'Untitled'
          return (
            <button
              key={i}
              onClick={() => setExpandedVocabRow(selected ? null : i)}
              title={aliases === 0
                ? `${label} - hint only, no mis-hearings listed`
                : `${label} - ${aliases} mis-hearing${aliases === 1 ? '' : 's'}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 11px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                background: selected ? C.accent : C.surface3,
                color: selected ? C.onAccent : C.fg,
                border: `1px solid ${selected ? C.accent : C.border2}`,
                fontStyle: row.term.trim() ? 'normal' : 'italic',
              }}
            >
              {label}
              {aliases > 0 && (
                <span style={{
                  fontSize: 10, lineHeight: 1, padding: '2px 5px', borderRadius: 999,
                  background: selected ? '#ffffff33' : C.border2,
                  color: selected ? C.onAccent : C.fg3,
                }}>
                  {aliases}
                </span>
              )}
            </button>
          )
        })}
        <button
          onClick={() => {
            // Index computed outside the updater: a state setter inside
            // another setter's callback runs during render in StrictMode's
            // double-invoke and would select the wrong chip.
            const index = vocabDraft.length
            setVocabDraft([...vocabDraft, { term: '', aliasText: '' }])
            setExpandedVocabRow(index)
          }}
          title="Add a word"
          style={{
            padding: '5px 11px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
            background: 'transparent', color: C.fg2,
            border: `1px dashed ${C.border2}`,
          }}
        >
          + Add word
        </button>
      </div>

      {vocabDraft.length === 0 && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '4px 0 8px' }}>
          No words yet.
        </div>
      )}

      {expandedVocabRow !== null && vocabDraft[expandedVocabRow] && (() => {
        const i = expandedVocabRow
        const row = vocabDraft[i]
        const aliases = countAliases(row.aliasText)
        return (
          <div style={{
            marginTop: 8, padding: 12, borderRadius: 9,
            background: C.surface3, border: `1px solid ${C.border2}`,
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={row.term}
                onChange={e => patchVocabRow(i, { term: e.target.value })}
                onBlur={() => commitVocabulary(vocabDraft)}
                placeholder="Codey"
                autoFocus
                style={{ ...inputStyle, flex: 1, width: 'auto', fontWeight: 600 }}
              />
              <button
                onClick={() => { setExpandedVocabRow(null); removeVocabRow(i) }}
                style={pillButton('danger')}
              >
                Remove
              </button>
              <button onClick={() => setExpandedVocabRow(null)} style={pillButton('ghost')}>
                Done
              </button>
            </div>
            <div style={{ color: C.fg2, fontSize: 11, fontWeight: 700, letterSpacing: 0.55, textTransform: 'uppercase', padding: '12px 0 6px' }}>
              Heard as
            </div>
            <textarea
              value={row.aliasText}
              onChange={e => patchVocabRow(i, { aliasText: e.target.value })}
              onBlur={() => commitVocabulary(vocabDraft)}
              placeholder={'Coday\ncode E\ncody'}
              rows={Math.min(8, Math.max(3, aliases + 1))}
              style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
            <div style={{ color: C.fg3, fontSize: 11, marginTop: 6 }}>
              One mis-hearing per line. Each is rewritten to
              <strong style={{ color: C.fg2 }}> {row.term.trim() || 'the word above'}</strong> after transcribing.
              Leave it empty to use the word as a hint only.
            </div>
          </div>
        )
      })()}

      <div style={{ ...lastSettingBlockStyle, paddingTop: 12, color: C.fg3, fontSize: 11 }}>
        {vocabDraft.length === 0 ? '' : `${vocabDraft.length} word${vocabDraft.length === 1 ? '' : 's'}`}
      </div>
        </div>
      </div>
    </div>
  )
}

function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (r.ok) return r.data
  throw new Error(r.error)
}
