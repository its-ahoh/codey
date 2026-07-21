import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Automation, AutomationRun } from '@codey/core';
import { normalizeNotifyMode, normalizeSchedule } from '@codey/core';

/** Fields callers supply on create; id/timestamps are generated. */
export type AutomationDraft =
  Omit<Automation, 'id' | 'createdAt' | 'updatedAt' | 'lastFiredAt' | 'chatId'>;

const MAX_HISTORY_REWRITE = 500;

/**
 * Definitions in `<baseDir>/automations.json`, run history in
 * `<baseDir>/automation-runs/<id>.jsonl` (append-only; patch = bounded
 * rewrite). All definition writes are read-modify-write over the raw JSON so
 * unknown fields survive (forward-compat) and concurrent writers converge.
 *
 * Concurrency contract: concurrent read-modify-write cycles from two
 * processes can still lose one side's field-level change (last-writer-wins
 * on the whole doc); the design accepts this — re-reading the file
 * immediately before every write keeps the race window to microseconds, and
 * the scheduler lease ensures only one process fires schedules.
 */
export class AutomationStore {
  private readonly file: string;
  private readonly runsDir: string;

  constructor(baseDir: string) {
    this.file = path.join(baseDir, 'automations.json');
    this.runsDir = path.join(baseDir, 'automation-runs');
  }

  // ---- definitions ----

