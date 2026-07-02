# Self-Crystallizing Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a workspace-scoped skill crystallizer that detects recurring sub-processes across runs, suggests reusable skills, auto-applies them on future tasks, self-evolves on use, and archives when stale.

**Architecture:** A new `SkillStore` class in `packages/core` mirrors the `MemoryStore` pattern and is **owned by `WorkspaceManager`** (constructed per workspace, re-created on workspace switch — exactly like `memoryStore` at `workspace.ts:91/158/320`). Persistence is `skills/index.json` (skill entries + rejected-suggestion list) plus `skills/traces.json` (rolling run-trace history, survives restarts). An LLM-based distiller (reuses Advisor's `{agent, model}` config, like `judge.ts`) compares recent run traces to find repeating sub-processes. A cheap keyword pre-filter (`matchSkill`) returns a `high` or `borderline` confidence; borderline matches are confirmed by a secondary LLM gate (`confirmMatch`) before applying. The gateway wires a shared post-run pass (`afterRunSkillPass`) into both the channel path (`runOneTurn`) and the Chat/Mac path (`sendToChat`); all post-run LLM work is fire-and-forget so it never blocks a user-visible response. Pending skill suggestions on the chat surface are persisted per-chat via `ChatManager` (same pattern as `pendingTeam`), because Mac messages never pass through `handleMessage` — they enter via `sendToChat` directly.

**Tech Stack:** TypeScript (strict), existing `AgentFactory.run()` for LLM calls, Vitest for tests.

**Note on the class name:** the gateway class is `Codey` (`gateway.ts:42`), not `Gateway`. Static members are referenced as `Codey.NAME`.

---

## File Map

| File | Responsibility |
|------|---------------|
| `packages/core/src/skill-crystallizer.ts` (new) | `SkillStore` (CRUD, history/rollback, rejected list, traces, GC), `distillCandidate()`, `matchSkill()`, `confirmMatch()`, `applySkill()`, `evolveSkill()` |
| `packages/core/src/skill-crystallizer.test.ts` (new) | Unit tests for store + all standalone functions |
| `packages/core/src/index.ts` | Add `export * from './skill-crystallizer'` |
| `packages/core/src/workspace.ts` | `WorkspaceManager` owns a per-workspace `SkillStore` (`getSkillStore()`), re-created on switch/rename |
| `packages/core/src/types/chat.ts` | `Chat.pendingSkillSuggestion?` field |
| `packages/gateway/src/chats.ts` | `ChatManager.setPendingSkillSuggestion()` (persisted, mirrors `setPendingTeam`) |
| `packages/gateway/src/config.ts` | `skills?` block on `GatewayConfigJson`, `normalize()`, `getSkillsConfig()` accessor |
| `packages/gateway/src/gateway.ts` | Skill commands, `afterRunSkillPass`, pre-run injection on both surfaces, suggestion reply handling on both surfaces |
| `docs/superpowers/specs/2026-07-01-self-crystallizing-skills-design.md` | Amend YAGNI so spec and plan agree on v1 persistence |

---

### Task 0: Reconcile the spec with v1 persistence decisions

**Files:**
- Modify: `docs/superpowers/specs/2026-07-01-self-crystallizing-skills-design.md`

The plan persists `skills/index.json` + `skills/traces.json` only — no per-skill `.md` files and no `skills/archived/` directory in v1 (archived skills stay in the index with `archived: true`). This matches the actual `MemoryStore` behavior (despite its doc-comment, `memory.ts:492-519` writes only `index.json` + a legacy summary — no per-id `.md` files). The spec must say the same so the two documents agree.

- [ ] **Step 1: Replace the directory sketch in the spec's Architecture section**

Replace the ```skills/``` directory block (spec lines ~53-60) with:

```
workspaces/<name>/
  skills/
    index.json             — manifest of skills (active + archived) with per-skill
                             steps, version history, and rejected-suggestion list
    traces.json            — rolling run-trace history (survives restarts)
```

- [ ] **Step 2: Add two lines to the spec's "Out of Scope (YAGNI)" section**

```markdown
- Per-skill `.md` files on disk — v1 keeps steps + version history inside
  `index.json` (matches MemoryStore's actual persistence).
- `skills/archived/` subdirectory — archived skills stay in the index with
  `archived: true`; restorable via `/skill restore`.
- CJK-aware tokenization for matchSkill (bigram) — Latin-keyword matching only in v1.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-01-self-crystallizing-skills-design.md
git commit -m "docs(skills): align spec persistence model with v1 plan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: Define types and stubs

**Files:**
- Create: `packages/core/src/skill-crystallizer.ts`

- [ ] **Step 1: Create the file with types, SkillStore, and empty function stubs**

Note: `DistillDeps` is fully typed (no `any`) — same pattern as `GenerateDeps` in `worker-generator.ts:7-14`.

```typescript
// packages/core/src/skill-crystallizer.ts
//
// On-disk layout (under <workspace>/skills/):
//   index.json  — skill manifest: entries with version history, plus the rejected-suggestion list
//   traces.json — rolling window of recent run traces (capped at RECENT_TRACES_MAX)
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { AgentFactory } from './agents';
import { CodingAgent, ModelConfig } from './types';

// ── Types ──────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse: string;
  steps: string;
  version: number;
  /** Prior versions of steps, oldest first, capped at HISTORY_MAX. Enables rollback. */
  history: { version: number; steps: string }[];
  useCount: number;
  lastUsedAt: number;
  successSignals: { cleanRuns: number; corrections: number };
  sourceRunIds: string[];
  createdAt: number;
  archived: boolean;
}

export interface RejectedSuggestion {
  name: string;
  description: string;
  rejectedAt: number;
}

export interface SkillIndex {
  version: 1;
  entries: SkillEntry[];
  /** Suggestions the user said "no" to — fed to the distiller so it stops re-proposing them. */
  rejected: RejectedSuggestion[];
}

export interface RunTrace {
  runId: string;
  promptSummary: string;
  /** First ~300 chars of the agent's output. A preview, not a structural analysis. */
  outputPreview: string;
  workerSequence?: string[];
  timestamp: number;
  mode: 'solo' | 'team-sequential' | 'team-parallel' | 'team-auto';
}

export interface DistillDeps {
  agentFactory: AgentFactory;
  activeAgent: CodingAgent;
  activeModel: ModelConfig | undefined;
  workingDir: string;
}

export interface DistillResult {
  name: string;
  description: string;
  whenToUse: string;
  steps: string;
}

export interface SkillMatch {
  skill: SkillEntry;
  /** high → apply directly; borderline → confirm with the LLM gate first. */
  confidence: 'high' | 'borderline';
  score: number;
}

export const RECENT_TRACES_MAX = 20;
export const HISTORY_MAX = 5;
export const REJECTED_MAX = 20;

interface TracesFile {
  version: 1;
  traces: RunTrace[];
}

// ── SkillStore ─────────────────────────────────────────────────────

