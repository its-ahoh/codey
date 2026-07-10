// packages/gateway/src/automations/engine.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutomationEngine, OUTPUT_CAP, PARKED_TTL_MS, type EngineDeps } from './engine';
import { AutomationStore } from './store';
import { SchedulerLease } from './lease';
import type { Automation, AutomationEvent } from '@codey/core';

// 2026-07-02T09:00:00 Asia/Shanghai
const SH_9AM = Date.UTC(2026, 6, 2, 1, 0, 0);

let dir: string;
let store: AutomationStore;
let events: AutomationEvent[];
let deps: EngineDeps;
let now: number;

const makeEngine = (over: Partial<EngineDeps> = {}) =>
  new AutomationEngine({ ...deps, ...over });

const seed = (over: Partial<Automation> = {}) =>
  store.create({
    name: 'a', enabled: true,
    target: { kind: 'prompt', workspaceName: 'w' },
    brief: 'do it', params: {}, report: { notify: false },
    schedule: { hour: 9, minute: 0, tz: 'Asia/Shanghai' },
    ...over,
  }, 1);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  store = new AutomationStore(dir);
  events = [];
  now = SH_9AM;
  deps = {
    store,
    lease: new SchedulerLease(path.join(dir, 'scheduler.lock'), 'daemon'),
    runTarget: vi.fn(async () => ({ output: 'ok' })),
    resumeTarget: vi.fn(async () => ({ output: 'resumed ok' })),
    report: vi.fn(async () => undefined),
    onEvent: ev => events.push(ev),
    now: () => now,
  };
});

describe('tick', () => {
  it('fires a due schedule once, records lastFiredAt and a success run', async () => {
    const a = seed();
    const engine = makeEngine();
    await engine.tick();
    now += 30_000;
    await engine.tick(); // same slot — must not double-fire
    expect(deps.runTarget).toHaveBeenCalledTimes(1);
    expect(store.get(a.id)!.lastFiredAt).toBe(SH_9AM);
    const runs = store.listRuns(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'success', trigger: 'schedule', output: 'ok' });
  });

  it('skips disabled and unscheduled automations', async () => {
    seed({ enabled: false });
    seed({ schedule: undefined });
    await makeEngine().tick();
    expect(deps.runTarget).not.toHaveBeenCalled();
  });

  it('one automation with an invalid tz does not starve the others', async () => {
    seed({ name: 'broken', schedule: { hour: 9, minute: 0, tz: 'Beijing' } }); // Intl throws RangeError
    const good = seed({ name: 'good' });
    const logs: string[] = [];
    await makeEngine({ log: msg => logs.push(msg) }).tick();
    await new Promise(r => setTimeout(r, 0)); // tick fires runNow without awaiting it
    expect(deps.runTarget).toHaveBeenCalledTimes(1);
    expect(store.listRuns(good.id)).toHaveLength(1);
    expect(logs.some(l => l.includes('schedule eval failed for broken'))).toBe(true);
  });

  it('does nothing without the lease', async () => {
    fs.writeFileSync(path.join(dir, 'scheduler.lock'),
      JSON.stringify({ pid: 999999, role: 'daemon', heartbeatAt: now }));
    seed();
    const engine = makeEngine({ lease: new SchedulerLease(path.join(dir, 'scheduler.lock'), 'embedded') });
    await engine.tick();
    expect(deps.runTarget).not.toHaveBeenCalled();
  });
});

