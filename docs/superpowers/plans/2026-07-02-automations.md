# Codey Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled + run-now automations: a frozen, interview-synthesized brief runs a prompt or team headlessly via a hidden system chat, with lease-guarded scheduling, parked-run resume, run history, and a Mac Automations view.

**Architecture:** New `automations/` module in `@codey/gateway` (store, schedule eval, lease, engine, interview manager) wired into the `Codey` class. Execution reuses the existing `sendToChat` pipeline by giving each automation a **hidden system chat** (`kind: 'automation'`) — team pause/resume (`chat.pendingTeam` + `resumeTeamFromAnswer`) then works unchanged. Interviewer prompts live in `@codey/core` beside `aide-tasks.ts` and run through the existing Aide (`runAideJson`). The Mac app is a pure IPC client (list/editor/interview/history) following the existing `workers:*` handler pattern.

**Tech Stack:** TypeScript (ES2020/CommonJS, strict), Vitest, Electron IPC, React renderer. No new dependencies (schedule evaluation uses `Intl.DateTimeFormat`, not a cron lib).

**Spec:** `docs/superpowers/specs/2026-07-02-automations-design.md`. Three grounded deviations, folded back into the spec in Task 12:
1. `target` carries `workspaceName` instead of `workingDir` — `sendToChat` resolves workingDir from the chat's workspace (`gateway.ts:4032-4055`); this reuses that instead of a parallel mechanism.
2. `Automation` gains `chatId` — the hidden system chat it executes in.
3. `AutomationRun` gains `question`/`options` (parked) and `resumedFrom` (resume linkage).

**Environment (read first):**
- Node: the default node v16 cannot run vitest/tsc. Prefix every build/test command with `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH"` (or `source ~/.nvm/nvm.sh && nvm use 22.17.1`).
- Work from repo root `/path/to/codey`, branch `feat/automations`.
- `codey-mac` consumes `@codey/core`/`@codey/gateway` from `dist/` — after changing those packages run `npm run build -w @codey/core -w @codey/gateway` before touching mac code.
- Test one workspace: `npm test -w @codey/gateway -- <pattern>`. Full suite: `npm test`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/types/automation.ts` | Create | Shared `Automation`/`AutomationRun`/schedule/target types |
| `packages/core/src/types/index.ts` | Modify | Re-export automation types (line ~290, beside `export * from './chat'`) |
| `packages/core/src/types/chat.ts` | Modify | `Chat.kind?: 'automation'` (line ~92) |
| `packages/core/src/types/index.ts` (GatewayConfig) | Modify | `automationRole?: 'daemon' \| 'embedded'` |
| `packages/core/src/aide-automation.ts` | Create | Interview question/followup/synthesis prompts + `renderBrief` |
| `packages/core/src/index.ts` | Modify | `export * from './aide-automation'` |
| `packages/gateway/src/automations/schedule.ts` | Create | Pure time-of-day schedule evaluation (tz via `Intl`) |
| `packages/gateway/src/automations/store.ts` | Create | `automations.json` CRUD + per-id `.jsonl` run history |
| `packages/gateway/src/automations/lease.ts` | Create | Scheduler lease lockfile (daemon-wins) |
| `packages/gateway/src/automations/engine.ts` | Create | Tick loop, runNow, executeAutomation, resume, expiry, result routing |
| `packages/gateway/src/automations/parked.ts` | Create | Pure parked-detection helper |
| `packages/gateway/src/automations/report.ts` | Create | Pure run-summary formatting |
| `packages/gateway/src/automations/interview.ts` | Create | Interview session state machine (bounded followups) |
| `packages/gateway/src/chats.ts` | Modify | `CreateChatInput.kind/agent/model` (line 9); `list()` hides automation chats (line 125) |
| `packages/gateway/src/gateway.ts` | Modify | Wire store/engine/interviews into `Codey`; hidden-chat adapter; public API |
| `codey-mac/electron/automation-notifications.ts` | Create | Pure notification/unseen-scan decisions |
| `codey-mac/electron/main.ts` | Modify | `automations:*` IPC handlers, event forwarding, launch scan |
| `codey-mac/electron/preload.ts` | Modify | `window.codey.automations` bridge |
| `codey-mac/src/components/automationsModel.ts` | Create | Pure renderer helpers (schedule summary, guards) |
| `codey-mac/src/components/AutomationsView.tsx` | Create | List / editor+interview / run history view |
| `codey-mac/src/App.tsx` | Modify | Navigation entry for the Automations view |

---

### Task 1: Shared automation types in `@codey/core`

**Files:**
- Create: `packages/core/src/types/automation.ts`
- Modify: `packages/core/src/types/index.ts` (add re-export at line ~290 and `automationRole` on `GatewayConfig`)
- Modify: `packages/core/src/types/chat.ts` (add `kind` to `Chat`, line ~92)

- [ ] **Step 1: Create the types file**

```ts
// packages/core/src/types/automation.ts
import { CodingAgent } from './index';

/** Structured time-of-day schedule (spec decision #10 — not a cron string). */
export interface AutomationSchedule {
  /** 0-23, in `tz`. */
  hour: number;
  /** 0-59. */
  minute: number;
  /** 0=Sun … 6=Sat. Absent = every day. */
  daysOfWeek?: number[];
  /** IANA zone, e.g. "Asia/Shanghai". */
  tz: string;
}

export type AutomationTarget =
  | { kind: 'prompt'; workspaceName: string; agent?: CodingAgent; model?: string }
  | { kind: 'team'; teamName: string; workspaceName: string };