export class SkillStore {
  private workspacePath: string;
  private skillsDir: string;
  private indexPath: string;
  private tracesPath: string;
  private index: SkillIndex = { version: 1, entries: [], rejected: [] };
  private runTraces: RunTrace[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private indexDirty = false;
  private tracesDirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private static FLUSH_DEBOUNCE_MS = 50;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.skillsDir = path.join(workspacePath, 'skills');
    this.indexPath = path.join(this.skillsDir, 'index.json');
    this.tracesPath = path.join(this.skillsDir, 'traces.json');
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    if (fs.existsSync(this.indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as SkillIndex;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
          this.index = {
            version: 1,
            entries: parsed.entries.map(e => ({ ...e, history: e.history ?? [] })),
            rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
          };
        }
      } catch {
        this.index = { version: 1, entries: [], rejected: [] };
      }
    }
    if (fs.existsSync(this.tracesPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.tracesPath, 'utf-8')) as TracesFile;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.traces)) {
          this.runTraces = parsed.traces.slice(0, RECENT_TRACES_MAX);
        }
      } catch { /* start with empty traces */ }
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.enqueuePersist();
    }
    await this.writeChain;
  }

  // ── CRUD ─────────────────────────────────────────────────────

  add(params: {
    name: string;
    description: string;
    whenToUse: string;
    steps: string;
    sourceRunId?: string;
  }): SkillEntry {
    const now = Date.now();
    const existing = this.index.entries.find(e => e.name === params.name);
    if (existing) {
      if (existing.steps !== params.steps) {
        existing.history.push({ version: existing.version, steps: existing.steps });
        if (existing.history.length > HISTORY_MAX) {
          existing.history = existing.history.slice(-HISTORY_MAX);
        }
        existing.version++;
        existing.steps = params.steps;
      }
      existing.description = params.description;
      existing.whenToUse = params.whenToUse;
      if (params.sourceRunId && !existing.sourceRunIds.includes(params.sourceRunId)) {
        existing.sourceRunIds.push(params.sourceRunId);
      }
      this.markIndexDirty();
      return existing;
    }
    const entry: SkillEntry = {
      name: params.name,
      description: params.description,
      whenToUse: params.whenToUse,
      steps: params.steps,
      version: 1,
      history: [],
      useCount: 0,
      lastUsedAt: now,
      successSignals: { cleanRuns: 0, corrections: 0 },
      sourceRunIds: params.sourceRunId ? [params.sourceRunId] : [],
      createdAt: now,
      archived: false,
    };
    this.index.entries.push(entry);
    this.markIndexDirty();
    return entry;
  }

  get(name: string): SkillEntry | undefined {
    return this.index.entries.find(e => e.name === name);
  }

  getAll(): SkillEntry[] { return [...this.index.entries]; }

  getActive(): SkillEntry[] {
    return this.index.entries.filter(e => !e.archived);
  }

  archive(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.archived = true;
    this.markIndexDirty();
    return true;
  }

  restore(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.archived = false;
    this.markIndexDirty();
    return true;
  }

  recordUse(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.useCount++;
    entry.lastUsedAt = Date.now();
    this.markIndexDirty();
    return true;
  }

  recordSuccessSignal(name: string, clean: boolean): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    if (clean) entry.successSignals.cleanRuns++;
    else entry.successSignals.corrections++;
    this.markIndexDirty();
    return true;
  }

  /** Bump version, retaining the outgoing steps in history (capped) for rollback. */
  bumpVersion(name: string, newSteps: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.history.push({ version: entry.version, steps: entry.steps });
    if (entry.history.length > HISTORY_MAX) {
      entry.history = entry.history.slice(-HISTORY_MAX);
    }
    entry.version++;
    entry.steps = newSteps;
    this.markIndexDirty();
    return true;
  }

  /** Restore the most recent prior version of steps. Returns false if no history. */
  rollback(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    const prior = entry.history.pop();
    if (!prior) return false;
    entry.version = prior.version;
    entry.steps = prior.steps;
    this.markIndexDirty();
    return true;
  }

  // ── Rejected suggestions ─────────────────────────────────────

  rejectSuggestion(name: string, description: string): void {
    this.index.rejected.push({ name, description, rejectedAt: Date.now() });
    if (this.index.rejected.length > REJECTED_MAX) {
      this.index.rejected = this.index.rejected.slice(-REJECTED_MAX);
    }
    this.markIndexDirty();
  }

  getRejected(): RejectedSuggestion[] { return [...this.index.rejected]; }

  // ── Traces (persisted) ───────────────────────────────────────

  recordTrace(trace: RunTrace): void {
    this.runTraces.unshift(trace);
    if (this.runTraces.length > RECENT_TRACES_MAX) {
      this.runTraces = this.runTraces.slice(0, RECENT_TRACES_MAX);
    }
    this.markTracesDirty();
  }

  getRecentTraces(limit: number = 10): RunTrace[] {
    return this.runTraces.slice(0, limit);
  }

  // ── GC ───────────────────────────────────────────────────────

  runCollectGarbage(opts: { staleDays: number; weakSkillDays: number }): number {
    const now = Date.now();
    let archived = 0;
    for (const entry of this.index.entries) {
      if (entry.archived) continue;
      if (now - entry.lastUsedAt > opts.staleDays * 86_400_000) {
        entry.archived = true;
        archived++;
        continue;
      }
      if (
        entry.useCount < 2 &&
        now - entry.createdAt > opts.weakSkillDays * 86_400_000 &&
        now - entry.lastUsedAt > opts.weakSkillDays * 86_400_000
      ) {
        entry.archived = true;
        archived++;
      }
    }
    if (archived > 0) this.markIndexDirty();
    return archived;
  }

  // ── Persistence ──────────────────────────────────────────────

  private markIndexDirty(): void {
    this.indexDirty = true;
    this.scheduleFlush();
  }

  private markTracesDirty(): void {
    this.tracesDirty = true;
    this.scheduleFlush();
  }

  private enqueuePersist(): void {
    this.writeChain = this.writeChain.then(() => this.doPersist()).catch(() => {});
  }

  private async doPersist(): Promise<void> {
    if (!this.indexDirty && !this.tracesDirty) return;
    const writeIndex = this.indexDirty;
    const writeTraces = this.tracesDirty;
    this.indexDirty = false;
    this.tracesDirty = false;
    // Serialize synchronously so later mutations in this tick can't tear the snapshot.
    const indexJson = writeIndex ? JSON.stringify(this.index, null, 2) : null;
    const tracesPayload: TracesFile = { version: 1, traces: this.runTraces };
    const tracesJson = writeTraces ? JSON.stringify(tracesPayload, null, 2) : null;
    try {
      await fsp.mkdir(this.skillsDir, { recursive: true });
      if (indexJson !== null) {
        await atomicWrite(this.indexPath, indexJson);
      }
      if (tracesJson !== null) {
        await atomicWrite(this.tracesPath, tracesJson);
      }
    } catch {
      this.indexDirty = this.indexDirty || writeIndex;
      this.tracesDirty = this.tracesDirty || writeTraces;
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueuePersist();
    }, SkillStore.FLUSH_DEBOUNCE_MS);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }
}

// ── Helpers ─────────────────────────────────────────────────────

async function atomicWrite(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, target);
}

function stripCodeFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}

// ── Stubs (filled in later tasks) ──────────────────────────────

export async function distillCandidate(
  _deps: DistillDeps, _traces: RunTrace[], _existing: SkillEntry[],
  _rejected: RejectedSuggestion[], _minRecurrence: number,
): Promise<DistillResult | null> { return null; }

export function matchSkill(_task: string, _skills: SkillEntry[]): SkillMatch | null { return null; }

export async function confirmMatch(
  _deps: DistillDeps, _task: string, _skill: SkillEntry,
): Promise<boolean> { return false; }

export function applySkill(task: string, _skill: SkillEntry): string { return task; }