describe('runNow / execution', () => {
  it('records failed runs with the error', async () => {
    const a = seed();
    const engine = makeEngine({ runTarget: vi.fn(async () => ({ output: '', error: 'boom' })) });
    await engine.runNow(a.id, 'manual');
    expect(store.listRuns(a.id)[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('caps output and marks truncation', async () => {
    const a = seed();
    const engine = makeEngine({ runTarget: vi.fn(async () => ({ output: 'x'.repeat(OUTPUT_CAP + 100) })) });
    await engine.runNow(a.id, 'manual');
    const out = store.listRuns(a.id)[0].output!;
    expect(out.length).toBeLessThanOrEqual(OUTPUT_CAP + 50);
    expect(out).toContain('[output truncated]');
  });

  it('records parked runs with the question and emits run-parked', async () => {
    const a = seed();
    const engine = makeEngine({
      runTarget: vi.fn(async () => ({ output: 'partial', parked: { question: 'which?', options: ['a', 'b'] } })),
    });
    await engine.runNow(a.id, 'manual');
    expect(store.listRuns(a.id)[0]).toMatchObject({ status: 'parked', question: 'which?', options: ['a', 'b'] });
    expect(events.map(e => e.type)).toEqual(['run-started', 'run-parked']);
  });

  it('skips overlapping fires (active run) without a run record', async () => {
    const a = seed();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const engine = makeEngine({ runTarget: vi.fn(async () => { await gate; return { output: 'ok' }; }) });
    const first = engine.runNow(a.id, 'manual');
    await engine.runNow(a.id, 'manual'); // overlaps — skipped
    release!();
    await first;
    expect(store.listRuns(a.id)).toHaveLength(1);
  });

  it('skips firing while the latest run is parked', async () => {
    const a = seed();
    store.appendRun(a.id, { runId: 'r0', startedAt: now, status: 'parked', trigger: 'manual', question: 'q' });
    await makeEngine().runNow(a.id, 'manual');
    expect(deps.runTarget).not.toHaveBeenCalled();
  });

  it('records report delivery failures on the run', async () => {
    const a = seed();
    const engine = makeEngine({ report: vi.fn(async () => 'channel telegram not connected') });
    await engine.runNow(a.id, 'manual');
    expect(store.listRuns(a.id)[0].reportFailure).toBe('channel telegram not connected');
  });

  it('records reportFailure when report() throws', async () => {
    const a = seed();
    const engine = makeEngine({ report: vi.fn(async () => { throw new Error('notify daemon down'); }) });
    await engine.runNow(a.id, 'manual');
    expect(store.listRuns(a.id)[0]).toMatchObject({ status: 'success', reportFailure: 'notify daemon down' });
  });
});

describe('resume', () => {
  it('resumes the latest parked run and appends a linked resumed record', async () => {
    const a = seed();
    store.appendRun(a.id, { runId: 'r0', startedAt: now, status: 'parked', trigger: 'schedule', question: 'q' });
    await makeEngine().resume(a.id, 'r0', 'use option a');
    expect(deps.resumeTarget).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }), 'use option a');
    const [latest] = store.listRuns(a.id);
    expect(latest).toMatchObject({ status: 'resumed', resumedFrom: 'r0', output: 'resumed ok' });
  });

  it('consumes the parked continuation: a second resume of the same run rejects', async () => {
    const a = seed();
    store.appendRun(a.id, { runId: 'r0', startedAt: now, status: 'parked', trigger: 'schedule', question: 'q' });
    const engine = makeEngine();
    await engine.resume(a.id, 'r0', 'first answer');
    await expect(engine.resume(a.id, 'r0', 'second answer')).rejects.toThrow(/not parked/i);
    expect(deps.resumeTarget).toHaveBeenCalledTimes(1);
  });

  it('rejects resuming a non-parked run', async () => {
    const a = seed();
    store.appendRun(a.id, { runId: 'r0', startedAt: now, status: 'success', trigger: 'manual' });
    await expect(makeEngine().resume(a.id, 'r0', 'x')).rejects.toThrow(/not parked/i);
  });
});

describe('parked expiry', () => {
  it('expires parked runs older than the TTL to failed', async () => {
    const a = seed({ schedule: undefined });
    store.appendRun(a.id, { runId: 'r0', startedAt: now - PARKED_TTL_MS - 1, status: 'parked', trigger: 'schedule', question: 'q' });
    await makeEngine().tick();
    expect(store.listRuns(a.id)[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('expired') });
  });

  it('emits run-finished for the expired run', async () => {
    const a = seed({ schedule: undefined });
    store.appendRun(a.id, { runId: 'r0', startedAt: now - PARKED_TTL_MS - 1, status: 'parked', trigger: 'schedule', question: 'q' });
    await makeEngine().tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'run-finished', automationId: a.id, runId: 'r0',
      run: { status: 'failed', error: expect.stringContaining('expired') },
    });
  });

  it('is idempotent: a second tick after expiry does not patch or emit again', async () => {
    const a = seed({ schedule: undefined });
    store.appendRun(a.id, { runId: 'r0', startedAt: now - PARKED_TTL_MS - 1, status: 'parked', trigger: 'schedule', question: 'q' });
    const engine = makeEngine();
    await engine.tick();
    const afterFirst = events.length;
    now += 30_000;
    await engine.tick();
    expect(events).toHaveLength(afterFirst);
    expect(store.listRuns(a.id)).toHaveLength(1);
  });
});
