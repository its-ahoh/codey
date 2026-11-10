/**
 * Token usage log: one JSON line per finished agent run, in
 * `~/.codey/usage.jsonl`. The gateway appends; the Mac app reads and sums.
 *
 * Cost is not stored. It is computed at read time from models.dev list prices,
 * so a price that was missing or wrong when the run happened is right the next
 * time the panel opens.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codeyHome } from './codey-paths';
import type { AgentResponse, CodingAgent } from './types';
import { lookupModelPrice, MODELS_DEV_URL, type FetchLike, type ModelsDevCatalog } from './providers';

export interface UsageRecord {
  /** Epoch ms when the run finished. */
  ts: number;
  agent: CodingAgent;
  /** Model id from the Codey catalogue; absent when the CLI used its own default. */
  model?: string;
  /** Name of the ApiKeyEntry the model was bound to, if any. */
  apiKey?: string;
  /** Preset id of that key, used to pick the right price list. */
  provider?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  success: boolean;
}

export function usageLogPath(): string {
  return path.join(codeyHome(), 'usage.jsonl');
}

/** Build a record from a finished run; undefined when the CLI reported no tokens. */
export function usageRecordFrom(
  agent: CodingAgent,
  response: AgentResponse,
  binding: { model?: string; apiKey?: string; provider?: string },
  now = Date.now(),
): UsageRecord | undefined {
  const t = response.tokens;
  if (!t || (!t.input && !t.output && !t.cache?.read && !t.cache?.write)) return undefined;
  return {
    ts: now,
    agent,
    ...(binding.model ? { model: binding.model } : {}),
    ...(binding.apiKey ? { apiKey: binding.apiKey } : {}),
    ...(binding.provider ? { provider: binding.provider } : {}),
    input: t.input ?? 0,
    output: t.output ?? 0,
    ...(t.cache?.read ? { cacheRead: t.cache.read } : {}),
    ...(t.cache?.write ? { cacheWrite: t.cache.write } : {}),
    success: response.success,
  };
}

/** Best effort: a full disk must never fail the run that produced the usage. */
export function appendUsage(record: UsageRecord, file = usageLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch { /* best effort */ }
}

/** Records with `ts >= sinceMs`. Malformed lines (a torn write) are skipped. */
export function readUsage(sinceMs: number, file = usageLogPath()): UsageRecord[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as UsageRecord;
      if (typeof r?.ts === 'number' && r.ts >= sinceMs) out.push(r);
    } catch { /* skip */ }
  }
  return out;
}

export interface UsageRow {
  agent: CodingAgent;
  /** '' when the CLI ran on its own default model. */
  model: string;
  apiKey?: string;
  runs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD at list price; undefined when no price is known for the model. */
  costUsd?: number;
}

export interface UsageSummary {
  since: number;
  rows: UsageRow[];
  totals: { runs: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
  /** True when at least one row has tokens but no known price. */
  unpricedRows: boolean;
}

/** Group by agent + model + key, sort by cost then tokens, most first. */
export function summarizeUsage(records: UsageRecord[], since: number, catalog?: ModelsDevCatalog): UsageSummary {
  const byKey = new Map<string, UsageRow & { provider?: string }>();
  for (const r of records) {
    const k = `${r.agent}\u0000${r.model ?? ''}\u0000${r.apiKey ?? ''}`;
    let row = byKey.get(k);
    if (!row) {
      row = { agent: r.agent, model: r.model ?? '', apiKey: r.apiKey, provider: r.provider, runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      byKey.set(k, row);
    }
    row.runs += 1;
    row.input += r.input || 0;
    row.output += r.output || 0;
    row.cacheRead += r.cacheRead || 0;
    row.cacheWrite += r.cacheWrite || 0;
  }
  const rows: UsageRow[] = [];
  let unpricedRows = false;
  for (const { provider, ...row } of byKey.values()) {
    const price = row.model ? lookupModelPrice(catalog, row.model, provider) : undefined;
    if (price) {
      // A cache price models.dev doesn't publish falls back to the input price:
      // overstating beats silently dropping those tokens from the bill.
      row.costUsd = (
        row.input * (price.input ?? 0) +
        row.output * (price.output ?? 0) +
        row.cacheRead * (price.cache_read ?? price.input ?? 0) +
        row.cacheWrite * (price.cache_write ?? price.input ?? 0)
      ) / 1_000_000;
    } else {
      unpricedRows = true;
    }
    rows.push(row);
  }
  rows.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || (b.input + b.output) - (a.input + a.output));
  const totals = rows.reduce((t, r) => ({
    runs: t.runs + r.runs,
    input: t.input + r.input,
    output: t.output + r.output,
    cacheRead: t.cacheRead + r.cacheRead,
    cacheWrite: t.cacheWrite + r.cacheWrite,
    costUsd: t.costUsd + (r.costUsd ?? 0),
  }), { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
  return { since, rows, totals, unpricedRows };
}

/** Drop records older than `keepMs`; run on startup so the file can't grow forever. */
export function pruneUsage(keepMs: number, now = Date.now(), file = usageLogPath()): void {
  try {
    if (!fs.existsSync(file)) return;
    const kept = readUsage(now - keepMs, file);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

const MODELS_DEV_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * models.dev's catalogue, cached in `~/.codey/models-dev.json` for a day. A
 * failed refresh serves the stale copy; with no copy at all it resolves
 * undefined and callers show tokens without a price.
 */
export async function loadModelsDevCatalog(
  fetchImpl: FetchLike,
  file = path.join(codeyHome(), 'models-dev.json'),
  now = Date.now(),
): Promise<ModelsDevCatalog | undefined> {
  let cached: ModelsDevCatalog | undefined;
  try {
    const stat = fs.statSync(file);
    cached = JSON.parse(fs.readFileSync(file, 'utf8')) as ModelsDevCatalog;
    if (now - stat.mtimeMs < MODELS_DEV_MAX_AGE_MS) return cached;
  } catch { /* no usable cache */ }
  try {
    const res = await fetchImpl(MODELS_DEV_URL);
    if (!res.ok) return cached;
    const body = await res.json();
    if (!body || typeof body !== 'object') return cached;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
    } catch { /* serve it uncached */ }
    return body as ModelsDevCatalog;
  } catch {
    return cached;
  }
}