export async function evolveSkill(
  _deps: DistillDeps, _skill: SkillEntry, _trace: RunTrace,
): Promise<string | null> { return null; }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npx tsc --noEmit -p packages/core/tsconfig.json 2>&1
```
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts
git commit -m "feat(skills): SkillStore with persisted traces, history/rollback, rejected list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: SkillStore unit tests

**Files:**
- Create: `packages/core/src/skill-crystallizer.test.ts`

- [ ] **Step 1: Write the full test file**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore, RECENT_TRACES_MAX, HISTORY_MAX, REJECTED_MAX } from './skill-crystallizer';

describe('SkillStore', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skills-test-'));
    store = new SkillStore(tmp);
    await store.load();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds a skill and persists to index.json', async () => {
    const entry = store.add({
      name: 'release-notes',
      description: 'Draft release notes from merged PRs',
      whenToUse: 'user asks for release notes or changelog',
      steps: '1. fetch merged PRs\n2. group by type\n3. format output',
      sourceRunId: 'run_001',
    });
    expect(entry.name).toBe('release-notes');
    expect(entry.version).toBe(1);
    expect(entry.history).toEqual([]);
    expect(entry.archived).toBe(false);
    expect(entry.useCount).toBe(0);
    await store.flush();
    const indexPath = path.join(tmp, 'skills', 'index.json');
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(raw.entries.length).toBe(1);
    expect(raw.entries[0].name).toBe('release-notes');
  });

  it('loads existing skills from disk and defaults missing history/rejected', async () => {
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'index.json'), JSON.stringify({
      version: 1,
      entries: [{
        name: 'weekly-digest', description: 'Generate weekly summary',
        whenToUse: 'user asks for weekly report',
        steps: '1. gather\n2. format',
        version: 2, useCount: 3, lastUsedAt: Date.now() - 86400000,
        successSignals: { cleanRuns: 2, corrections: 1 },
        sourceRunIds: ['run_a'], createdAt: Date.now() - 604800000,
        archived: false,
      }],
    }));
    const store2 = new SkillStore(tmp);
    await store2.load();
    expect(store2.getAll().length).toBe(1);
    expect(store2.get('weekly-digest')!.version).toBe(2);
    expect(store2.get('weekly-digest')!.history).toEqual([]);
    expect(store2.getRejected()).toEqual([]);
  });

  it('add() on existing name updates in place', () => {
    store.add({ name: 'test', description: 'first', whenToUse: 'w', steps: 's' });
    store.add({ name: 'test', description: 'second', whenToUse: 'w2', steps: 's2' });
    expect(store.getAll().length).toBe(1);
    const u = store.get('test')!;
    expect(u.description).toBe('second');
    // Changed steps bump the version and retain the old steps in history.
    expect(u.version).toBe(2);
    expect(u.history).toEqual([{ version: 1, steps: 's' }]);
    // Re-adding with identical steps does NOT bump the version.
    store.add({ name: 'test', description: 'third', whenToUse: 'w3', steps: 's2' });
    const u2 = store.get('test')!;
    expect(u2.version).toBe(2);
    expect(u2.history).toEqual([{ version: 1, steps: 's' }]);
    expect(u2.description).toBe('third');
  });

  it('archive() and restore()', () => {
    store.add({ name: 's', description: 'd', whenToUse: 'w', steps: 'st' });
    expect(store.archive('s')).toBe(true);
    expect(store.get('s')!.archived).toBe(true);
    expect(store.getActive().length).toBe(0);
    expect(store.restore('s')).toBe(true);
    expect(store.get('s')!.archived).toBe(false);
    expect(store.getActive().length).toBe(1);
  });

  it('recordUse bumps useCount and lastUsedAt', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 's' });
    const before = Date.now();
    store.recordUse('test');
    const u = store.get('test')!;
    expect(u.useCount).toBe(1);
    expect(u.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it('recordSuccessSignal tracks clean runs vs corrections', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 's' });
    store.recordSuccessSignal('test', true);
    store.recordSuccessSignal('test', false);
    const s = store.get('test')!.successSignals;
    expect(s.cleanRuns).toBe(1);
    expect(s.corrections).toBe(1);
  });

  it('bumpVersion retains prior steps in history', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 'old' });
    expect(store.bumpVersion('test', 'new')).toBe(true);
    const u = store.get('test')!;
    expect(u.version).toBe(2);
    expect(u.steps).toBe('new');
    expect(u.history).toEqual([{ version: 1, steps: 'old' }]);
  });

  it('history is capped at HISTORY_MAX', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 'v1' });
    for (let i = 2; i <= HISTORY_MAX + 3; i++) {
      store.bumpVersion('test', `v${i}`);
    }
    const u = store.get('test')!;
    expect(u.history.length).toBe(HISTORY_MAX);
    expect(u.history[u.history.length - 1].steps).toBe(`v${HISTORY_MAX + 2}`);
  });

  it('rollback restores the prior version and steps', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 'old' });
    store.bumpVersion('test', 'new');
    expect(store.rollback('test')).toBe(true);
    const u = store.get('test')!;
    expect(u.version).toBe(1);
    expect(u.steps).toBe('old');
    expect(u.history).toEqual([]);
  });

  it('rollback returns false with no history', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 's' });
    expect(store.rollback('test')).toBe(false);
  });

  it('rejectSuggestion records and caps at REJECTED_MAX', () => {
    for (let i = 0; i < REJECTED_MAX + 5; i++) {
      store.rejectSuggestion(`skill-${i}`, `desc ${i}`);
    }
    const rejected = store.getRejected();
    expect(rejected.length).toBe(REJECTED_MAX);
    expect(rejected[rejected.length - 1].name).toBe(`skill-${REJECTED_MAX + 4}`);
  });

  it('recordTrace stores traces and caps at RECENT_TRACES_MAX', () => {
    for (let i = 0; i < RECENT_TRACES_MAX + 5; i++) {
      store.recordTrace({
        runId: `run_${i}`, promptSummary: 'task', outputPreview: 'text',
        timestamp: Date.now() - i * 60000, mode: 'solo',
      });
    }
    const recent = store.getRecentTraces(100);
    expect(recent.length).toBe(RECENT_TRACES_MAX);
    expect(recent[0].runId).toBe(`run_${RECENT_TRACES_MAX + 4}`);
  });

  it('traces persist to disk and reload across store instances', async () => {
    store.recordTrace({ runId: 'r1', promptSummary: 'draft notes', outputPreview: 'md', timestamp: 1000, mode: 'solo' });
    store.recordTrace({ runId: 'r2', promptSummary: 'changelog', outputPreview: 'md', timestamp: 2000, mode: 'solo' });
    await store.flush();
    const store2 = new SkillStore(tmp);
    await store2.load();
    const traces = store2.getRecentTraces(10);
    expect(traces.length).toBe(2);
    expect(traces[0].runId).toBe('r2');
  });

  it('getRecentTraces returns most recent first', () => {
    store.recordTrace({ runId: 'older', promptSummary: 'o', outputPreview: 't', timestamp: 1000, mode: 'solo' });
    store.recordTrace({ runId: 'newer', promptSummary: 'n', outputPreview: 't', timestamp: 2000, mode: 'solo' });
    expect(store.getRecentTraces(10)[0].runId).toBe('newer');
  });

  it('runCollectGarbage archives stale and weak skills', () => {
    const old = Date.now() - 31 * 86_400_000;
    const s1 = store.add({ name: 'old', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r1' });
    s1.lastUsedAt = old;
    const s2 = store.add({ name: 'weak', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r2' });
    s2.createdAt = old;
    s2.lastUsedAt = old;
    const s3 = store.add({ name: 'active', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r3' });
    s3.useCount = 5;
    s3.lastUsedAt = Date.now() - 86_400_000;
    const archived = store.runCollectGarbage({ staleDays: 30, weakSkillDays: 7 });
    expect(archived).toBe(2);
    expect(store.get('old')!.archived).toBe(true);
    expect(store.get('weak')!.archived).toBe(true);
    expect(store.get('active')!.archived).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -20
```
Expected: 15 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skill-crystallizer.test.ts
git commit -m "test(skills): SkillStore CRUD, history/rollback, rejected, traces, GC

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Distill candidate skills (LLM)

**Files:**
- Modify: `packages/core/src/skill-crystallizer.ts` — replace `distillCandidate` stub
- Modify: `packages/core/src/skill-crystallizer.test.ts` — add distill tests

- [ ] **Step 1: Add distill tests**

Append to `packages/core/src/skill-crystallizer.test.ts`:

```typescript
import { distillCandidate, RunTrace, DistillDeps } from './skill-crystallizer';

function fakeDeps(runImpl: (req: any) => Promise<any>): DistillDeps {
  return {
    activeAgent: 'claude-code' as any,
    activeModel: { provider: 'anthropic', model: 'test' } as any,
    workingDir: '/tmp',
    agentFactory: { run: (_agent: any, req: any) => runImpl(req) } as any,
  };
}

describe('distillCandidate', () => {
  it('returns null for empty traces', async () => {
    const result = await distillCandidate(null as any, [], [], [], 2);
    expect(result).toBeNull();
  });

  it('returns null when fewer traces than minRecurrence', async () => {
    const result = await distillCandidate(null as any,
      [{ runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' }],
      [], [], 2);
    expect(result).toBeNull();
  });

  it('calls agent with traces and rejected list, parses JSON result', async () => {
    let calledPrompt = '';
    const deps = fakeDeps(async (req) => {
      calledPrompt = req.prompt;
      return { success: true, output: JSON.stringify({
        name: 'release-notes',
        description: 'Generate release notes from merged PRs',
        whenToUse: 'user asks for release notes or changelog',
        steps: '1. fetch PRs\n2. group by type\n3. format with links',
      }), error: null, tokens: { total: 100 } };
    });
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'Draft release notes', outputPreview: 'markdown list', timestamp: 1, mode: 'solo' },
      { runId: '2', promptSummary: 'Generate changelog', outputPreview: 'markdown list', timestamp: 2, mode: 'solo' },
      { runId: '3', promptSummary: 'Write release announcement', outputPreview: 'markdown list', timestamp: 3, mode: 'solo' },
    ];
    const rejected = [{ name: 'weekly-digest', description: 'Weekly summary', rejectedAt: 1 }];
    const result = await distillCandidate(deps, traces, [], rejected, 2);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('release-notes');
    expect(result!.steps).toContain('fetch PRs');
    expect(calledPrompt).toContain('Draft release notes');
    expect(calledPrompt).toContain('release announcement');
    expect(calledPrompt).toContain('weekly-digest');
  });

  it('returns null on "NONE" response', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'NONE', error: null, tokens: { total: 10 } }));
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).toBeNull();
  });

  it('returns null on unparseable output', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'garbage', error: null, tokens: { total: 10 } }));
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).toBeNull();
  });

  it('returns null when result fields are missing or not strings', async () => {
    const deps = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({ name: 'valid-name', steps: '1. x' }), // no description/whenToUse
      error: null, tokens: { total: 10 },
    }));
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).toBeNull();
  });

  it('retries once on garbage then returns the valid second result', async () => {
    const prompts: string[] = [];
    const deps = fakeDeps(async (req) => {
      prompts.push(req.prompt);
      if (prompts.length === 1) {
        return { success: true, output: 'garbage', error: null, tokens: { total: 10 } };
      }
      return { success: true, output: JSON.stringify({
        name: 'release-notes',
        description: 'Generate release notes',
        whenToUse: 'user asks for release notes',
        steps: '1. fetch PRs\n2. format',
      }), error: null, tokens: { total: 100 } };
    });
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('release-notes');
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('Reminder: return ONLY the JSON');
  });

  it('returns null when the name fails validation (bad chars or too short)', async () => {
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const badName = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({
        name: 'Bad Name', description: 'd', whenToUse: 'w', steps: '1. x',
      }),
      error: null, tokens: { total: 10 },
    }));
    expect(await distillCandidate(badName, traces, [], [], 2)).toBeNull();

    const tooShort = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({
        name: 'ab', description: 'd', whenToUse: 'w', steps: '1. x',
      }),
      error: null, tokens: { total: 10 },
    }));
    expect(await distillCandidate(tooShort, traces, [], [], 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```
Expected: the "calls agent" test FAILS (stub returns null).

- [ ] **Step 3: Implement distillCandidate**

Replace the `distillCandidate` stub in `packages/core/src/skill-crystallizer.ts`:

```typescript
const DISTILL_PROMPT = `You analyze coding-agent runs to find recurring work patterns.

Given these recent run traces and existing skills, identify a repeatable sub-process that appears in 2+ runs. If you find one, describe it as a reusable skill. If none, return exactly "NONE".

Recent traces:
%TRACES%

