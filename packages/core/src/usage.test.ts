import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendUsage, loadModelsDevCatalog, pruneUsage, readUsage, summarizeUsage, usageRecordFrom, type UsageRecord } from './usage';
import type { FetchLike, ModelsDevCatalog } from './providers';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-usage-'));
  file = path.join(dir, 'usage.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  ts: 1000, agent: 'claude-code', input: 0, output: 0, success: true, ...over,
});

describe('usageRecordFrom', () => {
  it('copies tokens and the key binding', () => {
    const r = usageRecordFrom('codex', {
      success: true, output: '', tokens: { total: 15, input: 10, output: 5, cache: { read: 3, write: 0 } },
    }, { model: 'm', apiKey: 'k', provider: 'deepseek' }, 42);
    expect(r).toEqual({ ts: 42, agent: 'codex', model: 'm', apiKey: 'k', provider: 'deepseek', input: 10, output: 5, cacheRead: 3, success: true });
  });

  it('skips runs that reported no tokens', () => {
    expect(usageRecordFrom('pi', { success: false, output: '' }, {})).toBeUndefined();
    expect(usageRecordFrom('pi', { success: true, output: '', tokens: { total: 0, input: 0, output: 0 } }, {})).toBeUndefined();
  });
});

describe('log file', () => {
  it('appends, reads by time and skips torn lines', () => {
    appendUsage(rec({ ts: 100, input: 1 }), file);
    appendUsage(rec({ ts: 200, input: 2 }), file);
    fs.appendFileSync(file, '{"ts": 30');
    expect(readUsage(150, file).map(r => r.input)).toEqual([2]);
    expect(readUsage(0, file)).toHaveLength(2);
  });

  it('reads nothing from a missing file', () => {
    expect(readUsage(0, path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('prunes old records and keeps new ones', () => {
    appendUsage(rec({ ts: 100 }), file);
    appendUsage(rec({ ts: 900 }), file);
    pruneUsage(500, 1000, file);
    expect(readUsage(0, file).map(r => r.ts)).toEqual([900]);
  });
});

describe('summarizeUsage', () => {
  const catalog: ModelsDevCatalog = {
    deepseek: { models: { 'ds-chat': { cost: { input: 1, output: 2, cache_read: 0.1 } } } },
  };

  it('groups by agent + model + key and prices at list price', () => {
    const s = summarizeUsage([
      rec({ agent: 'claude-code', model: 'ds-chat', provider: 'deepseek', input: 1_000_000, output: 500_000, cacheRead: 1_000_000 }),
      rec({ agent: 'claude-code', model: 'ds-chat', provider: 'deepseek', input: 1_000_000, output: 0 }),
      rec({ agent: 'codex', input: 10, output: 10 }),
    ], 0, catalog);
    expect(s.rows).toHaveLength(2);
    const ds = s.rows[0];
    expect(ds).toMatchObject({ model: 'ds-chat', runs: 2, input: 2_000_000, output: 500_000, cacheRead: 1_000_000 });
    // 2M in × $1 + 0.5M out × $2 + 1M cache × $0.1
    expect(ds.costUsd).toBeCloseTo(3.1);
    expect(s.rows[1]).toMatchObject({ agent: 'codex', model: '' });
    expect(s.rows[1].costUsd).toBeUndefined();
    expect(s.unpricedRows).toBe(true);
    expect(s.totals).toMatchObject({ runs: 3, input: 2_000_010 });
    expect(s.totals.costUsd).toBeCloseTo(3.1);
  });

  it('prices cache writes at the input price when models.dev has none', () => {
    const s = summarizeUsage([rec({ model: 'ds-chat', cacheWrite: 1_000_000 })], 0, catalog);
    expect(s.rows[0].costUsd).toBeCloseTo(1);
  });
});

describe('loadModelsDevCatalog', () => {
  const ok = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body });
  const down: FetchLike = async () => { throw new Error('offline'); };

  it('fetches and caches, then serves the cache while fresh', async () => {
    const cache = path.join(dir, 'models-dev.json');
    expect(await loadModelsDevCatalog(ok({ a: {} }), cache, Date.now())).toEqual({ a: {} });
    expect(await loadModelsDevCatalog(down, cache, Date.now())).toEqual({ a: {} });
  });

  it('serves a stale cache when the refresh fails, undefined with no cache', async () => {
    const cache = path.join(dir, 'models-dev.json');
    fs.writeFileSync(cache, JSON.stringify({ old: {} }));
    expect(await loadModelsDevCatalog(down, cache, Date.now() + 2 * 24 * 3600_000)).toEqual({ old: {} });
    expect(await loadModelsDevCatalog(down, path.join(dir, 'none.json'))).toBeUndefined();
  });
});
