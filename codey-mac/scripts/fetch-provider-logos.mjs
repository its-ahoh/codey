#!/usr/bin/env node
// Snapshot every provider logo the picker can show into
// src/assets/provider-logos.json, so the app renders them offline and never
// asks a CDN at run time.
//
//   npm run build -w @codey/core && node codey-mac/scripts/fetch-provider-logos.mjs
//
// Re-run when models.dev adds providers or COLOR_LOGOS changes. Sources:
//   colour: @lobehub/icons-static-svg (MIT), pinned version below
//   mono:   https://models.dev/logos/<id>.svg (models.dev, MIT)
// Logos are only ever drawn through <img>, so any script inside an SVG is inert.

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { listCatalogProviders, COLOR_LOGOS } = require(join(here, '../../packages/core/dist/providers.js'))

const LOBEHUB_VERSION = '1.102.0'
const colorUrl = slug => `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@${LOBEHUB_VERSION}/icons/${slug}-color.svg`
const monoUrl = id => `https://models.dev/logos/${id}.svg`
const OUT = join(here, '../src/assets/provider-logos.json')

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const text = (await res.text()).trim()
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(text)) throw new Error(`not an SVG: ${url}`)
  return text
}

async function pool(items, size, fn) {
  const out = []
  let i = 0
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const item = items[i++]; out.push(await fn(item)) }
  }))
  return out
}

const catalog = await (await fetch('https://models.dev/api.json')).json()
const providers = listCatalogProviders(catalog)
// models.dev answers an unknown id with a generic mark; that one is not a logo.
const generic = await get(monoUrl('codey-unknown-provider-probe'))

const monoIds = [...new Set(providers.map(p => p.logoId).filter(Boolean))]
const colorSlugs = [...new Set(Object.values(COLOR_LOGOS))]
const mono = {}, color = {}, failed = []

await pool(monoIds, 8, async id => {
  try { const svg = await get(monoUrl(id)); if (svg !== generic) mono[id] = svg }
  catch (e) { failed.push(e.message) }
})
await pool(colorSlugs, 8, async slug => {
  try { color[slug] = await get(colorUrl(slug)) }
  catch (e) { failed.push(e.message) }
})

const sort = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(OUT, JSON.stringify({ lobehubVersion: LOBEHUB_VERSION, color: sort(color), mono: sort(mono) }) + '\n')
console.log(`colour ${Object.keys(color).length}/${colorSlugs.length}, mono ${Object.keys(mono).length}/${monoIds.length} → ${OUT}`)
if (failed.length) console.log(`failed (${failed.length}):\n  ${failed.join('\n  ')}`)
