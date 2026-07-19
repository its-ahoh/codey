// packages/gateway/src/automations/engine.ts
import { randomUUID } from 'crypto';
import type { Automation, AutomationEvent, AutomationRun } from '@codey/core';
import { AutomationStore } from './store';
import { SchedulerLease } from './lease';
import { shouldFire } from './schedule';
import type { ParkedInfo } from './parked';

export const OUTPUT_CAP = 32_000;
export const PARKED_TTL_MS = 7 * 24 * 3600_000;
export const TICK_MS = 30_000;

export interface TargetResult { output: string; parked?: ParkedInfo; error?: string }

export interface EngineDeps {
  store: AutomationStore;
  lease: SchedulerLease;
  /** Execute the automation's rendered brief headlessly (gateway adapter).
   *  `runId` identifies the run for per-run activity logging. */
  runTarget: (a: Automation, runId: string) => Promise<TargetResult>;
  /** Feed an answer into the parked continuation (gateway adapter).
   *  `runId` is the NEW (resuming) run's id, not the parked one's. */
  resumeTarget: (a: Automation, answer: string, runId: string) => Promise<TargetResult>;
  /** Deliver report.channel / prep notify. Returns a failure description or undefined. */
  report: (a: Automation, run: AutomationRun) => Promise<string | undefined>;
  onEvent?: (ev: AutomationEvent) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

function capOutput(s: string): string {
  if (s.length <= OUTPUT_CAP) return s;
  return `${s.slice(0, OUTPUT_CAP)}\n\n[output truncated]`;
}

export class AutomationEngine {
  private timer?: NodeJS.Timeout;
  /** Per-process overlap guard only; a concurrent embedded-gateway runNow is accepted single-user risk (v1). */
  private active = new Set<string>();
  private _isLeader = false;

  constructor(private deps: EngineDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private log(msg: string): void { this.deps.log?.(msg); }
  private emit(ev: AutomationEvent): void { try { this.deps.onEvent?.(ev); } catch { /* listener bug must not kill runs */ } }

  get isLeader(): boolean { return this._isLeader; }

  start(tickMs: number = TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(err => this.log(`tick failed: ${err?.message}`)); }, tickMs);
    this.timer.unref?.();
    void this.tick().catch(err => this.log(`tick failed: ${err?.message}`));
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.deps.lease.release();
    this._isLeader = false;
  }

  async tick(): Promise<void> {
    const now = this.now();
    this._isLeader = this.deps.lease.heartbeat(now) || this.deps.lease.tryAcquire(now);
    if (!this._isLeader) return;
    // Leader-only: patchRun is a whole-file rewrite, so a non-leader running
    // expiry could clobber the leader's concurrent appendRun.
    this.expireParked(now);
    for (const a of this.deps.store.list()) {
      // One automation with garbage data (e.g. an invalid tz makes Intl throw
      // a RangeError inside shouldFire) must not abort the whole tick and
      // starve every other schedule.
      try {
        if (!a.enabled || !a.schedule) continue;
        if (!shouldFire(a.schedule, a.lastFiredAt, now)) continue;
        // Record the slot BEFORE running so a crash mid-run can't re-fire it.
        this.deps.store.recordLastFired(a.id, now);
        void this.runNow(a.id, 'schedule').catch(err => this.log(`scheduled run failed: ${err?.message}`));
      } catch (err) {
        this.log(`schedule eval failed for ${a.name}: ${(err as Error)?.message}`);
      }
    }
  }

  /** Manual + scheduled entry. Works without the lease (spec: non-leaders serve runNow). */
  async runNow(id: string, trigger: 'manual' | 'schedule'): Promise<AutomationRun | null> {
    const a = this.deps.store.get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    if (this.active.has(id)) { this.log(`skip ${a.name}: previous run still active`); return null; }
    const latest = this.deps.store.listRuns(id, 1)[0];
    if (latest?.status === 'parked') { this.log(`skip ${a.name}: parked run awaiting an answer`); return null; }
    return this.execute(a, trigger, (auto, runId) => this.deps.runTarget(auto, runId));
  }

  /** Answer a parked run's question; appends a linked 'resumed' record. */
  async resume(id: string, runId: string, answer: string): Promise<AutomationRun> {
    const a = this.deps.store.get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    const parked = this.deps.store.listRuns(id).find(r => r.runId === runId);
    if (!parked || parked.status !== 'parked') throw new Error(`Run ${runId} is not parked`);
    if (this.active.has(id)) throw new Error(`Automation ${a.name} already has an active run`);
    const run = await this.execute(a, parked.trigger, (auto, newRunId) => this.deps.resumeTarget(auto, answer, newRunId), runId);
    // The attempt consumed the parked continuation whether it succeeded or
    // failed, so the original run must stop being answerable — the "not
    // parked" rejection above then also catches second answers.
    this.deps.store.patchRun(a.id, runId, { status: 'resumed' });
    return run;
  }

  private async execute(
    a: Automation,
    trigger: 'manual' | 'schedule',
    exec: (a: Automation, runId: string) => Promise<TargetResult>,
    resumedFrom?: string,
  ): Promise<AutomationRun> {
    this.active.add(a.id);
    const run: AutomationRun = {
      runId: randomUUID(), startedAt: this.now(), status: 'failed', trigger, resumedFrom,
    };
    this.emit({ type: 'run-started', automationId: a.id, runId: run.runId });
    try {
      const res = await exec(a, run.runId);
      run.output = capOutput(res.output ?? '');
      if (res.parked) {
        run.status = 'parked';
        run.question = res.parked.question;
        run.options = res.parked.options;
      } else if (res.error) {
        run.status = 'failed';
        run.error = res.error;
      } else {
        run.status = resumedFrom ? 'resumed' : 'success';
      }
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message;
    } finally {
      this.active.delete(a.id);
    }
    run.endedAt = this.now();
    try {
      run.reportFailure = await this.deps.report(a, run);
    } catch (err) {
      run.reportFailure = (err as Error).message;
    }
    this.deps.store.appendRun(a.id, run);
    this.emit({
      type: run.status === 'parked' ? 'run-parked' : 'run-finished',
      automationId: a.id, runId: run.runId, run,
    });
    return run;
  }

  /** Parked questions older than the TTL fail out — a changed world shouldn't resume. */
  private expireParked(now: number): void {
    for (const a of this.deps.store.list()) {
      const latest = this.deps.store.listRuns(a.id, 1)[0];
      if (latest?.status === 'parked' && now - latest.startedAt > PARKED_TTL_MS) {
        const error = 'parked question expired after 7 days without an answer';
        this.deps.store.patchRun(a.id, latest.runId, { status: 'failed', error });
        // Expiry must not be silent; notifying is the UI layer's job via the event.
        this.emit({
          type: 'run-finished', automationId: a.id, runId: latest.runId,
          run: { ...latest, status: 'failed', error },
        });
      }
    }
  }
}