  private loadRaw(): Record<string, unknown> & { automations: Array<Record<string, unknown>> } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && Array.isArray(raw.automations)) return raw;
      throw new Error(`Automation store has an invalid root shape: ${this.file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { automations: [] };
      if (err instanceof SyntaxError) {
        throw new Error(`Automation store is corrupt; refusing to overwrite ${this.file}: ${err.message}`);
      }
      throw err;
    }
  }

  private writeRaw(raw: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Unique tmp per write: two processes share this store, so a fixed tmp
    // path could be truncated mid-write by the other side before rename.
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Re-reads the file, applies `fn` to the raw doc, writes atomically. */
  private mutate<T>(fn: (raw: { automations: Array<Record<string, unknown>> }) => T): T {
    const raw = this.loadRaw();
    const out = fn(raw);
    this.writeRaw(raw);
    return out;
  }

  list(): Automation[] {
    const automations = this.loadRaw().automations as unknown as Automation[];
    // Read-side migration: pre-mode files stored notify as a boolean (any
    // unrecognized value normalizes to 'none') and schedules as a single
    // {hour, minute}. The raw values are left on disk untouched until the
    // next definition write. A garbage schedule drops to manual-only rather
    // than reaching the scheduler's Intl calls.
    for (const a of automations) {
      if (a.report) a.report.notify = normalizeNotifyMode(a.report.notify);
      if (a.schedule) a.schedule = normalizeSchedule(a.schedule);
    }
    return automations;
  }

  get(id: string): Automation | undefined {
    return this.list().find(a => a.id === id);
  }

  create(draft: AutomationDraft, now: number): Automation {
    return this.mutate(raw => {
      const normalizedSchedule = draft.schedule ? normalizeSchedule(draft.schedule) : undefined;
      const a = {
        ...draft,
        schedule: normalizedSchedule,
        id: randomUUID(), createdAt: now, updatedAt: now,
      } as Automation;
      raw.automations.push(a as unknown as Record<string, unknown>);
      return a;
    });
  }

  update(id: string, patch: Partial<Automation>, now: number): Automation {
    return this.mutate(raw => {
      const cur = raw.automations.find(a => a.id === id);
      if (!cur) throw new Error(`Automation not found: ${id}`);
      if ('schedule' in patch) {
        const normalized = patch.schedule ? normalizeSchedule(patch.schedule) : undefined;
        patch = { ...patch, schedule: normalized };
      } else if (cur.schedule) {
        // Any write is also a migration opportunity, so changing an unrelated
        // field on a legacy automation cannot return the old schedule shape.
        cur.schedule = normalizeSchedule(cur.schedule);
      }
      Object.assign(cur, patch, { updatedAt: now });
      return cur as unknown as Automation;
    });
  }

  delete(id: string): void {
    AutomationStore.assertSafeId(id);
    this.mutate(raw => {
      if (!raw.automations.some(a => a.id === id)) throw new Error(`Automation not found: ${id}`);
      raw.automations = raw.automations.filter(a => a.id !== id);
    });
    try { fs.unlinkSync(this.runFile(id)); } catch { /* no history yet */ }
    try { fs.rmSync(this.runLogDir(id), { recursive: true, force: true }); } catch { /* no logs yet */ }
  }

  setEnabled(id: string, enabled: boolean, now: number): Automation {
    return this.update(id, { enabled }, now);
  }

  /** lastFiredAt bump without touching updatedAt (not a user edit). */
  recordLastFired(id: string, ts: number): void {
    const raw = this.loadRaw();
    const cur = raw.automations.find(a => a.id === id);
    if (!cur) return; // unknown id — don't rewrite the file for a no-op
    cur.lastFiredAt = ts;
    this.writeRaw(raw);
  }

  // ---- run history ----

  private runFile(id: string): string {
    AutomationStore.assertSafeId(id);
    return path.join(this.runsDir, `${id}.jsonl`);
  }

  appendRun(id: string, run: AutomationRun): void {
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.appendFileSync(this.runFile(id), JSON.stringify(run) + '\n', 'utf8');
  }

  /** Newest-first. Skips unparseable lines. */
  listRuns(id: string, limit?: number): AutomationRun[] {
    AutomationStore.assertSafeId(id);
    let text: string;
    try { text = fs.readFileSync(this.runFile(id), 'utf8'); } catch { return []; }
    const runs: AutomationRun[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { runs.push(JSON.parse(line)); } catch { /* corrupt line — skip */ }
    }
    runs.reverse();
    return limit !== undefined ? runs.slice(0, limit) : runs;
  }

  // ---- run activity logs ----

  private runLogDir(id: string): string {
    return path.join(this.runsDir, id);
  }

  private runLogFile(id: string, runId: string): string {
    return path.join(this.runLogDir(id), `${runId}.log`);
  }

  /** IDs come over IPC — refuse anything that could escape runsDir. */
  private static isSafeId(s: string): boolean {
    return typeof s === 'string' && /^[\w-]+$/.test(s);
  }

  private static assertSafeId(s: string): void {
    if (!AutomationStore.isSafeId(s)) throw new Error(`Invalid automation or run id: ${String(s)}`);
  }

  /** Append one activity-log line. Failures are the caller's to swallow —
   *  logging must never fail a run. */
  appendRunLog(id: string, runId: string, line: string): void {
    if (!AutomationStore.isSafeId(id) || !AutomationStore.isSafeId(runId)) return;
    fs.mkdirSync(this.runLogDir(id), { recursive: true });
    fs.appendFileSync(this.runLogFile(id, runId), line + '\n', 'utf8');
  }

  /** Full activity log for a run, or undefined if none was written. */
  readRunLog(id: string, runId: string): string | undefined {
    if (!AutomationStore.isSafeId(id) || !AutomationStore.isSafeId(runId)) return undefined;
    try { return fs.readFileSync(this.runLogFile(id, runId), 'utf8'); } catch { return undefined; }
  }

  /** Read-patch-rewrite (atomic). Caps retained history at MAX_HISTORY_REWRITE. */
  patchRun(id: string, runId: string, patch: Partial<AutomationRun>): void {
    AutomationStore.assertSafeId(id);
    AutomationStore.assertSafeId(runId);
    const oldestFirst = this.listRuns(id).reverse().slice(-MAX_HISTORY_REWRITE);
    let found = false;
    const lines = oldestFirst.map(r => {
      if (r.runId === runId) { found = true; return JSON.stringify({ ...r, ...patch }); }
      return JSON.stringify(r);
    });
    if (!found) return;
    const tmp = `${this.runFile(id)}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, this.runFile(id));
  }

  markSeen(id: string, runId: string, now: number): void {
    this.patchRun(id, runId, { seenAt: now });
  }
}
