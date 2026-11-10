import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { pageStyle, pillButton, Section, unwrap } from './settingsAtoms'
import type { BalanceResult, UsageSummary } from '../codey-api'
import { formatMoney } from './ApiKeysTab'

type Summary = UsageSummary & { balanceKeys: string[] }

const SPANS = [{ days: 1, label: '24 hours' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }]

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

export function formatUsd(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

const cell: React.CSSProperties = { padding: '7px 8px', fontSize: 12, whiteSpace: 'nowrap' }
const num: React.CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

const BalanceRow: React.FC<{ keyName: string }> = ({ keyName }) => {
  const [s, setS] = useState<{ busy: boolean; data?: BalanceResult; err?: string }>({ busy: true })
  useEffect(() => {
    let live = true
    window.codey.providers.balance(keyName)
      .then(r => { if (live) setS({ busy: false, data: unwrap(r) }) })
      .catch((e: any) => { if (live) setS({ busy: false, err: e?.message ?? String(e) }) })
    return () => { live = false }
  }, [keyName])
  const d = s.data
  const value = s.busy ? '…'
    : s.err ? 'unavailable'
    : d?.remaining !== undefined ? `${formatMoney(d.remaining, d.currency)} left`
    : d?.used !== undefined ? `${formatMoney(d.used, d.currency)} used`
    : '—'
  return (
    <div title={s.err} style={{
      display: 'flex', justifyContent: 'space-between', padding: '10px 14px', marginBottom: 6,
      borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, fontSize: 13,
    }}>
      <span style={{ fontWeight: 600 }}>{keyName}</span>
      <span style={{ color: s.err ? C.fg3 : C.fg, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

export const UsageTab: React.FC<{ isGatewayRunning: boolean }> = ({ isGatewayRunning }) => {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setBusy(true); setError(null)
    try { setData(unwrap(await window.codey.usage.summary(days))) }
    catch (e: any) { setError(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }, [days])

  useEffect(() => { if (isGatewayRunning) void reload() }, [isGatewayRunning, reload])

  if (!isGatewayRunning) {
    return (
      <div style={pageStyle}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  const t = data?.totals
  return (
    <div style={pageStyle}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <Section first title="Usage" description="Tokens from every agent run in Codey. Cost is an estimate at list price (models.dev), not your bill." right={
        <div style={{ display: 'flex', gap: 6 }}>
          {SPANS.map(s => (
            <button key={s.days} onClick={() => setDays(s.days)}
              style={{ ...pillButton(days === s.days ? 'primary' : 'ghost'), padding: '6px 10px' }}>{s.label}</button>
          ))}
          <button onClick={() => void reload()} disabled={busy} style={{ ...pillButton('ghost'), padding: '6px 10px' }}>
            {busy ? '…' : 'Refresh'}
          </button>
        </div>
      } />

      {t && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 14 }}>
          {[
            { label: 'Est. cost', value: formatUsd(t.costUsd) },
            { label: 'Runs', value: String(t.runs) },
            { label: 'Input', value: formatTokens(t.input) },
            { label: 'Cache', value: formatTokens(t.cacheRead + t.cacheWrite) },
            { label: 'Output', value: formatTokens(t.output) },
          ].map(k => (
            <div key={k.label} style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2 }}>
              <div style={{ color: C.fg3, fontSize: 11 }}>{k.label}</div>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {data && data.rows.length === 0 && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '8px 0 16px' }}>No agent runs recorded in this period yet.</div>
      )}

      {data && data.rows.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface2, color: C.fg3 }}>
                <th style={{ ...cell, textAlign: 'left', fontWeight: 500 }}>Model</th>
                <th style={{ ...cell, textAlign: 'left', fontWeight: 500 }}>Agent</th>
                <th style={{ ...num, fontWeight: 500 }}>Runs</th>
                <th style={{ ...num, fontWeight: 500 }}>Input</th>
                <th style={{ ...num, fontWeight: 500 }}>Cache</th>
                <th style={{ ...num, fontWeight: 500 }}>Output</th>
                <th style={{ ...num, fontWeight: 500 }}>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={`${r.agent}|${r.model}|${r.apiKey ?? ''}`} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ ...cell, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.apiKey ? `key: ${r.apiKey}` : undefined}>
                    {r.model || <span style={{ color: C.fg3 }}>CLI default</span>}
                  </td>
                  <td style={{ ...cell, color: C.fg2 }}>{r.agent}</td>
                  <td style={num}>{r.runs}</td>
                  <td style={num}>{formatTokens(r.input)}</td>
                  <td style={num}>{formatTokens(r.cacheRead + r.cacheWrite)}</td>
                  <td style={num}>{formatTokens(r.output)}</td>
                  <td style={{ ...num, color: r.costUsd === undefined ? C.fg3 : C.fg }}>{formatUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.unpricedRows && (
        <div style={{ color: C.fg3, fontSize: 12, marginTop: 8 }}>
          “—” means models.dev has no price for that model (or the CLI used its own default), so it isn't in the total.
        </div>
      )}

      {data && data.balanceKeys.length > 0 && <>
        <Section title="Balances" description="Asked live from each provider that reports it." />
        {data.balanceKeys.map(k => <BalanceRow key={k} keyName={k} />)}
      </>}
    </div>
  )
}
