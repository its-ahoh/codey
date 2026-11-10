import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { C } from '../theme'
import { inputStyle, pillButton } from './settingsAtoms'
import type { CatalogModel, CatalogProvider } from '../codey-api'

// ── Logo ─────────────────────────────────────────────────────────────

/**
 * Company logo on a light tile: the colour LobeHub version where one exists,
 * otherwise models.dev's plain black mark (which would vanish on the dark theme
 * without the tile). Companies with neither show their first letter.
 */
// Logos ship inside the app (src/assets/provider-logos.json, refreshed by
// scripts/fetch-provider-logos.mjs), so drawing them never touches the
// network. The ~0.7 MB bank is a separate chunk loaded the first time a logo
// is shown, not part of the startup bundle.
type LogoBank = { color: Record<string, string>; mono: Record<string, string> }
let logoBank: LogoBank | null = null
let logoBankLoad: Promise<LogoBank> | null = null
const loadLogoBank = () => (logoBankLoad ??= import('../assets/provider-logos.json')
  .then(m => (logoBank = ((m as { default?: LogoBank }).default ?? m) as LogoBank)))

const dataUrls = new Map<string, string>()
const svgDataUrl = (svg: string) => {
  let url = dataUrls.get(svg)
  if (!url) { url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; dataUrls.set(svg, url) }
  return url
}

export const ProviderLogo: React.FC<{ provider?: CatalogProvider; label?: string; size?: number }> = ({ provider, label, size = 28 }) => {
  const [bank, setBank] = useState<LogoBank | null>(logoBank)
  useEffect(() => {
    if (bank) return
    let live = true
    loadLogoBank().then(b => { if (live) setBank(b) }).catch(() => { /* letters only */ })
    return () => { live = false }
  }, [bank])
  // Colour logo first, then the models.dev mark, then the first letter —
  // each step taken only when the one before is missing or fails to draw.
  const sources = [
    provider?.colorLogo ? bank?.color[provider.colorLogo] : undefined,
    provider?.logoId ? bank?.mono[provider.logoId] : undefined,
  ].filter((svg): svg is string => !!svg).map(svgDataUrl)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => setAttempt(0), [provider?.colorLogo, provider?.logoId, bank])
  const src = sources[attempt]
  const text = (provider?.label ?? label ?? '?').trim()
  const tile: React.CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size * 0.28), flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: '#f4f4f5', border: `1px solid ${C.border}`, overflow: 'hidden',
  }
  if (!src) {
    return (
      <span aria-hidden style={{ ...tile, color: '#3f3f46', fontSize: Math.round(size * 0.46), fontWeight: 700 }}>
        {text.charAt(0).toUpperCase()}
      </span>
    )
  }
  return (
    <span aria-hidden style={tile}>
      <img key={src} src={src} alt=""
        width={Math.round(size * 0.66)} height={Math.round(size * 0.66)}
        onError={() => setAttempt(a => a + 1)} style={{ display: 'block' }} />
    </span>
  )
}

// ── The field that opens the picker ─────────────────────────────────

export const ProviderButton: React.FC<{
  providers: CatalogProvider[]
  value: string | undefined
  placeholder: string
  onOpen: () => void
  onClear?: () => void
  ariaLabel: string
}> = ({ providers, value, placeholder, onOpen, onClear, ariaLabel }) => {
  const p = providers.find(pp => pp.id === value)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      <button type="button" aria-label={ariaLabel} onClick={onOpen} style={{
        ...inputStyle, width: '100%', flex: 1, minWidth: 0, cursor: 'pointer', textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
      }}>
        {value
          ? <><ProviderLogo provider={p} label={value} size={20} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p?.label ?? value}</span></>
          : <span style={{ color: C.fg3 }}>{placeholder}</span>}
        <span style={{ marginLeft: 'auto', color: C.fg3, fontSize: 11 }}>Choose…</span>
      </button>
      {value && onClear && (
        <button type="button" onClick={onClear} title="Clear" aria-label="Clear provider" style={{ ...pillButton('ghost'), padding: '6px 9px' }}>×</button>
      )}
    </div>
  )
}

// ── The picker window ───────────────────────────────────────────────