Existing skills (don't duplicate):
%SKILLS%

Previously rejected suggestions (the user said no — do NOT re-propose these or close variants):
%REJECTED%

Return ONE JSON object (no markdown, no prose) or the literal word "NONE":
{
  "name": "kebab-case",
  "description": "one line describing what this skill does",
  "whenToUse": "when the user asks to...",
  "steps": "1. ...\\n2. ...\\n3. ..."
}

Rules:
- name must match /^[a-z][a-z0-9-]*$/ and be 3-30 chars.
- Output ONLY the JSON or "NONE". No markdown fences, no prose.`;

function formatTracesForPrompt(traces: RunTrace[]): string {
  return traces.map(t => {
    const parts = [`- ${t.promptSummary} [${t.mode}]`];
    if (t.workerSequence && t.workerSequence.length > 0) {
      parts.push(`  Steps: ${t.workerSequence.join(' → ')}`);
    }
    return parts.join('\n');
  }).join('\n');
}

function formatSkillsForPrompt(skills: SkillEntry[]): string {
  if (skills.length === 0) return '(none)';
  return skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
}

function formatRejectedForPrompt(rejected: RejectedSuggestion[]): string {
  if (rejected.length === 0) return '(none)';
  return rejected.map(r => `- ${r.name}: ${r.description}`).join('\n');
}

function tryParseDistill(raw: string): DistillResult | null {
  const trimmed = raw.trim();
  if (trimmed === 'NONE' || trimmed === '"NONE"') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stripCodeFences(trimmed)); } catch { return null; }
  const p = parsed as Record<string, unknown>;
  if (!p || typeof p !== 'object') return null;
  for (const field of ['name', 'description', 'whenToUse', 'steps'] as const) {
    if (typeof p[field] !== 'string' || !(p[field] as string).trim()) return null;
  }
  return { name: p.name as string, description: p.description as string,
           whenToUse: p.whenToUse as string, steps: p.steps as string };
}

export async function distillCandidate(
  deps: DistillDeps,
  traces: RunTrace[],
  existing: SkillEntry[],
  rejected: RejectedSuggestion[],
  minRecurrence: number,
): Promise<DistillResult | null> {
  if (traces.length < minRecurrence) return null;

  // Function replacement: string replacements would corrupt user-derived
  // content containing $-patterns ($&, $', $$, ...).
  const sections: Record<string, string> = {
    '%TRACES%': formatTracesForPrompt(traces),
    '%SKILLS%': formatSkillsForPrompt(existing.filter(s => !s.archived)),
    '%REJECTED%': formatRejectedForPrompt(rejected),
  };
  const composed = DISTILL_PROMPT.replace(/%(TRACES|SKILLS|REJECTED)%/g, m => sections[m]);

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await deps.agentFactory.run(deps.activeAgent, {
      prompt: attempt === 0 ? composed
        : `${composed}\n\nReminder: return ONLY the JSON object or the word "NONE". No markdown.`,
      agent: deps.activeAgent,
      model: deps.activeModel,
      interactive: false,
      skipPermissions: true,
      context: { workingDir: deps.workingDir },
    } as any);
    if (!response.success) continue;
    const parsed = tryParseDistill(response.output);
    if (parsed) {
      if (/^[a-z][a-z0-9-]*$/.test(parsed.name) && parsed.name.length >= 3 && parsed.name.length <= 30) {
        return parsed;
      }
    }
    if (response.output.trim() === 'NONE') return null;
  }
  return null;
}
```

Note: if `AgentFactory.run()`'s request type accepts these fields directly, drop the `as any` on the request — check `packages/core/src/agents` for the exact request interface and use it.

- [ ] **Step 4: Run tests — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```
Expected: 23 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts packages/core/src/skill-crystallizer.test.ts
git commit -m "feat(skills): LLM distillCandidate with rejected-suggestion suppression

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Skill matching (keyword pre-filter with confidence + LLM confirm)

**Files:**
- Modify: `packages/core/src/skill-crystallizer.ts` — replace `matchSkill` + `confirmMatch` stubs
- Modify: `packages/core/src/skill-crystallizer.test.ts` — add matching tests

`matchSkill` returns a `SkillMatch` with `confidence: 'high' | 'borderline'`. The gateway applies `high` matches directly and routes `borderline` matches through `confirmMatch` (the LLM gate) — this is how the spec's "cheap description match → confirm with a lightweight LLM check" is wired, and it is what makes single-keyword overlaps (e.g. only "changelog") usable without false positives.

- [ ] **Step 1: Add matching tests**

Append to test file:

```typescript
import { matchSkill, confirmMatch, SkillEntry } from './skill-crystallizer';

function makeSkill(over: Partial<SkillEntry>): SkillEntry {
  return {
    name: 'x', description: '', whenToUse: '', steps: 's',
    version: 1, history: [], useCount: 0, lastUsedAt: Date.now(),
    successSignals: { cleanRuns: 0, corrections: 0 },
    sourceRunIds: [], createdAt: Date.now(), archived: false,
    ...over,
  };
}

describe('matchSkill', () => {
  const skills: SkillEntry[] = [
    makeSkill({ name: 'release-notes', description: 'Generate release notes', whenToUse: 'user asks for release notes or changelog' }),
    makeSkill({ name: 'fix-lint', description: 'Fix lint errors', whenToUse: 'user reports lint errors or ESLint failures' }),
    makeSkill({ name: 'archived-x', description: 'Hidden', whenToUse: 'anything', archived: true }),
  ];

  it('high-confidence match for multi-keyword overlap', () => {
    const m = matchSkill('generate release notes from merged PRs', skills);
    expect(m?.skill.name).toBe('release-notes');
    expect(m?.confidence).toBe('high');
  });

  it('borderline match for single-keyword overlap', () => {
    const m = matchSkill('write a changelog for v2.1', skills);
    expect(m?.skill.name).toBe('release-notes');
    expect(m?.confidence).toBe('borderline');
  });

  it('matches fix-lint for ESLint task', () => {
    const m = matchSkill('eslint is failing on CI, can you fix?', skills);
    expect(m?.skill.name).toBe('fix-lint');
  });

  it('returns null for unrelated task', () => {
    expect(matchSkill('build a REST API for users', skills)).toBeNull();
  });

  it('never matches archived skills', () => {
    expect(matchSkill('do anything at all please', skills)).toBeNull();
  });

  it('duplicated words in skill text do not inflate confidence past borderline', () => {
    const dup = [makeSkill({ name: 'dup', description: 'changelog changelog changelog tool', whenToUse: '' })];
    const m = matchSkill('write a changelog for v2.1', dup);
    expect(m?.skill.name).toBe('dup');
    expect(m?.confidence).toBe('borderline');
  });

  it('two overlapping tokens diluted by a long description stay borderline (score gate)', () => {
    const verbose = [makeSkill({
      name: 'verbose',
      description: 'release notes alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma',
      whenToUse: '',
    })];
    const m = matchSkill('generate release notes', verbose);
    expect(m?.skill.name).toBe('verbose');
    expect(m?.confidence).toBe('borderline');
  });
});

describe('confirmMatch', () => {
  const skill = makeSkill({ name: 'release-notes', description: 'Generate release notes', whenToUse: 'release notes or changelog' });

  it('returns true on YES', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'YES', error: null, tokens: { total: 5 } }));
    expect(await confirmMatch(deps, 'write a changelog', skill)).toBe(true);
  });

  it('returns false on NO', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'NO', error: null, tokens: { total: 5 } }));
    expect(await confirmMatch(deps, 'build an API', skill)).toBe(false);
  });

  it('returns false on failed agent call', async () => {
    const deps = fakeDeps(async () => ({ success: false, output: '', error: 'crash', tokens: { total: 0 } }));
    expect(await confirmMatch(deps, 'write a changelog', skill)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```

- [ ] **Step 3: Implement matchSkill + confirmMatch**

Replace the stubs:

```typescript
export function matchSkill(task: string, skills: SkillEntry[]): SkillMatch | null {
  const active = skills.filter(s => !s.archived);
  if (active.length === 0) return null;
  // Dedupe both token lists so repeated words can't inflate the intersection
  // count past the LLM confirm gate; this also makes the score true Jaccard.
  const taskTokens = [...new Set(tokenizeLax(task))];
  if (taskTokens.length === 0) return null;
  let best: SkillMatch | null = null;
  for (const skill of active) {
    const skillTokens = [...new Set(tokenizeLax(`${skill.description} ${skill.whenToUse}`))];
    if (skillTokens.length === 0) continue;
    const intersection = skillTokens.filter(t => taskTokens.includes(t));
    if (intersection.length < 1) continue;
    const unionSize = new Set([...taskTokens, ...skillTokens]).size;
    const score = intersection.length / unionSize;
    const confidence: SkillMatch['confidence'] =
      intersection.length >= 2 && score > 0.1 ? 'high' : 'borderline';
    if (!best || score > best.score) {
      best = { skill, confidence, score };
    }
  }
  return best;
}

// Limitation: Latin/alphanumeric keywords only. CJK text produces no tokens,
// so pure-CJK prompts never auto-match (they simply skip the skill fast-path);
// mixed-script prompts still match via their Latin keywords. Bigram
// tokenization for CJK is a possible v2.
function tokenizeLax(text: string): string[] {
  if (!text) return [];
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for',
    'from', 'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or',
    'that', 'the', 'to', 'was', 'were', 'will', 'with', 'you', 'i', 'me',
    'my', 'we', 'our', 'this',
  ]);
  return text.toLowerCase()
    .split(/[^a-z0-9_\-]+/i)
    .filter(t => t.length > 1 && !stopWords.has(t));
}

const MATCH_CONFIRM_PROMPT = `Does the following task match this skill? The skill should only apply when the user is asking for exactly this kind of work.

Skill: %SKILL_NAME%
Description: %SKILL_DESC%
When to use: %SKILL_WHEN%

Task: %TASK%

Return ONLY "YES" or "NO".`;

export async function confirmMatch(
  deps: DistillDeps,
  task: string,
  skill: SkillEntry,
): Promise<boolean> {
  // Function replacement: string replacements would corrupt user-derived
  // content containing $-patterns ($&, $', $$, ...).
  const sections: Record<string, string> = {
    '%SKILL_NAME%': skill.name,
    '%SKILL_DESC%': skill.description,
    '%SKILL_WHEN%': skill.whenToUse,
    '%TASK%': task,
  };
  const prompt = MATCH_CONFIRM_PROMPT.replace(
    /%(SKILL_NAME|SKILL_DESC|SKILL_WHEN|TASK)%/g, m => sections[m]);
  const response = await deps.agentFactory.run(deps.activeAgent, {
    prompt, agent: deps.activeAgent, model: deps.activeModel,
    interactive: false, skipPermissions: true,
    context: { workingDir: deps.workingDir },
  });
  if (!response.success) return false;
  return response.output.trim().toUpperCase() === 'YES';
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```
Expected: 33 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts packages/core/src/skill-crystallizer.test.ts
git commit -m "feat(skills): confidence-scored matchSkill + LLM confirmMatch gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Skill application and evolution

**Files:**
- Modify: `packages/core/src/skill-crystallizer.ts` — replace `applySkill` + `evolveSkill` stubs
- Modify: `packages/core/src/skill-crystallizer.test.ts` — add apply + evolve tests

- [ ] **Step 1: Add apply + evolve tests**

Append to test file:

```typescript
import { applySkill, evolveSkill } from './skill-crystallizer';

describe('applySkill', () => {
  const skill = makeSkill({
    name: 'release-notes', description: 'Generate release notes',
    whenToUse: 'user asks for release notes',
    steps: '1. fetch merged PRs\n2. group by type\n3. format with links',
    version: 2,
  });

  it('prepends banner + steps before task', () => {
    const result = applySkill('generate release notes for v2.1', skill);
    expect(result).toContain('using skill: release-notes (v2)');
    expect(result).toContain('1. fetch merged PRs');
    expect(result).toContain('generate release notes for v2.1');
    const skillPos = result.indexOf('1. fetch merged PRs');
    const taskPos = result.indexOf('generate release notes for v2.1');
    expect(skillPos).toBeLessThan(taskPos);
  });

  it('handles empty task', () => {
    const result = applySkill('', skill);
    expect(result).toContain('using skill: release-notes');
  });
});

describe('evolveSkill', () => {
  const skill = makeSkill({
    name: 'release-notes', description: 'Release notes',
    whenToUse: 'release notes', steps: '1. fetch PRs\n2. group',
    useCount: 3, successSignals: { cleanRuns: 2, corrections: 1 },
  });
  const trace: RunTrace = {
    runId: 'r2', promptSummary: 'Draft release notes',
    outputPreview: 'markdown with sections', timestamp: Date.now(), mode: 'solo',
  };

  it('evolves when agent finds better steps', async () => {
    const deps = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({ improved: true, steps: '1. fetch\n2. group\n3. add links\n4. format' }),
      error: null, tokens: { total: 100 },
    }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).not.toBeNull();
    expect(result).toContain('add links');
  });

  it('returns null when no improvement needed', async () => {
    const deps = fakeDeps(async () => ({
      success: true, output: JSON.stringify({ improved: false }), error: null, tokens: { total: 50 },
    }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });

  it('returns null on failed agent call', async () => {
    const deps = fakeDeps(async () => ({ success: false, output: '', error: 'crash', tokens: { total: 0 } }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```

- [ ] **Step 3: Implement applySkill + evolveSkill**

Replace the stubs:

```typescript
export function applySkill(task: string, skill: SkillEntry): string {
  const banner = `⚙︎ using skill: ${skill.name} (v${skill.version})\n\nFollow this procedure:\n${skill.steps}\n\n---\nNow execute this task:`;
  return task ? `${banner} ${task}` : `${banner}\n\nProceed with the procedure above.`;
}

const EVOLVE_PROMPT = `A skill was just applied to a coding task. Review whether the skill's steps should be improved based on what actually happened.

Skill: %SKILL_NAME%
Description: %SKILL_DESC%
When to use: %SKILL_WHEN%

Current steps:
%STEPS%

Run context:
- Task: %TASK_SUMMARY%
- Output preview: %OUTPUT_PREVIEW%
- Mode: %MODE%
%WORKER_STEPS%

Does the run suggest a better version of the steps? If yes, return improved steps. If the current steps are fine, say no change. Only propose a change when the run clearly revealed a missing, wrong, or better step — do not rephrase working steps.

Return ONE JSON:
{"improved": true, "steps": "1. ...\\n2. ...\\n3. ..."}
or
{"improved": false}

Output ONLY JSON. No markdown fences, no prose.`;

export async function evolveSkill(
  deps: DistillDeps,
  skill: SkillEntry,
  trace: RunTrace,
): Promise<string | null> {
  let workerPart = '';
  if (trace.workerSequence && trace.workerSequence.length > 0) {
    workerPart = `- Worker sequence: ${trace.workerSequence.join(' → ')}`;
  }
  // Function replacement: string replacements would corrupt user-derived
  // content containing $-patterns ($&, $', $$, ...).
  const sections: Record<string, string> = {
    '%SKILL_NAME%': skill.name,
    '%SKILL_DESC%': skill.description,
    '%SKILL_WHEN%': skill.whenToUse,
    '%STEPS%': skill.steps,
    '%TASK_SUMMARY%': trace.promptSummary,
    '%OUTPUT_PREVIEW%': trace.outputPreview,
    '%MODE%': trace.mode,
    '%WORKER_STEPS%': workerPart,
  };
  const composed = EVOLVE_PROMPT.replace(
    /%(SKILL_NAME|SKILL_DESC|SKILL_WHEN|STEPS|TASK_SUMMARY|OUTPUT_PREVIEW|MODE|WORKER_STEPS)%/g,
    m => sections[m]);

  const response = await deps.agentFactory.run(deps.activeAgent, {
    prompt: composed, agent: deps.activeAgent, model: deps.activeModel,
    interactive: false, skipPermissions: true,
    context: { workingDir: deps.workingDir },
  });
  if (!response.success) return null;
  try {
    const parsed = JSON.parse(stripCodeFences(response.output));
    if (parsed.improved === true && typeof parsed.steps === 'string' && parsed.steps.trim()) {
      return parsed.steps.trim();
    }
  } catch { /* unparseable — no change */ }
  return null;
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```
Expected: 38 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts packages/core/src/skill-crystallizer.test.ts
git commit -m "feat(skills): applySkill prompt injection + evolveSkill refinement

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Export from core barrel

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the export line**

After the `worker-generator` export (line 7), add:

```typescript
export * from './skill-crystallizer';
```

- [ ] **Step 2: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/core 2>&1
```
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(skills): export skill-crystallizer from core barrel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: WorkspaceManager owns the SkillStore

**Files:**
- Modify: `packages/core/src/workspace.ts`
- Modify: `packages/core/src/workspace.test.ts`

Ownership by `WorkspaceManager` — not the gateway — is what makes workspace switching correct for free: the store is re-created alongside `memoryStore` in every place a workspace changes. The gateway always fetches it via `this.workspaceManager.getSkillStore()` (same call pattern as `getMemoryStore()` at `gateway.ts:1103`).

- [ ] **Step 1: Add the field and construct alongside memoryStore**

In `packages/core/src/workspace.ts`:

Add import at the top (next to the `MemoryStore` import at line 6):

```typescript
import { SkillStore } from './skill-crystallizer';
```

Add the field next to `private memoryStore: MemoryStore;` (line 76):

```typescript
  private skillStore: SkillStore;
```

In the constructor, after `this.memoryStore = new MemoryStore(this.getWorkspacePath());` (line 91):

```typescript
    this.skillStore = new SkillStore(this.getWorkspacePath());
```

- [ ] **Step 2: Load alongside memoryStore on workspace load/switch**

After `this.memoryStore = new MemoryStore(workspacePath); await this.memoryStore.load();` (lines 158-159):

```typescript
    this.skillStore = new SkillStore(workspacePath);
    await this.skillStore.load();
```

Immediately before replacing the stores, flush the outgoing ones (try/catch-ignore) so a pending 50ms debounced write can't recreate a ghost directory under the previous workspace path.

- [ ] **Step 3: Re-create AND load on workspace rename**

In `renameWorkspace`'s current-workspace branch: flush both outgoing stores BEFORE `fs.promises.rename` (their paths point at the old dir), then after the rename re-create and `await ...load()` both stores. Skipping the load() means the first write clobbers the renamed workspace's `skills/index.json` / memory index with an empty one:

```typescript
      this.memoryStore = new MemoryStore(this.getWorkspacePath());
      await this.memoryStore.load();
      this.skillStore = new SkillStore(this.getWorkspacePath());
      await this.skillStore.load();
```

- [ ] **Step 4: Add the accessor**

Next to `getMemoryStore(): MemoryStore { return this.memoryStore; }` (line 275):

```typescript
  getSkillStore(): SkillStore { return this.skillStore; }
```

- [ ] **Step 5: Add tests**

Append a `WorkspaceManager SkillStore` describe to `packages/core/src/workspace.test.ts` (follow the file's existing fixture patterns). Cover:
- Hydration: seed `<workspace>/skills/index.json` with one valid v1 entry, load, assert `getSkillStore().getActive()` returns it.
- Rename: rename the active workspace, assert the skill is still active AND that a post-rename `flush()` does not clobber the renamed workspace's `skills/index.json` (regression for Step 3's load()).
- Per-workspace: after `switchWorkspace` to another workspace, `getSkillStore()` returns a different reference with no skills.

- [ ] **Step 6: Run core tests + build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core 2>&1 | tail -10 && npm run build -w packages/core 2>&1
```
Expected: All PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/workspace.ts packages/core/src/workspace.test.ts
git commit -m "feat(skills): WorkspaceManager owns per-workspace SkillStore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Gateway config — skills block

**Files:**
- Modify: `packages/gateway/src/config.ts`

- [ ] **Step 1: Add `skills?` to GatewayConfigJson**

In the `GatewayConfigJson` interface, add after the `aide?` block (`config.ts:55-58`):

```typescript
  /** Self-crystallizing skills configuration. All fields optional — defaults are sensible. */
  skills?: {
    enabled?: boolean;
    suggestOnRepeat?: number;
    autoApply?: boolean;
    staleDays?: number;
    weakSkillDays?: number;
    /** Model override for distillation. Falls back to advisor.model. */
    distillModel?: string;
  };
```

- [ ] **Step 2: Add to normalize()**

In the `normalize()` function (`config.ts:528`), after the `aide` block (`config.ts:551-556`):

```typescript
  if (raw.skills && typeof raw.skills === 'object') {
    out.skills = {
      enabled: raw.skills.enabled,
      suggestOnRepeat: raw.skills.suggestOnRepeat,
      autoApply: raw.skills.autoApply,
      staleDays: raw.skills.staleDays,
      weakSkillDays: raw.skills.weakSkillDays,
      distillModel: raw.skills.distillModel,
    };
  }
```

- [ ] **Step 3: Add accessor to ConfigManager class**

Note: `getAideAgentAndModel()`/`getAdvisorAgentAndModel()` live on the `Codey` class, NOT on `ConfigManager`. Add this accessor near ConfigManager's other simple getters (e.g. after `getAgentModel()` at `config.ts:331`):

```typescript
  getSkillsConfig(): {
    enabled: boolean; suggestOnRepeat: number; autoApply: boolean;
    staleDays: number; weakSkillDays: number; distillModel: string | undefined;
  } {
    const raw = this.config.skills;
    return {
      enabled: raw?.enabled ?? true,
      suggestOnRepeat: raw?.suggestOnRepeat ?? 2,
      autoApply: raw?.autoApply ?? true,
      staleDays: raw?.staleDays ?? 30,
      weakSkillDays: raw?.weakSkillDays ?? 7,
      distillModel: raw?.distillModel,
    };
  }
```

- [ ] **Step 4: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/gateway -w packages/core 2>&1
```
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config.ts
git commit -m "feat(skills): add skills config block to gateway.json schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Persisted per-chat pending suggestion (Chat type + ChatManager)

**Files:**
- Modify: `packages/core/src/types/chat.ts`
- Modify: `packages/gateway/src/chats.ts`

Pending suggestions must survive restarts and be scoped per-chat (a global gateway field would let chat B's next message consume chat A's suggestion). This mirrors `pendingTeam` (`chat.ts:111`, `chats.ts:270`).

- [ ] **Step 1: Add the field to the Chat interface**

In `packages/core/src/types/chat.ts`, after `lastAskedOptions?` (line 121), add:

```typescript
  /** Set when the skill distiller has proposed a new skill and is waiting for
   *  the user's "yes" / "no" / "rename <name>" reply. Cleared on any resolution. */
  pendingSkillSuggestion?: {
    name: string;
    description: string;
    whenToUse: string;
    steps: string;
  };
```

- [ ] **Step 2: Add the ChatManager setter**

In `packages/gateway/src/chats.ts`, after `setPendingTeam` (line 270), add:

```typescript
  /** Set or clear the pending skill suggestion for a chat. Pass null to clear. */
  setPendingSkillSuggestion(
    chatId: string,
    pending: NonNullable<Chat['pendingSkillSuggestion']> | null,
  ): void {
    const chat = this.cache.get(chatId);
    if (!chat) return;
    if (pending) chat.pendingSkillSuggestion = pending;
    else delete chat.pendingSkillSuggestion;
    chat.updatedAt = Date.now();
    this.persist(chat);
  }
```

- [ ] **Step 3: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/core -w packages/gateway 2>&1
```
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/chat.ts packages/gateway/src/chats.ts
git commit -m "feat(skills): persisted per-chat pendingSkillSuggestion state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Gateway — skill commands + shared helpers

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

Command surface notes (verified against the code):
- Bare `/skills` needs NO parseCommand change — the generic fallback at `gateway.ts:3459` (`/^\/(\w+)(?:\s+(.*))?$/`) already yields `{command: 'skills'}`. Only a `handleCommand` case is needed.
- `/skill forget|restore|rollback <name>` get an explicit regex in `parseCommand` (like `/worker` at `gateway.ts:3467`).
- `/skill <name> <task>` (explicit invocation, per spec) is a *prompt rewrite*, handled in Task 11/12 at each surface's entry point — not a handleCommand case, so it flows through the normal run path on both surfaces.
- There is NO `/skill create` command — the spec's creation flow is suggestion + yes/no/rename only.

- [ ] **Step 1: Add imports**

At the top of `packages/gateway/src/gateway.ts`, extend the `@codey/core` import block with:

```typescript
import {
  SkillEntry, SkillMatch, RunTrace, DistillDeps, DistillResult,
  matchSkill, confirmMatch, applySkill, distillCandidate, evolveSkill,
} from '@codey/core';
```

(Merge into the existing `@codey/core` import statement rather than adding a duplicate import.)

- [ ] **Step 2: Add fields and constants to the Codey class**

Near the other `private` fields:

```typescript
  /** Pending skill suggestions for the channel surface, keyed `${channel}:${chatId}`.
   *  (Chat-surface suggestions are persisted on the Chat via ChatManager instead.) */
  private pendingSkillSuggestions = new Map<string, DistillResult>();
  private skillRunCounter = 0;
  private lastSkillDistillTime = 0;
  private static SKILL_DISTILL_COOLDOWN_MS = 300_000; // 5 min
  private static SKILL_GC_EVERY_N_RUNS = 20;
  private static SKILL_EVOLVE_EVERY_N_USES = 3;
```

- [ ] **Step 3: Add parseCommand regex for skill subcommands**

In `parseCommand()` (`gateway.ts:3457`), inside the `if (commandMatch)` block, before the `/worker` match (`gateway.ts:3467`):

```typescript
      // /skill forget|restore|rollback <name>
      const skillSubMatch = text.match(/^\/skill\s+(forget|restore|rollback)\s+(\S+)/i);
      if (skillSubMatch) {
        return {
          command: `skill-${skillSubMatch[1].toLowerCase()}`,
          args: [skillSubMatch[2]],
          agent: undefined as any, model: undefined, prompt: '',
        };
      }
```

- [ ] **Step 4: Add handleCommand cases**

In the `handleCommand` switch (`gateway.ts:1306`):

```typescript
      case 'skills':
        await this.cmdSkills(message.chatId, message.channel);
        break;
      case 'skill-forget': {
        const ok = this.workspaceManager.getSkillStore().archive(args[0]);
        await this.sendResponse({ chatId: message.chatId, channel: message.channel,
          text: ok ? `🗑️ Skill **${args[0]}** archived. Restore with /skill restore ${args[0]}` : `Skill "${args[0]}" not found.` });
        break;
      }
      case 'skill-restore': {
        const ok = this.workspaceManager.getSkillStore().restore(args[0]);
        await this.sendResponse({ chatId: message.chatId, channel: message.channel,
          text: ok ? `🔄 Skill **${args[0]}** restored.` : `Skill "${args[0]}" not found.` });
        break;
      }
      case 'skill-rollback': {
        const store = this.workspaceManager.getSkillStore();
        const ok = store.rollback(args[0]);
        const v = store.get(args[0])?.version;
        await this.sendResponse({ chatId: message.chatId, channel: message.channel,
          text: ok ? `⏪ Skill **${args[0]}** rolled back to v${v}.` : `Skill "${args[0]}" has no prior version (or was not found).` });
        break;
      }
```

(Adjust `message.chatId`/`message.channel` to however the surrounding cases access the chat id and channel — follow the neighboring case code exactly.)

- [ ] **Step 5: Implement cmdSkills helper**

Add to the `Codey` class:

```typescript
  private async cmdSkills(chatId: string, channel: ChannelType): Promise<void> {
    const active = this.workspaceManager.getSkillStore().getActive();
    if (active.length === 0) {
      await this.sendResponse({ chatId, channel, text: 'No active skills. Skills crystallize from repeated work patterns.' });
      return;
    }
    const lines = active.map(s =>
      `- **${s.name}** (v${s.version}): ${s.description} — used ${s.useCount}×, last ${Codey.relativeTime(s.lastUsedAt)}`
    );
    await this.sendResponse({ chatId, channel, text: `📋 **Skills** (${active.length})\n\n${lines.join('\n')}` });
  }
```

- [ ] **Step 6: Add relativeTime static helper**

```typescript
  private static relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
```

- [ ] **Step 7: Add getSkillDistillDeps helper**

```typescript
  private getSkillDistillDeps(): DistillDeps {
    const { agent, model } = this.getAdvisorAgentAndModel();
    const cfg = this.configManager.getSkillsConfig();
    let resolved = model ?? this.getDefaultModelConfig(agent);
    if (cfg.distillModel && resolved) {
      resolved = { ...resolved, model: cfg.distillModel };
    }
    return {
      agentFactory: this.agentFactory,
      activeAgent: agent,
      activeModel: resolved,
      workingDir: this.workingDir,
    };
  }
```

- [ ] **Step 8: Add the shared post-run pass**

This one method serves both surfaces (channel + chat). It is only ever called fire-and-forget (`void this.afterRunSkillPass(...).catch(...)`) AFTER the user's response has been delivered, so its LLM calls (evolve, distill) never block a run — as the spec requires. GC runs on the 1st post-run pass after startup and every Nth run after (covers the spec's "on workspace load and after every Nth run" without an init-ordering dependency).

```typescript
  private async afterRunSkillPass(opts: {
    trace: RunTrace;
    appliedSkill: SkillEntry | null;
    clean: boolean;
    /** Deliver a one-liner to the user on whatever surface ran the turn. */
    notify: (text: string) => void | Promise<void>;
    /** Stash a suggestion so the user's next reply can resolve it. */
    setPending: (s: DistillResult) => void;
  }): Promise<void> {
    const cfg = this.configManager.getSkillsConfig();
    if (!cfg.enabled) return;
    const store = this.workspaceManager.getSkillStore();

    if (opts.appliedSkill) {
      store.recordUse(opts.appliedSkill.name);
      store.recordSuccessSignal(opts.appliedSkill.name, opts.clean);
      const entry = store.get(opts.appliedSkill.name);
      // Gate evolution to every Nth use — one weak trace is not enough signal
      // to rewrite steps on, and per-run LLM calls would be pure cost.
      if (opts.clean && entry && entry.useCount % Codey.SKILL_EVOLVE_EVERY_N_USES === 0) {
        const evolved = await evolveSkill(this.getSkillDistillDeps(), entry, opts.trace);
        if (evolved) {
          store.bumpVersion(entry.name, evolved);
          this.logger.info(`[skills] evolved ${entry.name} → v${entry.version}`);
          await opts.notify(`⚙︎ evolved skill ${entry.name} → v${entry.version} (rollback with /skill rollback ${entry.name})`);
        }
      }
    }

    if (!opts.clean) return; // failed runs contribute a correction signal, not a trace

    store.recordTrace(opts.trace);

    this.skillRunCounter++;
    if (this.skillRunCounter % Codey.SKILL_GC_EVERY_N_RUNS === 1) {
      const n = store.runCollectGarbage({ staleDays: cfg.staleDays, weakSkillDays: cfg.weakSkillDays });
      if (n > 0) this.logger.info(`[skills] GC archived ${n} skill(s)`);
    }

    const now = Date.now();
    if (now - this.lastSkillDistillTime > Codey.SKILL_DISTILL_COOLDOWN_MS) {
      this.lastSkillDistillTime = now;
      const recent = store.getRecentTraces(cfg.suggestOnRepeat + 5);
      const candidate = await distillCandidate(
        this.getSkillDistillDeps(), recent, store.getAll(), store.getRejected(), cfg.suggestOnRepeat,
      );
      if (candidate) {
        opts.setPending(candidate);
        await opts.notify(
          `🧩 I've done something like this repeatedly ("${candidate.description}"). ` +
          `Save it as a reusable skill **${candidate.name}**? (reply "yes", "no", or "rename <new-name>")`
        );
      }
    }
  }
```

- [ ] **Step 9: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/gateway -w packages/core 2>&1
```
Expected: Build succeeds.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(skills): skill commands + shared afterRunSkillPass in gateway

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Gateway — channel surface (handleMessage / runOneTurn)

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Handle suggestion replies + explicit invocation in handleMessage**

In `handleMessage()` (`gateway.ts:934`), after the `lastAskedOptions` clearing block (~line 978) and *before* the pending team check (~line 980), add:

```typescript
      // ── Pending skill suggestion (channel surface) ──────────
      const pendingKey = `${message.channel}:${message.chatId}`;
      const pendingSkill = this.pendingSkillSuggestions.get(pendingKey);
      if (pendingSkill) {
        const reply = message.text.trim().toLowerCase();
        const renameMatch = reply.match(/^rename\s+([a-z][a-z0-9-]{2,29})$/);
        if (reply === 'yes' || renameMatch) {
          const name = renameMatch ? renameMatch[1] : pendingSkill.name;
          this.workspaceManager.getSkillStore().add({
            name, description: pendingSkill.description,
            whenToUse: pendingSkill.whenToUse, steps: pendingSkill.steps,
            sourceRunId: 'user-confirmed',
          });
          this.pendingSkillSuggestions.delete(pendingKey);
          await this.sendResponse({ chatId: message.chatId, channel: message.channel,
            text: `✅ Skill **${name}** saved! Use \`/skills\` to see all.` });
          return;
        }
        if (reply === 'no') {
          this.workspaceManager.getSkillStore().rejectSuggestion(pendingSkill.name, pendingSkill.description);
          this.pendingSkillSuggestions.delete(pendingKey);
          await this.sendResponse({ chatId: message.chatId, channel: message.channel,
            text: `Got it — I won't suggest "${pendingSkill.name}" again.` });
          return;
        }
        // Any other reply: drop the suggestion and fall through to normal handling.
        this.pendingSkillSuggestions.delete(pendingKey);
      }

      // ── Explicit skill invocation: /skill <name> <task> ─────
      // Rewrites the message into the skill-applied prompt and proceeds as a
      // normal (non-command) turn. Subcommands are excluded — parseCommand
      // handles those.
      const invokeMatch = message.text.match(/^\/skill\s+(?!forget\b|restore\b|rollback\b)(\S+)\s+([\s\S]+)/i);
      if (invokeMatch) {
        const skill = this.workspaceManager.getSkillStore().getActive()
          .find(s => s.name === invokeMatch[1]);
        if (!skill) {
          await this.sendResponse({ chatId: message.chatId, channel: message.channel,
            text: `Skill "${invokeMatch[1]}" not found. Use /skills to list active skills.` });
          return;
        }
        message.text = applySkill(invokeMatch[2].trim(), skill);
      }
```

(Adjust `message.chatId`/`message.channel` access to match the surrounding code's shape exactly.)

- [ ] **Step 2: Pre-run skill matching in runOneTurn**

In `runOneTurn()`, replace the line `let prep = this.prepareAgentTurn(ctxWindow, agent, parsed.prompt, memoryContext);` (`gateway.ts:1123`) with:

```typescript
    // ── Skill matching (pre-run) ──────────────────────────
    // high-confidence match → apply directly; borderline → LLM confirm gate.
    let appliedSkill: SkillEntry | null = null;
    const skillsCfg = this.configManager.getSkillsConfig();
    let runPrompt = parsed.prompt;
    if (skillsCfg.enabled && skillsCfg.autoApply && runPrompt.trim()) {
      const match = matchSkill(runPrompt, this.workspaceManager.getSkillStore().getActive());
      if (match) {
        const confirmed = match.confidence === 'high'
          || await confirmMatch(this.getSkillDistillDeps(), runPrompt, match.skill);
        if (confirmed) {
          appliedSkill = match.skill;
          runPrompt = applySkill(runPrompt, match.skill);
          this.logger.info(`[skills] auto-applied: ${match.skill.name} v${match.skill.version} (${match.confidence})`);
        }
      }
    }

    let prep = this.prepareAgentTurn(ctxWindow, agent, runPrompt, memoryContext);
```

IMPORTANT: there is a retry call to `prepareAgentTurn` at ~`gateway.ts:1145` — update it to pass `runPrompt` as well, so the retry doesn't silently drop the applied skill. The later bookkeeping uses of `parsed.prompt` (`addUserTurn` at 1153, `extractFromInteraction` at 1161) must KEEP using `parsed.prompt` — the user's original text is what belongs in context and memory.

- [ ] **Step 3: Post-run pass — AFTER the response is sent, fire-and-forget**

In `runOneTurn()`, after the `sendResponse(...)` call (`gateway.ts:1182`) — NOT before it — add:

```typescript
    // ── Skills: post-run pass (fire-and-forget — never blocks the reply) ──
    if (skillsCfg.enabled) {
      const trace: RunTrace = {
        runId: `solo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        promptSummary: parsed.prompt.slice(0, 200),
        outputPreview: (response.output || '').slice(0, 300),
        timestamp: Date.now(),
        mode: 'solo',
      };
      void this.afterRunSkillPass({
        trace,
        appliedSkill,
        clean: response.success,
        notify: (text) => this.sendResponse({ chatId: message.chatId, channel: message.channel, text }),
        setPending: (s) => this.pendingSkillSuggestions.set(`${message.channel}:${message.chatId}`, s),
      }).catch(err => this.logger.warn(`[skills] post-run pass failed: ${err}`));
    }
```

(Use whatever locals `runOneTurn` already has for the chat id and channel — the same ones the `sendResponse` at 1182 uses.)

- [ ] **Step 4: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/gateway -w packages/core 2>&1
```
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(skills): channel-surface skill flow (suggest, invoke, apply, post-run)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Gateway — Chat/Mac surface (sendToChat)

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

Mac messages enter through `sendToChat` directly (IPC `chats:send` → `inProcessGateway.sendToChat`, `codey-mac/electron/main.ts:2494-2505`); channel messages with a linked chat are routed here too (`gateway.ts:1227`). So this surface needs its own suggestion-reply handling — `handleMessage` never sees these turns. `sendToChat` does not parse slash commands, so command-style management (`/skills`, `/skill forget`, …) remains channel-only for v1; the Mac app's natural surface for that is a Skills panel (follow-up, see YAGNI).

- [ ] **Step 1: Handle suggestion replies early in sendToChat**

In `sendToChat()`, after the `sink` wrapper definition (`gateway.ts:~4023`) and BEFORE the semaphore-acquire block (`gateway.ts:~4025`), add:

```typescript
    // ── Pending skill suggestion (yes / no / rename <name>) ─────────
    // Resolved here because Mac turns never pass through handleMessage.
    if (chat.pendingSkillSuggestion && !isSlashTurn) {
      const s = chat.pendingSkillSuggestion;
      const reply = userText.trim().toLowerCase();
      const renameMatch = reply.match(/^rename\s+([a-z][a-z0-9-]{2,29})$/);
      if (reply === 'yes' || reply === 'no' || renameMatch) {
        const store = this.workspaceManager.getSkillStore();
        let responseText: string;
        if (reply === 'no') {
          store.rejectSuggestion(s.name, s.description);
          responseText = `Got it — I won't suggest "${s.name}" again.`;
        } else {
          const name = renameMatch ? renameMatch[1] : s.name;
          store.add({ name, description: s.description, whenToUse: s.whenToUse,
                      steps: s.steps, sourceRunId: 'user-confirmed' });
          responseText = `✅ Skill **${name}** saved. It will be auto-applied on matching tasks.`;
        }
        this.chatManager.setPendingSkillSuggestion(chatId, null);
        const now = Date.now();
        this.chatManager.appendMessage(chatId, {
          id: randomUUID(), role: 'user', content: userTextParam, timestamp: now,
        });
        this.chatManager.appendMessage(chatId, {
          id: randomUUID(), role: 'assistant', content: responseText,
          timestamp: now, isComplete: true,
        });
        sink({ type: 'done', chatId, response: responseText });
        return { response: responseText, chatId };
      }
      // Any other reply: drop the suggestion and continue as a normal turn.
      this.chatManager.setPendingSkillSuggestion(chatId, null);
    }

    // ── Explicit skill invocation: /skill <name> <task> ─────────────
    const skillInvokeMatch = userText.match(/^\/skill\s+(?!forget\b|restore\b|rollback\b)(\S+)\s+([\s\S]+)/i);
    let appliedChatSkill: SkillEntry | null = null;
    if (skillInvokeMatch) {
      const skill = this.workspaceManager.getSkillStore().getActive()
        .find(sk => sk.name === skillInvokeMatch[1]);
      if (skill) {
        appliedChatSkill = skill;
        userText = applySkill(skillInvokeMatch[2].trim(), skill);
      }
    }
```

Match the `done` event's field shape to the existing `sink({ type: 'done', ... })` at `gateway.ts:4406` (include any additional required fields it carries). `randomUUID` is already imported in gateway.ts (used for toolCalls entries).

- [ ] **Step 2: Auto-apply pre-run**

Deeper in `sendToChat`, after the solo-advisor injection block (~`gateway.ts:4113`, where `prompt` has been assigned for the solo path), add:

```typescript
    // ── Skill matching (pre-run, solo chats only) ─────────────
    const skillsCfg = this.configManager.getSkillsConfig();
    if (skillsCfg.enabled && skillsCfg.autoApply && !appliedChatSkill
        && chat.selection.type !== 'team' && !isSlashTurn) {
      const match = matchSkill(userText, this.workspaceManager.getSkillStore().getActive());
      if (match) {
        const confirmed = match.confidence === 'high'
          || await confirmMatch(this.getSkillDistillDeps(), userText, match.skill);
        if (confirmed) {
          appliedChatSkill = match.skill;
          prompt = applySkill(prompt, match.skill);
          this.logger.info(`[skills] auto-applied (chat): ${match.skill.name} v${match.skill.version} (${match.confidence})`);
        }
      }
    }
```

- [ ] **Step 3: Post-run pass after the done event**

After the `sink({ type: 'done', ... })` call (`gateway.ts:~4406`), add:

```typescript
      // ── Skills: post-run pass (fire-and-forget, response already delivered) ──
      if (skillsCfg.enabled && output) {
        const chatTrace: RunTrace = {
          runId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          promptSummary: userText.slice(0, 200),
          outputPreview: output.slice(0, 300),
          workerSequence: teamThinkingByStep
            ? teamThinkingByStep.map((st: any) => st.worker || st.name || '').filter(Boolean)
            : undefined,
          timestamp: Date.now(),
          mode: teamTurnId ? 'team-sequential' : 'solo',
        };
        void this.afterRunSkillPass({
          trace: chatTrace,
          appliedSkill: appliedChatSkill,
          clean: true,
          notify: (text) => { sink({ type: 'info', chatId, message: text }); },
          setPending: (s) => { this.chatManager.setPendingSkillSuggestion(chatId, s); },
        }).catch(err => this.logger.warn(`[skills] post-run pass failed: ${err}`));
      }
```

(`info` events already flow to the Mac renderer via the global chat event listener — see `onStatus` at `gateway.ts:4159` — and are captured into `toolCalls` for persistence by the sink wrapper.)

- [ ] **Step 4: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/gateway -w packages/core 2>&1
```
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(skills): chat/Mac-surface skill flow in sendToChat

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Full test suite verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test 2>&1 | tail -30
```
Expected: All tests PASS (~38 skill-crystallizer + existing core/gateway/codey-mac suites).

- [ ] **Step 2: Verify full build + lint**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build 2>&1 && npm run lint 2>&1
```
Expected: Build succeeds; lint passes (emoji and `⚙︎` are pictographs, not flagged by `scripts/check-non-english.mjs`).

- [ ] **Step 3: Manual smoke test (optional)**

Start gateway: `npm run dev`
1. Send `/skills` on a channel → expect "No active skills."
2. Run two similar tasks → after the second (cooldown permitting), expect the 🧩 suggestion.
3. Reply `rename my-skill` → expect skill saved under the new name.
4. Run a similar task → expect auto-apply logged, and on borderline matches a confirm call first.
5. `/skill forget my-skill` → archived; `/skill restore my-skill` → back.
6. Restart the gateway, run one task → traces from before the restart still count toward detection (check `workspaces/<name>/skills/traces.json` exists).
7. On the Mac app: trigger a suggestion, reply "no" → suggestion resolved in-chat, and the same pattern is not re-suggested (it's in `index.json` → `rejected`).

---

## Spec Coverage Checklist

| Spec requirement | Task(s) |
|-----------------|---------|
| Skill store: `skills/index.json` + `skills/traces.json` (spec amended, Task 0) | Task 0, 1, 2 |
| Run trace recorder, persisted across restarts | Task 1, 2, 11, 12 |
| Distiller — LLM-based pattern detection | Task 3 |
| Suggested creation with yes / no / **rename** | Task 10, 11 (channel), 12 (chat/Mac) |
| "no" suppression (rejected list fed back to distiller) | Task 1, 3, 11, 12 |
| Auto-apply on match: cheap pre-filter → LLM confirm on borderline | Task 4, 11, 12 |
| Application never blocks the run (post-run work is fire-and-forget after delivery) | Task 10 (`afterRunSkillPass`), 11, 12 |
| Self-evolution on use, gated to every Nth use, one-liner surfaced | Task 5, 10 |
| Version history retained + rollback (`/skill rollback`) | Task 1, 2, 10 |
| successSignals (cleanRuns / corrections) recorded per applied run | Task 10 (both surfaces via shared pass) |
| GC — on first run after startup + every Nth run; stale + weak rules | Task 1, 2, 10 |
| Config block (suggestOnRepeat, staleDays, distillModel, …) | Task 8 |
| `/skills`, `/skill <name> <task>`, `/skill forget`, `/skill restore` | Task 10, 11 (invoke also on chat: Task 12) |
| Workspace-scoped, survives workspace switching | Task 7 (WorkspaceManager ownership) |
| Solo path (runOneTurn) hooks | Task 11 |
| Chat/Mac path (sendToChat) hooks, incl. suggestion replies | Task 9, 12 |

## Known v1 limitations (deliberate)

- **Correction signal is coarse:** `corrections` increments only when an applied run fails (`clean: false`). Detecting "user re-asked / corrected afterward" requires cross-turn analysis — follow-up.
- **`outputPreview` is a raw prefix** of the response, not a structural analysis of files touched. The field is named honestly so the distill/evolve prompts don't overclaim.
- **The applied-skill banner lives in the prompt**, so the user sees it via the agent's behavior and the `[skills] auto-applied` log / evolve one-liners, not as a guaranteed prefix on every response. Surfacing a dedicated "using skill" chip in the Mac UI is a follow-up.

## Out of Scope (explicit YAGNI)

- Embeddings-based similarity (LLM distiller is sufficient for current scale).
- Cross-workspace / global skills (workspace-scoped only).
- Sharing/exporting skills between users.
- Per-skill `.md` files and `skills/archived/` subdirectory — archived skills stay in `index.json` with `archived: true` (spec amended in Task 0 to match).
- Mac UI for skill management (Skills panel, "using skill" chip) — `sendToChat` doesn't parse slash commands, so management commands are channel-only for v1; suggestions/replies work everywhere.