export interface AutomationReport {
  /** Fire an OS notification (delivered by the Mac app when attached). */
  notify: boolean;
  /** Optional chat/channel post, e.g. { platform: 'telegram', target: '<chatId>' }. */
  channel?: { platform: string; target: string };
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  target: AutomationTarget;
  /** Frozen, self-contained instruction block synthesized by the interview.
   *  May contain {{param}} placeholders resolved from `params` at run time. */
  brief: string;
  /** Surfaced editable knobs. Editing these does not re-open the interview. */
  params: Record<string, string>;
  /** Absent = manual-only. */
  schedule?: AutomationSchedule;
  report: AutomationReport;
  /** Hidden system chat this automation executes in (created lazily). */
  chatId?: string;
  /** Last slot fired, for double-fire protection. Never used to back-fire. */
  lastFiredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type AutomationRunStatus = 'success' | 'failed' | 'parked' | 'resumed';

export interface AutomationRun {
  runId: string;
  startedAt: number;
  endedAt?: number;
  status: AutomationRunStatus;
  trigger: 'manual' | 'schedule';
  /** Capped at OUTPUT_CAP chars by the engine; truncation is marked. */
  output?: string;
  error?: string;
  /** Pending question when status === 'parked'. */
  question?: string;
  /** Choice options when the parked question was [ASK_USER:choice]. */
  options?: string[];
  /** runId of the parked run this record resumed. */
  resumedFrom?: string;
  /** notify/channel delivery failure, recorded not just logged. */
  reportFailure?: string;
  /** Set when the Mac app has surfaced this result. */
  seenAt?: number;
}

export interface AutomationEvent {
  type: 'run-started' | 'run-finished' | 'run-parked';
  automationId: string;
  runId: string;
  run?: AutomationRun;
}
```

- [ ] **Step 2: Re-export from the types barrel**

In `packages/core/src/types/index.ts`, next to the existing `export * from './chat';` (line ~290), add:

```ts
export * from './automation';
```

- [ ] **Step 3: Add `automationRole` to `GatewayConfig`**

In `packages/core/src/types/index.ts`, find `export interface GatewayConfig` and add one optional field (with the other optional fields):

```ts
  /** Which scheduler-lease role this process claims. Daemon wins over embedded.
   *  Default 'daemon' (the standalone gateway). The Mac app passes 'embedded'. */
  automationRole?: 'daemon' | 'embedded';
```

- [ ] **Step 4: Add `kind` to `Chat`**

In `packages/core/src/types/chat.ts` inside `export interface Chat` (line ~92, after `workspaceName`):

```ts
  /** 'automation' marks a hidden system chat owned by an automation; absent = normal user chat. */
  kind?: 'automation';
```

- [ ] **Step 5: Build core to verify types compile**

Run: `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH" && npm run build -w @codey/core`
Expected: exit 0, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types/automation.ts packages/core/src/types/index.ts packages/core/src/types/chat.ts
git commit -m "feat(core): automation types, Chat.kind, GatewayConfig.automationRole"
```

---

### Task 2: Schedule evaluation (pure, tz-aware)

**Files:**
- Create: `packages/gateway/src/automations/schedule.ts`
- Test: `packages/gateway/src/automations/schedule.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/src/automations/schedule.test.ts
import { describe, it, expect } from 'vitest';
import { localParts, slotId, shouldFire } from './schedule';
import type { AutomationSchedule } from '@codey/core';

// 2026-07-02T09:00:00 in Asia/Shanghai is 2026-07-02T01:00:00Z
const SH_9AM = Date.UTC(2026, 6, 2, 1, 0, 0);
const sched = (over: Partial<AutomationSchedule> = {}): AutomationSchedule =>
  ({ hour: 9, minute: 0, tz: 'Asia/Shanghai', ...over });

describe('localParts', () => {
  it('converts an instant into tz-local wall-clock parts', () => {
    const p = localParts(SH_9AM, 'Asia/Shanghai');
    expect(p).toMatchObject({ hour: 9, minute: 0, dayOfWeek: 4 }); // Thursday
  });
  it('handles midnight as hour 0, not 24', () => {
    const p = localParts(Date.UTC(2026, 6, 1, 16, 0, 0), 'Asia/Shanghai'); // 2026-07-02 00:00 SH
    expect(p.hour).toBe(0);
  });
});

describe('shouldFire', () => {
  it('fires when local hour:minute matches and no prior fire', () => {
    expect(shouldFire(sched(), undefined, SH_9AM)).toBe(true);
  });
  it('does not fire off-slot', () => {
    expect(shouldFire(sched(), undefined, SH_9AM + 60_000)).toBe(false);
  });
  it('does not double-fire within the same minute slot', () => {
    expect(shouldFire(sched(), SH_9AM, SH_9AM + 30_000)).toBe(false);
  });
  it('fires again the next day', () => {
    expect(shouldFire(sched(), SH_9AM, SH_9AM + 24 * 3600_000)).toBe(true);
  });
  it('never back-fires: a missed slot simply does not match', () => {
    // Process restarts at 12:00 having missed the 09:00 slot.
    expect(shouldFire(sched(), undefined, SH_9AM + 3 * 3600_000)).toBe(false);
  });
  it('respects daysOfWeek', () => {
    // SH_9AM is a Thursday (4)
    expect(shouldFire(sched({ daysOfWeek: [4] }), undefined, SH_9AM)).toBe(true);
    expect(shouldFire(sched({ daysOfWeek: [0, 6] }), undefined, SH_9AM)).toBe(false);
  });
  it('evaluates in the schedule tz, not UTC (DST-safe)', () => {
    // 2026-03-08 02:30 America/New_York does not exist (spring forward).
    // 09:00 NY on 2026-11-01 (fall back day) is 14:00Z.
    const nyFallBack9am = Date.UTC(2026, 10, 1, 14, 0, 0);
    expect(shouldFire(sched({ tz: 'America/New_York' }), undefined, nyFallBack9am)).toBe(true);
  });
});

describe('slotId', () => {
  it('is stable within a minute and distinct across minutes', () => {
    expect(slotId(SH_9AM, 'Asia/Shanghai')).toBe(slotId(SH_9AM + 59_000, 'Asia/Shanghai'));
    expect(slotId(SH_9AM, 'Asia/Shanghai')).not.toBe(slotId(SH_9AM + 60_000, 'Asia/Shanghai'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH" && npm test -w @codey/gateway -- automations/schedule`
Expected: FAIL — cannot resolve `./schedule`.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/automations/schedule.ts
import type { AutomationSchedule } from '@codey/core';

/** Wall-clock parts of an instant in an IANA time zone. */
export interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number;
  /** 0=Sun … 6=Sat */
  dayOfWeek: number;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    dayOfWeek: DOW[parts.weekday] ?? 0,
  };
}

/** Minute-granularity identity of the slot `ms` falls in, in `tz`. */
export function slotId(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * True when `now` lands in the schedule's minute slot and that slot hasn't
 * fired yet. Missed slots never match later instants — restart-safe, no
 * back-fire by construction.
 */
export function shouldFire(
  schedule: AutomationSchedule,
  lastFiredAt: number | undefined,
  now: number,
): boolean {
  const p = localParts(now, schedule.tz);
  if (p.hour !== schedule.hour || p.minute !== schedule.minute) return false;
  if (schedule.daysOfWeek && !schedule.daysOfWeek.includes(p.dayOfWeek)) return false;
  if (lastFiredAt !== undefined && slotId(lastFiredAt, schedule.tz) === slotId(now, schedule.tz)) return false;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/schedule`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/schedule.ts packages/gateway/src/automations/schedule.test.ts
git commit -m "feat(gateway): tz-aware time-of-day schedule evaluation for automations"
```

---

### Task 3: AutomationStore (definitions + run history)

**Files:**
- Create: `packages/gateway/src/automations/store.ts`
- Test: `packages/gateway/src/automations/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/src/automations/store.test.ts
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
  report: { notify: true },
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/store`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/automations/store.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Automation, AutomationRun } from '@codey/core';

/** Fields callers supply on create; id/timestamps are generated. */
export type AutomationDraft =
  Omit<Automation, 'id' | 'createdAt' | 'updatedAt' | 'lastFiredAt' | 'chatId'>;

const MAX_HISTORY_REWRITE = 500;

/**
 * Definitions in `<baseDir>/automations.json`, run history in
 * `<baseDir>/automation-runs/<id>.jsonl` (append-only; patch = bounded
 * rewrite). All definition writes are read-modify-write over the raw JSON so
 * unknown fields survive (forward-compat) and concurrent writers converge.
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
    } catch { /* first run or unreadable — start fresh */ }
    return { automations: [] };
  }

  private writeRaw(raw: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
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
    return this.loadRaw().automations as unknown as Automation[];
  }

  get(id: string): Automation | undefined {
    return this.list().find(a => a.id === id);
  }

  create(draft: AutomationDraft, now: number): Automation {
    return this.mutate(raw => {
      const a: Automation = { ...draft, id: randomUUID(), createdAt: now, updatedAt: now };
      raw.automations.push(a as unknown as Record<string, unknown>);
      return a;
    });
  }

  update(id: string, patch: Partial<Automation>, now: number): Automation {
    return this.mutate(raw => {
      const cur = raw.automations.find(a => a.id === id);
      if (!cur) throw new Error(`Automation not found: ${id}`);
      Object.assign(cur, patch, { updatedAt: now });
      return cur as unknown as Automation;
    });
  }

  delete(id: string): void {
    this.mutate(raw => {
      raw.automations = raw.automations.filter(a => a.id !== id);
    });
    try { fs.unlinkSync(this.runFile(id)); } catch { /* no history yet */ }
  }

  setEnabled(id: string, enabled: boolean, now: number): Automation {
    return this.update(id, { enabled }, now);
  }

  /** lastFiredAt bump without touching updatedAt (not a user edit). */
  recordLastFired(id: string, ts: number): void {
    this.mutate(raw => {
      const cur = raw.automations.find(a => a.id === id);
      if (cur) cur.lastFiredAt = ts;
    });
  }

  // ---- run history ----

  private runFile(id: string): string {
    return path.join(this.runsDir, `${id}.jsonl`);
  }

  appendRun(id: string, run: AutomationRun): void {
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.appendFileSync(this.runFile(id), JSON.stringify(run) + '\n', 'utf8');
  }

  /** Newest-first. Skips unparseable lines. */
  listRuns(id: string, limit?: number): AutomationRun[] {
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

  /** Read-patch-rewrite (atomic). Caps retained history at MAX_HISTORY_REWRITE. */
  patchRun(id: string, runId: string, patch: Partial<AutomationRun>): void {
    const oldestFirst = this.listRuns(id).reverse().slice(-MAX_HISTORY_REWRITE);
    let found = false;
    const lines = oldestFirst.map(r => {
      if (r.runId === runId) { found = true; return JSON.stringify({ ...r, ...patch }); }
      return JSON.stringify(r);
    });
    if (!found) return;
    const tmp = `${this.runFile(id)}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, this.runFile(id));
  }

  markSeen(id: string, runId: string, now: number): void {
    this.patchRun(id, runId, { seenAt: now });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/store`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/store.ts packages/gateway/src/automations/store.test.ts
git commit -m "feat(gateway): AutomationStore — definitions json + per-id run-history jsonl"
```

---

### Task 4: Scheduler lease (daemon-wins lockfile)

**Files:**
- Create: `packages/gateway/src/automations/lease.ts`
- Test: `packages/gateway/src/automations/lease.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/src/automations/lease.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SchedulerLease } from './lease';

let lock: string;
beforeEach(() => {
  lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')), 'scheduler.lock');
});

const STALE = 90_000;
const write = (pid: number, role: 'daemon' | 'embedded', heartbeatAt: number) =>
  fs.writeFileSync(lock, JSON.stringify({ pid, role, heartbeatAt }));

describe('SchedulerLease', () => {
  it('acquires when no lock exists', () => {
    expect(new SchedulerLease(lock, 'embedded', STALE).tryAcquire(1000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
  });

  it('embedded does not steal a live daemon lock', () => {
    write(99999, 'daemon', 1000);
    expect(new SchedulerLease(lock, 'embedded', STALE).tryAcquire(2000)).toBe(false);
  });

  it('daemon steals a live embedded lock', () => {
    write(99999, 'embedded', 1000);
    expect(new SchedulerLease(lock, 'daemon', STALE).tryAcquire(2000)).toBe(true);
  });

  it('anyone steals a stale lock', () => {
    write(99999, 'daemon', 1000);
    expect(new SchedulerLease(lock, 'embedded', STALE).tryAcquire(1000 + STALE + 1)).toBe(true);
  });

  it('re-acquire by the same pid refreshes the heartbeat', () => {
    const l = new SchedulerLease(lock, 'daemon', STALE);
    l.tryAcquire(1000);
    expect(l.tryAcquire(5000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).heartbeatAt).toBe(5000);
  });

  it('heartbeat returns false after another process claims (stand-down)', () => {
    const l = new SchedulerLease(lock, 'embedded', STALE);
    l.tryAcquire(1000);
    write(99999, 'daemon', 2000); // daemon stole it
    expect(l.heartbeat(3000)).toBe(false);
  });

  it('release removes our lock but not a foreign one', () => {
    const l = new SchedulerLease(lock, 'daemon', STALE);
    l.tryAcquire(1000);
    l.release();
    expect(fs.existsSync(lock)).toBe(false);
    write(99999, 'daemon', 1000);
    l.release();
    expect(fs.existsSync(lock)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/lease`
Expected: FAIL — cannot resolve `./lease`.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/automations/lease.ts
import * as fs from 'fs';
import * as path from 'path';

interface LeaseFile { pid: number; role: 'daemon' | 'embedded'; heartbeatAt: number }

export const DEFAULT_STALE_MS = 90_000; // 3 × 30s ticks

/**
 * Single-scheduler lease over a lockfile. Daemon wins over embedded; anyone
 * takes a stale lock. Steal is unlink + exclusive create — a same-host race
 * loses one write and converges next tick, which is acceptable at 30s cadence.
 */
export class SchedulerLease {
  constructor(
    private readonly lockPath: string,
    private readonly role: 'daemon' | 'embedded',
    private readonly staleMs: number = DEFAULT_STALE_MS,
  ) {}

  private read(): LeaseFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (typeof raw?.pid === 'number' && typeof raw?.heartbeatAt === 'number') return raw;
    } catch { /* absent or corrupt */ }
    return null;
  }

  private write(now: number): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, role: this.role, heartbeatAt: now }));
  }

  /** True when this process holds the lease after the call. */
  tryAcquire(now: number): boolean {
    const cur = this.read();
    if (cur && cur.pid === process.pid) { this.write(now); return true; }
    const stale = !cur || now - cur.heartbeatAt > this.staleMs;
    const daemonSteal = this.role === 'daemon' && cur?.role === 'embedded';
    if (cur && !stale && !daemonSteal) return false;
    try {
      if (cur) { try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ } }
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, role: this.role, heartbeatAt: now }), { flag: 'wx' });
      return true;
    } catch {
      return false; // lost the race
    }
  }

  /** Refresh if we still hold it; false = someone else claimed → stand down. */
  heartbeat(now: number): boolean {
    const cur = this.read();
    if (!cur || cur.pid !== process.pid) return false;
    this.write(now);
    return true;
  }

  release(): void {
    const cur = this.read();
    if (cur && cur.pid === process.pid) {
      try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/lease`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/lease.ts packages/gateway/src/automations/lease.test.ts
git commit -m "feat(gateway): scheduler lease lockfile — daemon wins, stale-steal, stand-down"
```

---

### Task 5: Interviewer prompts + brief rendering in `@codey/core`

**Files:**
- Create: `packages/core/src/aide-automation.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './aide-automation';` beside the other barrel lines)
- Test: `packages/core/src/aide-automation.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/aide-automation.test.ts
import { describe, it, expect } from 'vitest';
import {
  generateAutomationQuestions, generateAutomationFollowup,
  synthesizeAutomationBrief, renderBrief,
} from './aide-automation';
import type { AideOptions, AgentRequest, AgentResponse } from './types';

const aide = (output: string): AideOptions => ({
  agent: 'claude-code',
  runner: async (_req: AgentRequest): Promise<AgentResponse> =>
    ({ success: true, output } as AgentResponse),
});

describe('generateAutomationQuestions', () => {
  it('parses questions from Aide JSON', async () => {
    const qs = await generateAutomationQuestions('post AI news daily', 'target: prompt',
      aide('{"questions":[{"id":"q1","question":"Which X account?","why":"needed to post"}]}'));
    expect(qs).toEqual([{ id: 'q1', question: 'Which X account?', why: 'needed to post' }]);
  });
  it('returns [] on malformed output', async () => {
    expect(await generateAutomationQuestions('g', 't', aide('not json'))).toEqual([]);
  });
});

describe('generateAutomationFollowup', () => {
  it('returns the follow-up question or null', async () => {
    expect(await generateAutomationFollowup('g', 'Which account?', 'the usual',
      aide('{"followup":"Which one is \\"the usual\\"?"}'))).toBe('Which one is "the usual"?');
    expect(await generateAutomationFollowup('g', 'q', 'a', aide('{"followup":null}'))).toBeNull();
  });
});

describe('synthesizeAutomationBrief', () => {
  it('returns brief + params from Aide JSON', async () => {
    const out = await synthesizeAutomationBrief('g', [{ question: 'q', answer: 'a' }],
      aide('{"brief":"Post to {{account}}.","params":{"account":"@jack"}}'));
    expect(out.brief).toBe('Post to {{account}}.');
    expect(out.params).toEqual({ account: '@jack' });
  });
  it('throws when the Aide returns no brief', async () => {
    await expect(synthesizeAutomationBrief('g', [], aide('{}'))).rejects.toThrow();
  });
});

describe('renderBrief', () => {
  it('substitutes placeholders and appends leftovers as a Parameters block', () => {
    const out = renderBrief('Post {{count}} items to {{account}}.', {
      count: '5', account: '@jack', tone: 'dry',
    });
    expect(out).toContain('Post 5 items to @jack.');
    expect(out).toContain('Parameters:\n- tone: dry');
  });
  it('leaves unknown placeholders intact and skips the block when all used', () => {
    expect(renderBrief('Hi {{who}}', {})).toBe('Hi {{who}}');
    expect(renderBrief('Hi {{who}}', { who: 'you' })).toBe('Hi you');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/core -- aide-automation`
Expected: FAIL — cannot resolve `./aide-automation`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/aide-automation.ts
import { AideOptions } from './types';
import { runAideJson } from './aide';

/** One clarification question surfaced by the authoring interview. */
export interface InterviewQuestion { id: string; question: string; why?: string }
export interface InterviewAnswer { question: string; answer: string }

const QUESTIONS_PROMPT = (goal: string, targetContext: string) => `You are preparing an UNATTENDED automation. It will run on a schedule with nobody available to answer questions, so every ambiguity must be resolved NOW, at authoring time.

Automation goal:
${goal}

Execution target:
${targetContext}

List the questions you would otherwise need answered mid-run: missing specifics, choices, accounts/handles, formats, limits, and edge cases (e.g. "what if there is nothing to report today?"). Ask only what materially changes the run. 3-7 questions.

Respond with ONLY this JSON:
{"questions":[{"id":"q1","question":"...","why":"one-line reason"}]}`;

const FOLLOWUP_PROMPT = (goal: string, question: string, answer: string) => `An automation is being configured. Goal: ${goal}

You asked: ${question}
The user answered: ${answer}

If — and only if — this answer opens exactly one NEW concrete gap that would block an unattended run, ask one short follow-up. Otherwise return null.

Respond with ONLY this JSON:
{"followup":"..." }  or  {"followup":null}`;

const SYNTHESIS_PROMPT = (goal: string, qa: InterviewAnswer[]) => `Fold this automation goal and the clarification answers into a frozen, fully self-contained instruction brief for an UNATTENDED agent run. The brief must stand alone: no references to "the user said" or to this conversation; include concrete values, edge-case handling, and output expectations.

Additionally surface a SMALL set of knobs a user may want to tweak later (account, count, tone, …) as params. In the brief, write each knob as a {{placeholder}} and put its current value in params.

Goal:
${goal}

Clarifications:
${qa.map(x => `Q: ${x.question}\nA: ${x.answer}`).join('\n')}

Respond with ONLY this JSON:
{"brief":"...","params":{"name":"current value"}}`;

export async function generateAutomationQuestions(
  goal: string, targetContext: string, opts: AideOptions,
): Promise<InterviewQuestion[]> {
  const res = await runAideJson<{ questions?: unknown }>(QUESTIONS_PROMPT(goal, targetContext), opts);
  if (!res || !Array.isArray(res.questions)) return [];
  return (res.questions as Array<Record<string, unknown>>)
    .filter(q => typeof q?.question === 'string' && (q.question as string).trim())
    .map((q, i) => ({
      id: typeof q.id === 'string' ? q.id : `q${i + 1}`,
      question: (q.question as string).trim(),
      why: typeof q.why === 'string' ? q.why : undefined,
    }));
}

export async function generateAutomationFollowup(
  goal: string, question: string, answer: string, opts: AideOptions,
): Promise<string | null> {
  const res = await runAideJson<{ followup?: unknown }>(FOLLOWUP_PROMPT(goal, question, answer), opts);
  return res && typeof res.followup === 'string' && res.followup.trim() ? res.followup.trim() : null;
}

export async function synthesizeAutomationBrief(
  goal: string, qa: InterviewAnswer[], opts: AideOptions,
): Promise<{ brief: string; params: Record<string, string> }> {
  const res = await runAideJson<{ brief?: unknown; params?: unknown }>(SYNTHESIS_PROMPT(goal, qa), opts);
  const brief = res && typeof res.brief === 'string' ? res.brief.trim() : '';
  if (!brief) throw new Error('Aide returned no brief');
  const params: Record<string, string> = {};
  if (res!.params && typeof res!.params === 'object') {
    for (const [k, v] of Object.entries(res!.params as Record<string, unknown>)) {
      if (typeof v === 'string') params[k] = v;
    }
  }
  return { brief, params };
}

/**
 * Resolve {{placeholders}} from params; params without a placeholder are
 * appended as a trailing "Parameters:" block so edits always take effect.
 */
export function renderBrief(brief: string, params: Record<string, string>): string {
  const used = new Set<string>();
  const out = brief.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    if (key in params) { used.add(key); return params[key]; }
    return match;
  });
  const leftovers = Object.entries(params).filter(([k]) => !used.has(k));
  if (leftovers.length === 0) return out;
  return `${out}\n\nParameters:\n${leftovers.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/core/src/index.ts`, beside the existing lines (`export * from './aide';` if present, otherwise near `export * from './types';`):

```ts
export * from './aide-automation';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @codey/core -- aide-automation`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/aide-automation.ts packages/core/src/aide-automation.test.ts packages/core/src/index.ts
git commit -m "feat(core): automation interview prompts + brief rendering via Aide"
```

---

### Task 6: Pure helpers — parked detection + run summary

**Files:**
- Create: `packages/gateway/src/automations/parked.ts`
- Create: `packages/gateway/src/automations/report.ts`
- Test: `packages/gateway/src/automations/parked.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/src/automations/parked.test.ts
import { describe, it, expect } from 'vitest';
import { detectParked } from './parked';
import { formatRunSummary } from './report';
import type { Chat, Automation, AutomationRun } from '@codey/core';

const teamTarget: Automation['target'] = { kind: 'team', teamName: 't', workspaceName: 'w' };
const promptTarget: Automation['target'] = { kind: 'prompt', workspaceName: 'w' };

describe('detectParked', () => {
  it('reports a paused team via chat.pendingTeam', () => {
    const chat = { pendingTeam: { question: 'Deploy now?', options: ['yes', 'no'] } } as unknown as Chat;
    expect(detectParked(chat, teamTarget, 'irrelevant'))
      .toEqual({ question: 'Deploy now?', options: ['yes', 'no'] });
  });
  it('reports an [ASK_USER] marker in a prompt-target response', () => {
    const parked = detectParked(undefined, promptTarget, 'work...\n[ASK_USER]: Which repo?');
    expect(parked?.question).toBe('Which repo?');
  });
  it('ignores [ASK_USER] markers for team targets (pendingTeam is authoritative)', () => {
    expect(detectParked({ } as Chat, teamTarget, '[ASK_USER]: q?')).toBeNull();
  });
  it('returns null when nothing is pending', () => {
    expect(detectParked({} as Chat, promptTarget, 'all done')).toBeNull();
  });
});

describe('formatRunSummary', () => {
  const auto = { name: 'Morning news' } as Automation;
  it('summarizes success with a body preview', () => {
    const s = formatRunSummary(auto, { status: 'success', output: 'Posted 5 items.' } as AutomationRun);
    expect(s).toContain('Morning news');
    expect(s).toContain('✅');
    expect(s).toContain('Posted 5 items.');
  });
  it('summarizes parked runs with the question', () => {
    const s = formatRunSummary(auto, { status: 'parked', question: 'Which account?' } as AutomationRun);
    expect(s).toContain('⏸');
    expect(s).toContain('Which account?');
  });
  it('summarizes failure with the error', () => {
    const s = formatRunSummary(auto, { status: 'failed', error: 'boom' } as AutomationRun);
    expect(s).toContain('❌');
    expect(s).toContain('boom');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/parked`
Expected: FAIL — cannot resolve `./parked`.

- [ ] **Step 3: Implement both modules**

```ts
// packages/gateway/src/automations/parked.ts
import { parseAskUser } from '@codey/core';
import type { Chat, Automation } from '@codey/core';

export interface ParkedInfo { question: string; options?: string[] }

/**
 * Decide whether a finished headless turn actually parked. Team targets park
 * via the persisted chat.pendingTeam (the existing pause machinery); prompt
 * targets park when the single agent emitted an [ASK_USER] marker.
 */
export function detectParked(
  chat: Chat | undefined,
  target: Automation['target'],
  response: string,
): ParkedInfo | null {
  const pending = chat?.pendingTeam;
  if (pending) return { question: pending.question, options: pending.options };
  if (target.kind === 'prompt') {
    const ask = parseAskUser(response);
    if (ask) return { question: ask.question, options: ask.options };
  }
  return null;
}
```

```ts
// packages/gateway/src/automations/report.ts
import type { Automation, AutomationRun } from '@codey/core';

const PREVIEW = 400;

/** Human-readable one-message summary for channel posts / notifications. */
export function formatRunSummary(a: Automation, run: AutomationRun): string {
  const head =
    run.status === 'success' ? `✅ Automation "${a.name}" succeeded` :
    run.status === 'parked' ? `⏸ Automation "${a.name}" is parked on a question` :
    run.status === 'resumed' ? `✅ Automation "${a.name}" resumed and finished` :
    `❌ Automation "${a.name}" failed`;
  const body =
    run.status === 'parked' ? (run.question ?? '') :
    run.status === 'failed' ? (run.error ?? '') :
    (run.output ?? '');
  const trimmed = body.trim();
  const preview = trimmed.length > PREVIEW ? `${trimmed.slice(0, PREVIEW - 1)}…` : trimmed;
  return preview ? `${head}\n\n${preview}` : head;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/parked`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/parked.ts packages/gateway/src/automations/report.ts packages/gateway/src/automations/parked.test.ts
git commit -m "feat(gateway): parked-run detection + run summary formatting"
```

---

### Task 7: AutomationEngine

**Files:**
- Create: `packages/gateway/src/automations/engine.ts`
- Test: `packages/gateway/src/automations/engine.test.ts`

The engine owns the tick loop and lifecycle but is decoupled from `Codey` via injected `runTarget`/`resumeTarget`/`report` deps, so it is fully unit-testable.

- [ ] **Step 1: Write the failing tests**

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/engine`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Implement**

```ts
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
  /** Execute the automation's rendered brief headlessly (gateway adapter). */
  runTarget: (a: Automation) => Promise<TargetResult>;
  /** Feed an answer into the parked continuation (gateway adapter). */
  resumeTarget: (a: Automation, answer: string) => Promise<TargetResult>;
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
    this.expireParked(now);
    this._isLeader = this.deps.lease.heartbeat(now) || this.deps.lease.tryAcquire(now);
    if (!this._isLeader) return;
    for (const a of this.deps.store.list()) {
      if (!a.enabled || !a.schedule) continue;
      if (!shouldFire(a.schedule, a.lastFiredAt, now)) continue;
      // Record the slot BEFORE running so a crash mid-run can't re-fire it.
      this.deps.store.recordLastFired(a.id, now);
      void this.runNow(a.id, 'schedule').catch(err => this.log(`scheduled run failed: ${err?.message}`));
    }
  }

  /** Manual + scheduled entry. Works without the lease (spec: non-leaders serve runNow). */
  async runNow(id: string, trigger: 'manual' | 'schedule'): Promise<AutomationRun | null> {
    const a = this.deps.store.get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    if (this.active.has(id)) { this.log(`skip ${a.name}: previous run still active`); return null; }
    const latest = this.deps.store.listRuns(id, 1)[0];
    if (latest?.status === 'parked') { this.log(`skip ${a.name}: parked run awaiting an answer`); return null; }
    return this.execute(a, trigger, res => this.deps.runTarget(res));
  }

  /** Answer a parked run's question; appends a linked 'resumed' record. */
  async resume(id: string, runId: string, answer: string): Promise<AutomationRun> {
    const a = this.deps.store.get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    const parked = this.deps.store.listRuns(id).find(r => r.runId === runId);
    if (!parked || parked.status !== 'parked') throw new Error(`Run ${runId} is not parked`);
    if (this.active.has(id)) throw new Error(`Automation ${a.name} already has an active run`);
    const run = await this.execute(a, parked.trigger, auto => this.deps.resumeTarget(auto, answer), runId);
    return run!;
  }

  private async execute(
    a: Automation,
    trigger: 'manual' | 'schedule',
    exec: (a: Automation) => Promise<TargetResult>,
    resumedFrom?: string,
  ): Promise<AutomationRun | null> {
    this.active.add(a.id);
    const run: AutomationRun = {
      runId: randomUUID(), startedAt: this.now(), status: 'failed', trigger, resumedFrom,
    };
    this.emit({ type: 'run-started', automationId: a.id, runId: run.runId });
    try {
      const res = await exec(a);
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
        this.deps.store.patchRun(a.id, latest.runId, {
          status: 'failed',
          error: 'parked question expired after 7 days without an answer',
        });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/engine`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/engine.ts packages/gateway/src/automations/engine.test.ts
git commit -m "feat(gateway): AutomationEngine — lease-gated tick, runNow, parked resume, expiry"
```

---

### Task 8: Interview session manager

**Files:**
- Create: `packages/gateway/src/automations/interview.ts`
- Test: `packages/gateway/src/automations/interview.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/src/automations/interview.test.ts
import { describe, it, expect, vi } from 'vitest';
import { InterviewManager, type InterviewDeps } from './interview';

const deps = (over: Partial<InterviewDeps> = {}): InterviewDeps => ({
  generateQuestions: vi.fn(async () => [
    { id: 'q1', question: 'Which account?' },
    { id: 'q2', question: 'How many items?' },
  ]),
  generateFollowup: vi.fn(async () => null),
  synthesize: vi.fn(async () => ({ brief: 'Post to {{account}}.', params: { account: '@jack' } })),
  ...over,
});

describe('InterviewManager', () => {
  it('walks questions one at a time and synthesizes at the end', async () => {
    const m = new InterviewManager(deps());
    const s = await m.start('post news', 'target: prompt');
    expect(s.question?.question).toBe('Which account?');
    const step2 = await m.answer(s.sessionId, '@jack');
    expect(step2.done).toBe(false);
    expect(step2.question?.question).toBe('How many items?');
    const end = await m.answer(s.sessionId, '5');
    expect(end.done).toBe(true);
    expect(end.brief).toBe('Post to {{account}}.');
    expect(end.params).toEqual({ account: '@jack' });
  });

  it('asks at most ONE follow-up per question', async () => {
    const followup = vi.fn(async () => 'Follow up?');
    const m = new InterviewManager(deps({
      generateQuestions: vi.fn(async () => [{ id: 'q1', question: 'Q?' }]),
      generateFollowup: followup,
    }));
    const s = await m.start('g', 't');
    const f = await m.answer(s.sessionId, 'vague');
    expect(f.question?.question).toBe('Follow up?');
    const end = await m.answer(s.sessionId, 'still vague'); // no second follow-up
    expect(end.done).toBe(true);
    expect(followup).toHaveBeenCalledTimes(1);
  });

  it('synthesizes immediately when no questions come back', async () => {
    const m = new InterviewManager(deps({ generateQuestions: vi.fn(async () => []) }));
    const s = await m.start('g', 't');
    expect(s.done).toBe(true);
    expect(s.brief).toBe('Post to {{account}}.');
  });

  it('throws on unknown session', async () => {
    await expect(new InterviewManager(deps()).answer('nope', 'x')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/interview`
Expected: FAIL — cannot resolve `./interview`.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/automations/interview.ts
import { randomUUID } from 'crypto';
import type { InterviewQuestion, InterviewAnswer } from '@codey/core';

export interface InterviewDeps {
  generateQuestions: (goal: string, targetContext: string) => Promise<InterviewQuestion[]>;
  generateFollowup: (goal: string, question: string, answer: string) => Promise<string | null>;
  synthesize: (goal: string, qa: InterviewAnswer[]) => Promise<{ brief: string; params: Record<string, string> }>;
}

export interface InterviewStep {
  sessionId: string;
  done: boolean;
  question?: InterviewQuestion;
  brief?: string;
  params?: Record<string, string>;
}

interface Session {
  goal: string;
  questions: InterviewQuestion[];
  index: number;
  /** True while the current question is a follow-up (never chain a second). */
  inFollowup: boolean;
  current?: InterviewQuestion;
  qa: InterviewAnswer[];
}

/** Drives one authoring interview: base questions in order, at most one
 *  bounded follow-up each, then brief synthesis. State is in-memory only —
 *  an interview is an interactive Mac-app session, not a persisted run. */
export class InterviewManager {
  private sessions = new Map<string, Session>();

  constructor(private deps: InterviewDeps) {}

  async start(goal: string, targetContext: string): Promise<InterviewStep> {
    const questions = await this.deps.generateQuestions(goal, targetContext);
    const sessionId = randomUUID();
    const s: Session = { goal, questions, index: 0, inFollowup: false, qa: [] };
    this.sessions.set(sessionId, s);
    if (questions.length === 0) return this.finish(sessionId, s);
    s.current = questions[0];
    return { sessionId, done: false, question: s.current };
  }

  async answer(sessionId: string, text: string): Promise<InterviewStep> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.current) throw new Error(`Unknown interview session: ${sessionId}`);
    s.qa.push({ question: s.current.question, answer: text });

    if (!s.inFollowup) {
      const followup = await this.deps.generateFollowup(s.goal, s.current.question, text);
      if (followup) {
        s.inFollowup = true;
        s.current = { id: `${s.questions[s.index].id}-f`, question: followup };
        return { sessionId, done: false, question: s.current };
      }
    }

    s.inFollowup = false;
    s.index += 1;
    if (s.index < s.questions.length) {
      s.current = s.questions[s.index];
      return { sessionId, done: false, question: s.current };
    }
    return this.finish(sessionId, s);
  }

  private async finish(sessionId: string, s: Session): Promise<InterviewStep> {
    const { brief, params } = await this.deps.synthesize(s.goal, s.qa);
    this.sessions.delete(sessionId);
    return { sessionId, done: true, brief, params };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/interview`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/interview.ts packages/gateway/src/automations/interview.test.ts
git commit -m "feat(gateway): interview session manager with bounded follow-ups"
```

---

### Task 9: Hidden automation chats + `Codey` wiring

**Files:**
- Modify: `packages/gateway/src/chats.ts` (`CreateChatInput` line 9, `create()` line 139, `list()` line 125)
- Modify: `packages/gateway/src/gateway.ts` (`Codey` class — new fields, `start()`/`stop()`, public automation API)
- Test: `packages/gateway/src/automations/chats-hidden.test.ts`

- [ ] **Step 1: Write the failing test for hidden chats**

```ts
// packages/gateway/src/automations/chats-hidden.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from '../chats';

const makeManager = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-hidden-'));
  fs.mkdirSync(path.join(root, 'default'), { recursive: true });
  return new ChatManager(root);
};

describe('automation chats are hidden', () => {
  it('list() excludes kind=automation by default, includes with the flag', () => {
    const m = makeManager();
    m.create({ workspaceName: 'default', title: 'normal' });
    const hidden = m.create({ workspaceName: 'default', title: 'Automation: x', kind: 'automation' });
    expect(m.list('default').map(c => c.title)).toEqual(['normal']);
    expect(m.list('default', { includeAutomation: true })).toHaveLength(2);
    expect(m.get(hidden.id)?.kind).toBe('automation');
  });

  it('create honors agent/model overrides', () => {
    const m = makeManager();
    const c = m.create({ workspaceName: 'default', kind: 'automation', agent: 'claude-code', model: 'opus' });
    expect(c.agent).toBe('claude-code');
    expect(c.model).toBe('opus');
  });
});
```

Note: `ChatManager`'s constructor takes the workspaces root — confirm the exact constructor signature at `packages/gateway/src/chats.ts:26-40` and adjust the test's `makeManager` if it differs (e.g. needs a Logger arg).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @codey/gateway -- chats-hidden`
Expected: FAIL — `kind`/`includeAutomation` don't exist.

- [ ] **Step 3: Extend `CreateChatInput`, `create()`, and `list()`**

In `packages/gateway/src/chats.ts:9`:

```ts
export interface CreateChatInput {
  workspaceName: string;
  selection?: ChatSelection;
  title?: string;
  /** 'automation' = hidden system chat (excluded from list() by default). */
  kind?: 'automation';
  /** Per-chat agent/model overrides, set at creation (used by automations). */
  agent?: Chat['agent'];
  model?: string;
}
```

In `create()` (line 139), thread the new fields into the `Chat` literal after `selection`:

```ts
      selection: input.selection ?? { type: 'none' },
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
```

In `list()` (line 125), add the option and filter:

```ts
  list(workspaceName?: string, opts?: { includeAutomation?: boolean }): Chat[] {
    this.ensureLoaded();
    const all = [...this.cache.values()]
      .filter(c => opts?.includeAutomation || c.kind !== 'automation');
    const filtered = workspaceName
      ? all.filter(c => c.workspaceName === workspaceName)
      : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @codey/gateway -- chats-hidden`
Expected: PASS (2 tests). Also run `npm test -w @codey/gateway -- chats` to confirm no existing `chats.test.ts` regressions.

- [ ] **Step 5: Wire automations into `Codey` (`packages/gateway/src/gateway.ts`)**

Add imports at the top (extend the existing `@codey/core` import with `Automation`, `AutomationRun`, `AutomationEvent`, `renderBrief`, `generateAutomationQuestions`, `generateAutomationFollowup`, `synthesizeAutomationBrief`, and add):

```ts
import { AutomationStore } from './automations/store';
import { AutomationEngine, TargetResult } from './automations/engine';
import { SchedulerLease } from './automations/lease';
import { InterviewManager } from './automations/interview';
import { detectParked } from './automations/parked';
import { formatRunSummary } from './automations/report';
```

Add fields on the `Codey` class (near `private conversationCleanupInterval`):

```ts
  private automationStore?: AutomationStore;
  private automationEngine?: AutomationEngine;
  private automationInterviews?: InterviewManager;
  private automationEventListener?: (ev: AutomationEvent) => void;
```

Add an initializer method on `Codey` and call it from `start()` (find `async start()` and add `this.initAutomations();` after channels are up; in `stop()` add `this.automationEngine?.stop();`):

```ts
  /** Base dir mirrors workspace.ts: CODEY_HOME override, else ~/.codey. */
  private codeyHome(): string {
    return process.env.CODEY_HOME ?? path.join(os.homedir(), '.codey');
  }

  private initAutomations(): void {
    const base = this.codeyHome();
    this.automationStore = new AutomationStore(base);
    const role = this.config.automationRole ?? 'daemon';
    this.automationEngine = new AutomationEngine({
      store: this.automationStore,
      lease: new SchedulerLease(path.join(base, 'automation-scheduler.lock'), role),
      runTarget: (a) => this.runAutomationTurn(a, renderBrief(a.brief, a.params)),
      resumeTarget: (a, answer) => this.runAutomationTurn(a, answer),
      report: (a, run) => this.deliverAutomationReport(a, run),
      onEvent: (ev) => { try { this.automationEventListener?.(ev); } catch { /* swallow */ } },
      log: (msg) => this.logger.info(`[automations] ${msg}`),
    });
    this.automationEngine.start();
    this.automationInterviews = new InterviewManager({
      generateQuestions: (goal, ctx) => generateAutomationQuestions(goal, ctx, this.getAideOptions()),
      generateFollowup: (goal, q, ans) => generateAutomationFollowup(goal, q, ans, this.getAideOptions()),
      synthesize: (goal, qa) => synthesizeAutomationBrief(goal, qa, this.getAideOptions()),
    });
  }
```

Note: `os` may not yet be imported in gateway.ts — check the import block and add `import * as os from 'os';` if missing (`path` and `fs` are already imported).

Add the headless execution adapter + report delivery (private methods on `Codey`):

```ts
  /** The hidden system chat an automation executes in (created lazily). */
  private async ensureAutomationChat(a: Automation): Promise<string> {
    if (a.chatId && this.chatManager.get(a.chatId)) return a.chatId;
    const selection = a.target.kind === 'team'
      ? { type: 'team' as const, name: a.target.teamName }
      : { type: 'none' as const };
    const chat = this.chatManager.create({
      workspaceName: a.target.workspaceName,
      title: `Automation: ${a.name}`,
      selection,
      kind: 'automation',
      agent: a.target.kind === 'prompt' ? a.target.agent : undefined,
      model: a.target.kind === 'prompt' ? a.target.model : undefined,
    });
    this.automationStore!.update(a.id, { chatId: chat.id }, Date.now());
    return chat.id;
  }

  /**
   * One headless turn: send `text` into the automation's hidden chat with a
   * collecting sink, then decide parked/success from the persisted chat state.
   * Resume is the same call — sendToChat's pendingTeam continuation handles it.
   */
  private async runAutomationTurn(a: Automation, text: string): Promise<TargetResult> {
    const chatId = await this.ensureAutomationChat(a);
    const sink: ChatStreamSink = () => { /* headless — response comes from the return value */ };
    try {
      const { response } = await this.sendToChat(chatId, text, sink);
      const parked = detectParked(this.chatManager.get(chatId), a.target, response);
      return parked ? { output: response, parked } : { output: response };
    } catch (err) {
      return { output: '', error: (err as Error).message };
    }
  }

  /** Post the run summary to report.channel if configured. Returns failure text. */
  private async deliverAutomationReport(a: Automation, run: AutomationRun): Promise<string | undefined> {
    if (!a.report.channel) return undefined;
    const channel = a.report.channel.platform as ChannelType;
    const handler = this.handlers.get(channel);
    if (!handler) return `channel ${a.report.channel.platform} not connected in this process`;
    try {
      await this.sendResponse({ chatId: a.report.channel.target, channel, text: formatRunSummary(a, run) });
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }
```

Add the public API surface (used by Mac IPC and, later, the `/automation` command):

```ts
  // ---- Automations public API ----

  listAutomations(): Automation[] { return this.automationStore?.list() ?? []; }
  getAutomation(id: string): Automation | undefined { return this.automationStore?.get(id); }
  createAutomation(draft: Parameters<AutomationStore['create']>[0]): Automation {
    return this.requireAutomationStore().create(draft, Date.now());
  }
  updateAutomation(id: string, patch: Partial<Automation>): Automation {
    return this.requireAutomationStore().update(id, patch, Date.now());
  }
  deleteAutomation(id: string): void { this.requireAutomationStore().delete(id); }
  setAutomationEnabled(id: string, enabled: boolean): Automation {
    return this.requireAutomationStore().setEnabled(id, enabled, Date.now());
  }
  listAutomationRuns(id: string, limit?: number): AutomationRun[] {
    return this.automationStore?.listRuns(id, limit) ?? [];
  }
  markAutomationRunSeen(id: string, runId: string): void {
    this.automationStore?.markSeen(id, runId, Date.now());
  }
  runAutomationNow(id: string): Promise<AutomationRun | null> {
    return this.requireAutomationEngine().runNow(id, 'manual');
  }
  resumeAutomationRun(id: string, runId: string, answer: string): Promise<AutomationRun> {
    return this.requireAutomationEngine().resume(id, runId, answer);
  }
  startAutomationInterview(goal: string, targetContext: string) {
    return this.requireAutomationInterviews().start(goal, targetContext);
  }
  answerAutomationInterview(sessionId: string, text: string) {
    return this.requireAutomationInterviews().answer(sessionId, text);
  }
  setAutomationEventListener(fn: (ev: AutomationEvent) => void): void {
    this.automationEventListener = fn;
  }

  private requireAutomationStore(): AutomationStore {
    if (!this.automationStore) throw new Error('Automations not initialized (gateway not started)');
    return this.automationStore;
  }
  private requireAutomationEngine(): AutomationEngine {
    if (!this.automationEngine) throw new Error('Automations not initialized (gateway not started)');
    return this.automationEngine;
  }
  private requireAutomationInterviews(): InterviewManager {
    if (!this.automationInterviews) throw new Error('Automations not initialized (gateway not started)');
    return this.automationInterviews;
  }
```

Wiring caveats to verify while editing (the executor MUST check these against the live file, not assume):
- `this.handlers` is the channel handler map used around `gateway.ts:2375` (`this.handlers.get(channel)`); confirm its field name.
- `sendResponse` is the method used at `gateway.ts:2356`; confirm its exact parameter shape (`{ chatId, channel, text }`).
- `ChatStreamSink` is already imported in gateway.ts from `./chat-runner` (used by `sendToChat`); if not, add it.
- If `start()` does not exist as a single method (it does — `await gateway.start()` in `index.ts`), place `initAutomations()` at its end.
- Wherever `chatManager.list(` is called for UI listing (grep; e.g. the chats HTTP/IPC surface), the default now hides automation chats — no caller change needed.

- [ ] **Step 6: Build + run the full gateway suite**

Run: `npm run build -w @codey/core -w @codey/gateway && npm test -w @codey/gateway`
Expected: build exit 0; all gateway tests PASS (new + pre-existing).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/chats.ts packages/gateway/src/gateway.ts packages/gateway/src/automations/chats-hidden.test.ts
git commit -m "feat(gateway): wire automations into Codey via hidden system chats"
```

---

### Task 10: Mac app — notification logic, IPC, preload

**Files:**
- Create: `codey-mac/electron/automation-notifications.ts`
- Test: `codey-mac/electron/automation-notifications.test.ts`
- Modify: `codey-mac/electron/main.ts` (IPC handlers + event forwarding + launch scan; follow the `workers:*` pattern at line ~1385)
- Modify: `codey-mac/electron/preload.ts` (extend the `contextBridge.exposeInMainWorld('codey', {...})` object)
- Modify: `codey-mac/src/codey-api.d.ts` (types for the new bridge)

- [ ] **Step 1: Write the failing notification-logic tests**

```ts
// codey-mac/electron/automation-notifications.test.ts
import { describe, it, expect } from 'vitest'
import { decideAutomationNotification, findUnseenRuns } from './automation-notifications'

const auto = (over: any = {}) => ({
  id: 'a1', name: 'Morning news', report: { notify: true }, ...over,
})
const run = (over: any = {}) => ({
  runId: 'r1', startedAt: 1000, endedAt: 2000, status: 'success',
  trigger: 'schedule', output: 'Posted 5 items.', ...over,
})

describe('decideAutomationNotification', () => {
  it('notifies on finished runs when report.notify is on', () => {
    const d = decideAutomationNotification(auto(), run())
    expect(d).toMatchObject({ title: expect.stringContaining('Morning news') })
    expect(d!.body).toContain('Posted 5 items.')
  })
  it('returns null when notify is off', () => {
    expect(decideAutomationNotification(auto({ report: { notify: false } }), run())).toBeNull()
  })
  it('surfaces the parked question', () => {
    const d = decideAutomationNotification(auto(), run({ status: 'parked', question: 'Which account?' }))
    expect(d!.body).toContain('Which account?')
  })
})

describe('findUnseenRuns', () => {
  it('returns unseen, ended, recent runs only', () => {
    const now = 100 * 3600_000
    const runs = [
      run({ runId: 'seen', seenAt: 5 }),
      run({ runId: 'old', endedAt: now - 25 * 3600_000 }),
      run({ runId: 'active', endedAt: undefined }),
      run({ runId: 'fresh', endedAt: now - 3600_000 }),
    ]
    expect(findUnseenRuns(runs, now).map(r => r.runId)).toEqual(['fresh'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w codey-mac -- automation-notifications`
Expected: FAIL — module missing. (The mac workspace name may differ — check `codey-mac/package.json` `name`; fall back to `cd codey-mac && npx vitest run automation-notifications`.)

- [ ] **Step 3: Implement (pure, no Electron imports — mirrors `chat-notifications.ts`)**

```ts
// codey-mac/electron/automation-notifications.ts
// Pure decision logic for automation notifications and the launch-time
// unseen-run scan. No Electron imports so it is unit-testable; main.ts
// renders decisions with the Notification API.
import { mdToPlainText, truncate } from './chat-notifications'

export interface AutomationLike {
  id: string
  name: string
  report: { notify: boolean }
}
export interface RunLike {
  runId: string
  startedAt: number
  endedAt?: number
  status: string
  output?: string
  error?: string
  question?: string
  seenAt?: number
}
export interface AutomationNotification { automationId: string; runId: string; title: string; body: string }

const MAX_BODY = 180
export const UNSEEN_WINDOW_MS = 24 * 3600_000

export function decideAutomationNotification(a: AutomationLike, run: RunLike): AutomationNotification | null {
  if (!a.report.notify) return null
  const title =
    run.status === 'parked' ? `⏸ ${a.name} needs an answer` :
    run.status === 'failed' ? `❌ ${a.name} failed` :
    `✅ ${a.name} finished`
  const raw = run.status === 'parked' ? (run.question ?? '')
    : run.status === 'failed' ? (run.error ?? '')
    : (run.output ?? '')
  return { automationId: a.id, runId: run.runId, title, body: truncate(mdToPlainText(raw), MAX_BODY) }
}

/** Runs that ended recently, unseen — surfaced (badge + notify) on app launch. */
export function findUnseenRuns(runs: RunLike[], now: number): RunLike[] {
  return runs.filter(r => !r.seenAt && r.endedAt !== undefined && now - r.endedAt <= UNSEEN_WINDOW_MS)
}
```

Note: `truncate` and `mdToPlainText` are exported from `chat-notifications.ts` (verified at lines 34/43). If `truncate` is not exported, export it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w codey-mac -- automation-notifications`
Expected: PASS (5 tests).

- [ ] **Step 5: Add IPC handlers in `main.ts`**

Next to the `workers:*` handlers (line ~1385), add — `inProcessGateway` is the `Codey` instance created at line ~753:

```ts
  // ---- Automations ----
  ipcMain.handle('automations:list', async () => inProcessGateway.listAutomations())
  ipcMain.handle('automations:get', async (_e, id: string) => inProcessGateway.getAutomation(id))
  ipcMain.handle('automations:create', async (_e, draft: any) => inProcessGateway.createAutomation(draft))
  ipcMain.handle('automations:update', async (_e, id: string, patch: any) => inProcessGateway.updateAutomation(id, patch))
  ipcMain.handle('automations:delete', async (_e, id: string) => inProcessGateway.deleteAutomation(id))
  ipcMain.handle('automations:setEnabled', async (_e, id: string, enabled: boolean) => inProcessGateway.setAutomationEnabled(id, enabled))
  ipcMain.handle('automations:runNow', async (_e, id: string) => inProcessGateway.runAutomationNow(id))
  ipcMain.handle('automations:resume', async (_e, id: string, runId: string, answer: string) => inProcessGateway.resumeAutomationRun(id, runId, answer))
  ipcMain.handle('automations:history', async (_e, id: string, limit?: number) => inProcessGateway.listAutomationRuns(id, limit))
  ipcMain.handle('automations:markSeen', async (_e, id: string, runId: string) => inProcessGateway.markAutomationRunSeen(id, runId))
  ipcMain.handle('automations:interview:start', async (_e, goal: string, targetContext: string) =>
    inProcessGateway.startAutomationInterview(goal, targetContext))
  ipcMain.handle('automations:interview:answer', async (_e, sessionId: string, text: string) =>
    inProcessGateway.answerAutomationInterview(sessionId, text))
```

- [ ] **Step 6: Forward engine events + OS notifications + launch scan in `main.ts`**

Where the gateway is created (after line ~753, near where other gateway listeners are attached):

```ts
  inProcessGateway.setAutomationEventListener((ev: any) => {
    sendToRenderer('automation-event', ev)
    if ((ev.type === 'run-finished' || ev.type === 'run-parked') && ev.run) {
      const a = inProcessGateway.getAutomation(ev.automationId)
      if (a) {
        const d = decideAutomationNotification(a, ev.run)
        if (d) new Notification({ title: d.title, body: d.body }).show()
      }
    }
  })

  // Launch scan: surface results fired by the daemon while the app was closed.
  for (const a of inProcessGateway.listAutomations()) {
    const unseen = findUnseenRuns(inProcessGateway.listAutomationRuns(a.id, 20), Date.now())
    if (unseen.length > 0) {
      sendToRenderer('automation-unseen', { automationId: a.id, runIds: unseen.map(r => r.runId) })
      const d = decideAutomationNotification(a, unseen[0])
      if (d) new Notification({ title: d.title, body: `${d.body}${unseen.length > 1 ? ` (+${unseen.length - 1} more)` : ''}` }).show()
    }
  }
```

Add the import at the top of `main.ts`:

```ts
import { decideAutomationNotification, findUnseenRuns } from './automation-notifications'
```

Verify while editing: `sendToRenderer` exists (used at `main.ts:255`); `Notification` is imported from `electron` (grep — `chat-notifications` decisions are rendered somewhere with `new Notification`; reuse that import). Also set the embedded role: where `runtimeCfg` is built for `new Codey(runtimeCfg, ...)` (line ~753), add `automationRole: 'embedded'` to the config object.

- [ ] **Step 7: Extend `preload.ts` and `codey-api.d.ts`**

Inside the `contextBridge.exposeInMainWorld('codey', {` object:

```ts
  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    get: (id: string) => ipcRenderer.invoke('automations:get', id),
    create: (draft: any) => ipcRenderer.invoke('automations:create', draft),
    update: (id: string, patch: any) => ipcRenderer.invoke('automations:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('automations:delete', id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('automations:setEnabled', id, enabled),
    runNow: (id: string) => ipcRenderer.invoke('automations:runNow', id),
    resume: (id: string, runId: string, answer: string) => ipcRenderer.invoke('automations:resume', id, runId, answer),
    history: (id: string, limit?: number) => ipcRenderer.invoke('automations:history', id, limit),
    markSeen: (id: string, runId: string) => ipcRenderer.invoke('automations:markSeen', id, runId),
    interviewStart: (goal: string, targetContext: string) => ipcRenderer.invoke('automations:interview:start', goal, targetContext),
    interviewAnswer: (sessionId: string, text: string) => ipcRenderer.invoke('automations:interview:answer', sessionId, text),
    onEvent: (cb: (ev: any) => void) => {
      const listener = (_e: any, ev: any) => cb(ev)
      ipcRenderer.on('automation-event', listener)
      return () => ipcRenderer.removeListener('automation-event', listener)
    },
    onUnseen: (cb: (p: any) => void) => {
      const listener = (_e: any, p: any) => cb(p)
      ipcRenderer.on('automation-unseen', listener)
      return () => ipcRenderer.removeListener('automation-unseen', listener)
    },
  },
```

Mirror the shape in `codey-mac/src/codey-api.d.ts` following how the existing namespaces are typed there (import the `Automation`/`AutomationRun` types if the file already imports from `@codey/core`, otherwise use `any`-shaped structural types consistent with the file's current style).

- [ ] **Step 8: Build the mac workspace**

Run: `npm run build -w @codey/core -w @codey/gateway && cd codey-mac && npx tsc --noEmit -p . ; cd ..`
(Verify how mac typechecks — if there's no tsconfig-driven check, use its `npm run build`.)
Expected: no type errors.

- [ ] **Step 9: Commit**

```bash
git add codey-mac/electron/automation-notifications.ts codey-mac/electron/automation-notifications.test.ts codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): automations IPC, event forwarding, notifications, launch scan"
```

---

### Task 11: Renderer — Automations view

**Files:**
- Create: `codey-mac/src/components/automationsModel.ts`
- Test: `codey-mac/src/components/automationsModel.test.ts`
- Create: `codey-mac/src/components/AutomationsView.tsx`
- Modify: `codey-mac/src/App.tsx` (navigation entry)

- [ ] **Step 1: Write the failing model tests**

```ts
// codey-mac/src/components/automationsModel.test.ts
import { describe, it, expect } from 'vitest'
import { scheduleSummary, canSchedule, timeOfDayToSchedule } from './automationsModel'

describe('scheduleSummary', () => {
  it('renders daily and weekly summaries', () => {
    expect(scheduleSummary({ hour: 9, minute: 0, tz: 'Asia/Shanghai' })).toBe('daily 09:00')
    expect(scheduleSummary({ hour: 18, minute: 30, daysOfWeek: [1, 2, 3, 4, 5], tz: 'UTC' }))
      .toBe('Mon–Fri 18:30')
    expect(scheduleSummary({ hour: 8, minute: 5, daysOfWeek: [0, 6], tz: 'UTC' })).toBe('Sun, Sat 08:05')
    expect(scheduleSummary(undefined)).toBe('manual')
  })
})

describe('canSchedule', () => {
  it('requires a synthesized brief (spec: interview is the gate)', () => {
    expect(canSchedule({ brief: '' })).toBe(false)
    expect(canSchedule({ brief: '  ' })).toBe(false)
    expect(canSchedule({ brief: 'Post news.' })).toBe(true)
  })
})

describe('timeOfDayToSchedule', () => {
  it('maps an HH:MM picker value + tz into a structured schedule', () => {
    expect(timeOfDayToSchedule('09:30', 'Asia/Shanghai', [1, 3]))
      .toEqual({ hour: 9, minute: 30, tz: 'Asia/Shanghai', daysOfWeek: [1, 3] })
    expect(timeOfDayToSchedule('9:5', 'UTC')).toEqual({ hour: 9, minute: 5, tz: 'UTC' })
    expect(timeOfDayToSchedule('25:00', 'UTC')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w codey-mac -- automationsModel`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the model**

```ts
// codey-mac/src/components/automationsModel.ts
// Pure helpers for the Automations view — kept separate for unit tests.

export interface ScheduleLike { hour: number; minute: number; daysOfWeek?: number[]; tz: string }

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

export function scheduleSummary(s: ScheduleLike | undefined): string {
  if (!s) return 'manual'
  const time = `${pad(s.hour)}:${pad(s.minute)}`
  if (!s.daysOfWeek || s.daysOfWeek.length === 0 || s.daysOfWeek.length === 7) return `daily ${time}`
  const days = [...s.daysOfWeek].sort((a, b) => a - b)
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const label = contiguous
    ? `${DAY[days[0]]}–${DAY[days[days.length - 1]]}`
    : days.map(d => DAY[d]).join(', ')
  return `${label} ${time}`
}

/** The interview is the gate: no schedule without a synthesized brief. */
export function canSchedule(a: { brief: string }): boolean {
  return a.brief.trim().length > 0
}

export function timeOfDayToSchedule(hhmm: string, tz: string, daysOfWeek?: number[]): ScheduleLike | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{1,2})$/)
  if (!m) return null
  const hour = Number(m[1]); const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute, tz, ...(daysOfWeek && daysOfWeek.length ? { daysOfWeek } : {}) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w codey-mac -- automationsModel`
Expected: PASS (6 tests).

- [ ] **Step 5: Build the view**

Create `codey-mac/src/components/AutomationsView.tsx`. Before writing it, open one existing view (e.g. `QuickQuestionView.tsx` or `GlobalTeamsSection.tsx`) and match its styling idiom (the project uses `theme.ts`); the structure below is the required behavior, adapt classNames/styles to the codebase's convention:

```tsx
// codey-mac/src/components/AutomationsView.tsx
import React, { useEffect, useState, useCallback } from 'react'
import { scheduleSummary, canSchedule, timeOfDayToSchedule } from './automationsModel'

const api = (window as any).codey.automations

type Panel = { kind: 'list' } | { kind: 'edit'; id?: string } | { kind: 'history'; id: string }

export default function AutomationsView() {
  const [automations, setAutomations] = useState<any[]>([])
  const [panel, setPanel] = useState<Panel>({ kind: 'list' })
  const refresh = useCallback(() => { api.list().then(setAutomations) }, [])
  useEffect(() => {
    refresh()
    const off = api.onEvent(() => refresh())
    return off
  }, [refresh])

  return panel.kind === 'list'
    ? <AutomationList automations={automations} refresh={refresh}
        onEdit={id => setPanel({ kind: 'edit', id })}
        onNew={() => setPanel({ kind: 'edit' })}
        onHistory={id => setPanel({ kind: 'history', id })} />
    : panel.kind === 'edit'
      ? <AutomationEditor id={panel.id} onClose={() => { refresh(); setPanel({ kind: 'list' }) }} />
      : <RunHistory id={panel.id} onClose={() => { refresh(); setPanel({ kind: 'list' }) }} />
}

function AutomationList({ automations, refresh, onEdit, onNew, onHistory }: {
  automations: any[]; refresh: () => void
  onEdit: (id: string) => void; onNew: () => void; onHistory: (id: string) => void
}) {
  const [lastStatus, setLastStatus] = useState<Record<string, string>>({})
  useEffect(() => {
    (async () => {
      const entries = await Promise.all(automations.map(async a => {
        const [latest] = await api.history(a.id, 1)
        return [a.id, latest?.status ?? '—'] as const
      }))
      setLastStatus(Object.fromEntries(entries))
    })()
  }, [automations])

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2>Automations</h2>
        <button onClick={onNew}>New automation</button>
      </div>
      {automations.length === 0 && <p>No automations yet. Create one — Codey will interview you to remove every runtime ambiguity, then it can run unattended.</p>}
      {automations.map(a => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border, #333)' }}>
          <input type="checkbox" checked={a.enabled}
            onChange={e => api.setEnabled(a.id, e.target.checked).then(refresh)} />
          <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => onEdit(a.id)}>
            <div>{a.name}</div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              {a.target.kind === 'team' ? `team: ${a.target.teamName}` : 'prompt'} · {scheduleSummary(a.schedule)}
            </div>
          </div>
          <span title="last run">{lastStatus[a.id]}</span>
          <button onClick={() => onHistory(a.id)}>History</button>
          <button onClick={() => api.runNow(a.id).then(refresh)}>Run now</button>
        </div>
      ))}
    </div>
  )
}

function AutomationEditor({ id, onClose }: { id?: string; onClose: () => void }) {
  const [a, setA] = useState<any>({
    name: '', enabled: true, brief: '', params: {},
    target: { kind: 'prompt', workspaceName: 'default' }, report: { notify: true },
  })
  const [goal, setGoal] = useState('')
  const [interview, setInterview] = useState<{ sessionId: string; question: any; log: Array<{ q: string; a: string }> } | null>(null)
  const [answer, setAnswer] = useState('')
  const [teams, setTeams] = useState<string[]>([])
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [time, setTime] = useState('09:00')
  const [scheduled, setScheduled] = useState(false)

  useEffect(() => {
    if (id) api.get(id).then((x: any) => {
      setA(x)
      setScheduled(!!x.schedule)
      if (x.schedule) setTime(`${String(x.schedule.hour).padStart(2, '0')}:${String(x.schedule.minute).padStart(2, '0')}`)
    })
    ;(window as any).codey.workspaces?.list?.().then((ws: any[]) => setWorkspaces(ws.map((w: any) => w.name ?? w))).catch(() => {})
    ;(window as any).codey.teams?.list?.().then((ts: any[]) => setTeams(ts.map((t: any) => t.name ?? t))).catch(() => {})
  }, [id])

  const startInterview = async () => {
    const targetContext = a.target.kind === 'team' ? `team: ${a.target.teamName}` : 'plain prompt to a coding agent'
    const step = await api.interviewStart(goal, targetContext)
    if (step.done) setA({ ...a, brief: step.brief, params: step.params })
    else setInterview({ sessionId: step.sessionId, question: step.question, log: [] })
  }

  const submitAnswer = async () => {
    if (!interview) return
    const step = await api.interviewAnswer(interview.sessionId, answer)
    const log = [...interview.log, { q: interview.question.question, a: answer }]
    setAnswer('')
    if (step.done) { setA({ ...a, brief: step.brief, params: step.params }); setInterview(null) }
    else setInterview({ ...interview, question: step.question, log })
  }

  const save = async () => {
    const schedule = scheduled ? timeOfDayToSchedule(time, Intl.DateTimeFormat().resolvedOptions().timeZone) : undefined
    const payload = { ...a, schedule: schedule ?? undefined }
    if (id) await api.update(id, payload)
    else await api.create(payload)
    onClose()
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
      <button onClick={onClose} style={{ alignSelf: 'flex-start' }}>← Back</button>
      <input placeholder="Name" value={a.name} onChange={e => setA({ ...a, name: e.target.value })} />

      <div style={{ display: 'flex', gap: 8 }}>
        <select value={a.target.kind} onChange={e =>
          setA({ ...a, target: e.target.value === 'team'
            ? { kind: 'team', teamName: teams[0] ?? '', workspaceName: a.target.workspaceName }
            : { kind: 'prompt', workspaceName: a.target.workspaceName } })}>
          <option value="prompt">Prompt</option>
          <option value="team">Team</option>
        </select>
        {a.target.kind === 'team' && (
          <select value={a.target.teamName} onChange={e => setA({ ...a, target: { ...a.target, teamName: e.target.value } })}>
            {teams.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select value={a.target.workspaceName} onChange={e => setA({ ...a, target: { ...a.target, workspaceName: e.target.value } })}>
          {(workspaces.length ? workspaces : ['default']).map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>

      {/* Interview */}
      <textarea placeholder="Goal — what should this automation do?" value={goal} onChange={e => setGoal(e.target.value)} rows={3} />
      <button onClick={startInterview} disabled={!goal.trim()}>
        {a.brief ? 'Re-run interview (regenerates brief)' : 'Start clarification interview'}
      </button>
      {interview && (
        <div style={{ border: '1px solid var(--border, #333)', padding: 10 }}>
          {interview.log.map((x, i) => <p key={i} style={{ opacity: 0.6 }}>Q: {x.q}<br />A: {x.a}</p>)}
          <p><b>{interview.question.question}</b>{interview.question.why ? <span style={{ opacity: 0.6 }}> — {interview.question.why}</span> : null}</p>
          <input value={answer} onChange={e => setAnswer(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submitAnswer() }} placeholder="Your answer…" />
        </div>
      )}

      {/* Brief (read-only) + params (editable) */}
      {a.brief && (
        <>
          <label>Brief (frozen — re-run the interview to change)</label>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.85, border: '1px solid var(--border, #333)', padding: 8 }}>{a.brief}</pre>
          {Object.keys(a.params).length > 0 && <label>Params</label>}
          {Object.entries(a.params as Record<string, string>).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 8 }}>
              <span style={{ minWidth: 120 }}>{k}</span>
              <input value={v} onChange={e => setA({ ...a, params: { ...a.params, [k]: e.target.value } })} />
            </div>
          ))}
        </>
      )}

      {/* Schedule + report */}
      <label>
        <input type="checkbox" checked={scheduled} disabled={!canSchedule(a)}
          onChange={e => setScheduled(e.target.checked)} />
        {' '}Run on a schedule {canSchedule(a) ? '' : '(complete the interview first)'}
      </label>
      {scheduled && <input type="time" value={time} onChange={e => setTime(e.target.value)} />}
      <label>
        <input type="checkbox" checked={a.report.notify}
          onChange={e => setA({ ...a, report: { ...a.report, notify: e.target.checked } })} />
        {' '}Notify when a run finishes
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={!a.name.trim() || !a.brief}>Save</button>
        {id && <button onClick={() => api.runNow(id)}>Test run now</button>}
        {id && <button onClick={() => api.delete(id).then(onClose)}>Delete</button>}
      </div>
    </div>
  )
}

function RunHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const [runs, setRuns] = useState<any[]>([])
  const [answer, setAnswer] = useState('')
  const refresh = useCallback(() => { api.history(id, 50).then(setRuns) }, [id])
  useEffect(() => {
    refresh()
    runs.filter(r => !r.seenAt && r.endedAt).forEach(r => api.markSeen(id, r.runId))
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 16 }}>
      <button onClick={onClose}>← Back</button>
      <h3>Run history</h3>
      {runs.length === 0 && <p>No runs yet.</p>}
      {runs.map(r => (
        <details key={r.runId} style={{ padding: '6px 0', borderBottom: '1px solid var(--border, #333)' }}>
          <summary>
            {new Date(r.startedAt).toLocaleString()} · {r.trigger} · {r.status}
            {r.reportFailure ? ' · ⚠ report delivery failed' : ''}
          </summary>
          {r.status === 'parked' && (
            <div style={{ margin: '8px 0' }}>
              <p><b>{r.question}</b></p>
              {r.options?.map((o: string) => <button key={o} onClick={() => api.resume(id, r.runId, o).then(refresh)}>{o}</button>)}
              <input value={answer} onChange={e => setAnswer(e.target.value)} placeholder="Answer…"
                onKeyDown={e => { if (e.key === 'Enter' && answer.trim()) api.resume(id, r.runId, answer).then(() => { setAnswer(''); refresh() }) }} />
            </div>
          )}
          {r.output && <pre style={{ whiteSpace: 'pre-wrap' }}>{r.output}</pre>}
          {r.error && <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--danger, #f66)' }}>{r.error}</pre>}
          {r.reportFailure && <p style={{ opacity: 0.7 }}>Report delivery: {r.reportFailure}</p>}
        </details>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Wire into `App.tsx`**

Open `codey-mac/src/App.tsx`, find where top-level views are switched (the sidebar/nav that mounts chat, flows, settings). Add an `automations` entry to that navigation enum/state and render `<AutomationsView />` for it, exactly following the pattern of the adjacent entries (icon, label "Automations"). Subscribe to `window.codey.automations.onUnseen` in the nav component to show an unseen-count badge on the entry, clearing when the view is opened.

- [ ] **Step 7: Typecheck + run mac tests**

Run: `npm run build -w @codey/core -w @codey/gateway && npm test -w codey-mac`
Expected: PASS including `automationsModel` and existing mac tests; no TS errors.

- [ ] **Step 8: Manual smoke test**

Run the Mac app in dev (per `codey-mac/package.json` dev script). Verify: Automations nav entry appears; creating an automation walks the interview (requires an Aide-capable agent configured); "Run now" produces a run-history record; parked runs (team with an `[ASK_USER]`-prone worker) show the answer box.

- [ ] **Step 9: Commit**

```bash
git add codey-mac/src/components/automationsModel.ts codey-mac/src/components/automationsModel.test.ts codey-mac/src/components/AutomationsView.tsx codey-mac/src/App.tsx
git commit -m "feat(mac): Automations view — list, interview editor, run history with resume"
```

---

### Task 12: Spec sync, full verification, wrap-up

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-automations-design.md`

- [ ] **Step 1: Fold implementation deviations back into the spec**

Update the spec's data-model section to match what shipped:
- `target`: `workspaceName` replaces `workingDir` (workingDir resolves from the workspace, via `sendToChat`).
- `Automation.chatId` — the hidden system chat (`Chat.kind: 'automation'`) each automation executes in; note that this *is* the headless entry point (a collecting turn through `sendToChat`), superseding the `runHeadless` sketch.
- `AutomationRun.question/options/resumedFrom` fields.
- Note prompt-target parking: `[ASK_USER]` markers in a solo response park too; resume is the next turn in the hidden chat (conversation context carries).

- [ ] **Step 2: Full build + full test suite**

Run: `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH" && npm run build && npm test`
Expected: build exit 0; every workspace's suite PASS. Fix anything that fails before proceeding.

- [ ] **Step 3: Verify the lint gate**

Run: `npm run lint`
Expected: no non-English characters flagged in new sources.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-02-automations-design.md
git commit -m "docs(specs): sync automations spec with shipped data model"
```

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch to decide merge/PR. Suggested PR title: `feat: automations — scheduled + run-now briefs over prompts and teams (#spec 2026-07-02)`.

---

## Out of scope (unchanged from spec)

- Event/webhook/message triggers; `/automation` chat command; multi-user sharing.
- Launch-at-login default flip: `setLoginItemSettings` already exists (`codey-mac/electron/main.ts:253`) — no work needed here beyond documenting that scheduled app-only automations require it enabled.
