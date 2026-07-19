import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutomationStore } from './store';
import type { Automation, AutomationRun } from '@codey/core';

let dir: string;
let store: AutomationStore;

const draft = (over: Partial<Automation> = {}) => ({
  name: 'Morning news',
  enabled: true,
  target: { kind: 'prompt' as const, workspaceName: 'default' },
  brief: 'Post top AI news to {{account}}.',
  params: { account: '@jack' },
  report: { notify: 'all' as const },
  ...over,
});

const run = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  runId: `r-${Math.random().toString(36).slice(2)}`,
  startedAt: 1000, endedAt: 2000, status: 'success', trigger: 'manual', ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-store-'));
  store = new AutomationStore(dir);
});

describe('definitions', () => {
  it('creates with generated id/timestamps and lists', () => {
    const a = store.create(draft(), 111);
    expect(a.id).toBeTruthy();
    expect(a.createdAt).toBe(111);
    expect(store.list()).toHaveLength(1);
    expect(store.get(a.id)?.name).toBe('Morning news');
  });

  it('persists across instances', () => {
    const a = store.create(draft(), 111);
    expect(new AutomationStore(dir).get(a.id)?.brief).toContain('{{account}}');
  });

  it('normalizes legacy boolean notify on read', () => {
    store.create(draft({ report: { notify: true as any } }), 111);
    store.create(draft({ report: { notify: false as any } }), 111);
    expect(store.list().map(a => a.report.notify)).toEqual(['all', 'none']);
  });

  it('normalizes a legacy single-time schedule on read', () => {
    const a = store.create(draft({ schedule: { hour: 9, minute: 30, tz: 'UTC' } as any }), 111);
    expect(store.get(a.id)?.schedule).toEqual({ times: [{ hour: 9, minute: 30 }], tz: 'UTC' });
  });

  it('update patches and bumps updatedAt', () => {
    const a = store.create(draft(), 111);
    const b = store.update(a.id, { name: 'Renamed' }, 222);
    expect(b.name).toBe('Renamed');
    expect(b.updatedAt).toBe(222);
  });

  it('preserves unknown fields on rewrite (forward-compat)', () => {
    const a = store.create(draft(), 111);
    const file = path.join(dir, 'automations.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.automations[0].futureField = { keep: 'me' };
    raw.topLevelFuture = 42;
    fs.writeFileSync(file, JSON.stringify(raw));
    new AutomationStore(dir).update(a.id, { name: 'x' }, 222);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.automations[0].futureField).toEqual({ keep: 'me' });
    expect(after.topLevelFuture).toBe(42);
  });

  it('delete removes definition and history file', () => {
    const a = store.create(draft(), 111);
    store.appendRun(a.id, run());
    store.delete(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'automation-runs', `${a.id}.jsonl`))).toBe(false);
  });

  it('setEnabled + recordLastFired persist', () => {
    const a = store.create(draft(), 111);
    store.setEnabled(a.id, false, 222);
    store.recordLastFired(a.id, 333);
    const back = new AutomationStore(dir).get(a.id)!;
    expect(back.enabled).toBe(false);
    expect(back.lastFiredAt).toBe(333);
  });
});

describe('run history', () => {
  it('appends and lists newest-first with limit', () => {
    const a = store.create(draft(), 111);
    store.appendRun(a.id, run({ runId: 'r1', startedAt: 1 }));
    store.appendRun(a.id, run({ runId: 'r2', startedAt: 2 }));
    const runs = store.listRuns(a.id);
    expect(runs.map(r => r.runId)).toEqual(['r2', 'r1']);
    expect(store.listRuns(a.id, 1)).toHaveLength(1);
  });

  it('patchRun rewrites a single record, preserving unknown fields', () => {
    const a = store.create(draft(), 111);
    store.appendRun(a.id, { ...run({ runId: 'r1', status: 'parked' }), extra: 'kept' } as AutomationRun);
    store.patchRun(a.id, 'r1', { status: 'failed', error: 'expired' });
    const r = store.listRuns(a.id)[0] as AutomationRun & { extra?: string };
    expect(r.status).toBe('failed');
    expect(r.extra).toBe('kept');
  });

  it('markSeen stamps seenAt', () => {
    const a = store.create(draft(), 111);
    store.appendRun(a.id, run({ runId: 'r1' }));
    store.markSeen(a.id, 'r1', 999);
    expect(store.listRuns(a.id)[0].seenAt).toBe(999);
  });

  it('listRuns tolerates a corrupt trailing line', () => {
    const a = store.create(draft(), 111);
    store.appendRun(a.id, run({ runId: 'r1' }));
    fs.appendFileSync(path.join(dir, 'automation-runs', `${a.id}.jsonl`), '{oops\n');
    expect(store.listRuns(a.id)).toHaveLength(1);
  });
});