const fmtContext = (n?: number) => (n ? (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`) : '')
const fmtPrice = (p?: CatalogModel['price']) =>
  p && (p.input !== undefined || p.output !== undefined)
    ? `$${+(p.input ?? 0).toFixed(2)} in · $${+(p.output ?? 0).toFixed(2)} out`
    : ''

const matches = (q: string, ...fields: Array<string | undefined>) => {
  const needle = q.trim().toLowerCase()
  return !needle || fields.some(f => f?.toLowerCase().includes(needle))
}

/**
 * Two-step picker: a grid of companies (logo + name, searchable), then — in
 * `model` mode — that company's models from models.dev. `provider` mode stops
 * after step one and offers a "Custom endpoint" card for self-hosted URLs.
 */
export const ProviderPickerModal: React.FC<{
  providers: CatalogProvider[]
  mode: 'provider' | 'model'
  /** Open straight on this company's model list (model mode). */
  initialProvider?: string
  onPickProvider?: (id: string | undefined) => void
  onPickModel?: (providerId: string, modelId: string) => void
  onClose: () => void
}> = ({ providers, mode, initialProvider, onPickProvider, onPickModel, onClose }) => {
  const [step, setStep] = useState<string | null>(mode === 'model' && initialProvider ? initialProvider : null)
  const back = () => { setStep(null); setQuery('') }
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<{ busy: boolean; list: CatalogModel[] }>({ busy: false, list: [] })
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Hand focus back to whatever opened the picker when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => { opener?.focus?.() }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keep Tab inside the dialog: wrap from the last control to the first
      // and back, so focus never lands on the page underneath.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex]:not([tabindex="-1"])')]
        if (focusable.length === 0) return
        const first = focusable[0], last = focusable[focusable.length - 1]
        const inside = dialogRef.current.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus() }
        return
      }
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (step) back(); else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [step, onClose])

  useEffect(() => { searchRef.current?.focus() }, [step])

  useEffect(() => {
    if (!step) return
    let live = true
    setModels({ busy: true, list: [] })
    window.codey.providers.catalogModels(step)
      .then(r => { if (live) setModels({ busy: false, list: r.ok ? r.data : [] }) })
      .catch(() => { if (live) setModels({ busy: false, list: [] }) })
    return () => { live = false }
  }, [step])

  const company = providers.find(p => p.id === step)
  const shown = useMemo(() => providers.filter(p => matches(query, p.label, p.id)), [providers, query])
  const curated = shown.filter(p => p.curated)
  const rest = shown.filter(p => !p.curated)
  const shownModels = models.list.filter(m => matches(query, m.name, m.id))

  const pickCompany = (id: string) => {
    if (mode === 'provider') { onPickProvider?.(id); onClose(); return }
    setStep(id); setQuery('')
  }

  const card = (p: CatalogProvider) => (
    <button key={p.id} type="button" onClick={() => pickCompany(p.id)} title={p.label} style={styles.card}>
      <ProviderLogo provider={p} size={30} />
      <span style={styles.cardLabel}>{p.label}</span>
    </button>
  )

  return createPortal(
    <div style={styles.backdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={step ? 'Choose a model' : 'Choose a provider'} style={styles.modal}>
        <div style={styles.header}>
          {step && (
            <button type="button" onClick={back} style={{ ...pillButton('ghost'), padding: '5px 9px' }} aria-label="Back to providers">‹</button>
          )}
          {step && <ProviderLogo provider={company} label={step} size={26} />}
          <div style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>
            {step ? (company?.label ?? step) : mode === 'model' ? 'Choose a provider, then a model' : 'Choose a provider'}
          </div>
          <button type="button" onClick={onClose} style={{ ...pillButton('ghost'), padding: '5px 10px' }} aria-label="Close">Close</button>
        </div>
        <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder={step ? 'Search models' : `Search ${providers.length} providers`}
          style={{ ...inputStyle, width: '100%', marginBottom: 12 }} />

        <div style={styles.body}>
          {!step && <>
            {mode === 'provider' && matches(query, 'custom endpoint url') && (
              <>
                <div style={styles.groupLabel}>Your own</div>
                <div style={styles.grid}>
                  <button type="button" onClick={() => { onPickProvider?.(undefined); onClose() }} style={styles.card}>
                    <ProviderLogo label="+" size={30} />
                    <span style={styles.cardLabel}>Custom</span>
                  </button>
                </div>
              </>
            )}
            {curated.length > 0 && <><div style={styles.groupLabel}>Common</div><div style={styles.grid}>{curated.map(card)}</div></>}
            {rest.length > 0 && <><div style={styles.groupLabel}>All providers · from models.dev</div><div style={styles.grid}>{rest.map(card)}</div></>}
            {shown.length === 0 && <div style={styles.empty}>No provider matches “{query}”.</div>}
          </>}

          {step && <>
            {models.busy && <div style={styles.empty}>Loading models…</div>}
            {!models.busy && (
              <button type="button" onClick={() => { onPickProvider?.(step); onClose() }} style={styles.useCompany}>
                {models.list.length === 0
                  ? `No public model list for ${company?.label ?? step}. Use it and type the model id yourself`
                  : `Not listed? Use ${company?.label ?? step} and type the model id yourself`}
              </button>
            )}
            {shownModels.map(m => (
              <button key={m.id} type="button" onClick={() => { onPickModel?.(step, m.id); onClose() }} style={styles.modelRow}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: C.fg }}>{m.name ?? m.id}</div>
                  <div style={{ fontSize: 11.5, color: C.fg3, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.id}</div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11.5, color: C.fg3, flexShrink: 0, lineHeight: 1.5 }}>
                  <div>{[fmtContext(m.context) && `${fmtContext(m.context)} context`, m.releaseDate].filter(Boolean).join(' · ')}</div>
                  <div>{fmtPrice(m.price) && `${fmtPrice(m.price)} /1M`}</div>
                </div>
              </button>
            ))}
            {!models.busy && models.list.length > 0 && shownModels.length === 0 && (
              <div style={styles.empty}>No model matches “{query}”.</div>
            )}
          </>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000,
  },
  modal: {
    width: 640, maxWidth: 'calc(100vw - 48px)', height: 560, maxHeight: 'calc(100vh - 48px)',
    display: 'flex', flexDirection: 'column',
    background: C.bg, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 14,
    padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 },
  groupLabel: { color: C.fg3, fontSize: 11.5, fontWeight: 600, margin: '4px 0 8px', textTransform: 'uppercase', letterSpacing: 0.4 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 16 },
  card: {
    display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', minWidth: 0,
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10,
    color: C.fg, cursor: 'pointer', textAlign: 'left',
  },
  cardLabel: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  modelRow: {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '10px 12px', marginBottom: 6,
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, cursor: 'pointer', textAlign: 'left',
  },
  empty: { color: C.fg3, fontSize: 12.5, padding: '18px 4px' },
  useCompany: {
    display: 'block', width: '100%', padding: '9px 12px', marginBottom: 10, textAlign: 'left',
    background: 'transparent', border: `1px dashed ${C.border2}`, borderRadius: 10,
    color: C.fg2, fontSize: 12.5, cursor: 'pointer',
  },
}
