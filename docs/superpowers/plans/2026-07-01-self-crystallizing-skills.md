# Self-Crystallizing Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a workspace-scoped skill crystallizer that detects recurring sub-processes across runs, suggests reusable skills, auto-applies them on future tasks, self-evolves on use, and archives when stale.

**Architecture:** A new `SkillStore` class in `packages/core` mirrors the `MemoryStore` pattern (`index.json` + individual `.md` files per workspace). An LLM-based distiller (reuses Advisor's `{agent, model}` config, like `judge.ts`) compares recent run traces to find repeating sub-processes. A cheap keyword pre-filter (`matchSkill`) runs before every task; a secondary LLM gate (`confirmMatch`) is available for borderline cases. The gateway wires the store in at run start/complete for the solo path (`runOneTurn`) and team/Chat path (`sendToChat`).

**Tech Stack:** TypeScript (strict), existing `AgentFactory.run()` for LLM calls, Vitest for tests.

---

## File Map

| File | Responsibility |
|------|---------------|
| `packages/core/src/skill-crystallizer.ts` (new) | `SkillStore` (CRUD, manifest, GC, traces), `distillCandidate()`, `matchSkill()`, `confirmMatch()`, `applySkill()`, `evolveSkill()` |
| `packages/core/src/skill-crystallizer.test.ts` (new) | Unit tests for store + all standalone functions |
| `packages/core/src/index.ts` | Add `export * from './skill-crystallizer'` |
| `packages/gateway/src/config.ts` | `skills?` block on `GatewayConfigJson`, `normalize()`, `getSkillsConfig()` accessor |
| `packages/gateway/src/gateway.ts` | SkillStore lifecycle, pre-run injection, post-run trace + distillation, suggestion handling, `/skill` + `/skills` commands |

---

### Task 1: Define types and stubs

**Files:**
- Create: `packages/core/src/skill-crystallizer.ts`

- [ ] **Step 1: Create the file with types and empty function stubs**

```typescript
// packages/core/src/skill-crystallizer.ts
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse: string;
  steps: string;
  version: number;
  useCount: number;
  lastUsedAt: number;
  successSignals: { cleanRuns: number; corrections: number };
  sourceRunIds: string[];
  createdAt: number;
  archived: boolean;
}

export interface SkillIndex {
  version: 1;
  entries: SkillEntry[];
}

export interface RunTrace {
  runId: string;
  promptSummary: string;
  outputShape: string;
  workerSequence?: string[];
  timestamp: number;
  mode: 'solo' | 'team-sequential' | 'team-parallel' | 'team-auto';
}

export interface DistillDeps {
  agentFactory: any;
  activeAgent: any;
  activeModel: any;
  workingDir: string;
}

export interface DistillResult {
  name: string;
  description: string;
  whenToUse: string;
  steps: string;
}

export const RECENT_TRACES_MAX = 20;

// ── SkillStore ─────────────────────────────────────────────────────

export class SkillStore {
  private workspacePath: string;
  private skillsDir: string;
  private indexPath: string;
  private index: SkillIndex = { version: 1, entries: [] };
  private writeChain: Promise<void> = Promise.resolve();
  private indexDirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private static FLUSH_DEBOUNCE_MS = 50;
  private runTraces: RunTrace[] = [];

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.skillsDir = path.join(workspacePath, 'skills');
    this.indexPath = path.join(this.skillsDir, 'index.json');
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        const parsed = JSON.parse(data) as SkillIndex;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
          this.index = parsed;
        }
      } catch {
        this.index = { version: 1, entries: [] };
      }
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
      existing.description = params.description;
      existing.whenToUse = params.whenToUse;
      existing.steps = params.steps;
      if (params.sourceRunId && !existing.sourceRunIds.includes(params.sourceRunId)) {
        existing.sourceRunIds.push(params.sourceRunId);
      }
      this.markDirty();
      return existing;
    }
    const entry: SkillEntry = {
      name: params.name,
      description: params.description,
      whenToUse: params.whenToUse,
      steps: params.steps,
      version: 1,
      useCount: 0,
      lastUsedAt: now,
      successSignals: { cleanRuns: 0, corrections: 0 },
      sourceRunIds: params.sourceRunId ? [params.sourceRunId] : [],
      createdAt: now,
      archived: false,
    };
    this.index.entries.push(entry);
    this.markDirty();
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
    this.markDirty();
    return true;
  }

  restore(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.archived = false;
    this.markDirty();
    return true;
  }

  recordUse(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.useCount++;
    entry.lastUsedAt = Date.now();
    this.markDirty();
    return true;
  }

  recordSuccessSignal(name: string, clean: boolean): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    if (clean) entry.successSignals.cleanRuns++;
    else entry.successSignals.corrections++;
    this.markDirty();
    return true;
  }

  bumpVersion(name: string, newSteps: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.version++;
    entry.steps = newSteps;
    this.markDirty();
    return true;
  }

  // ── Traces ───────────────────────────────────────────────────

  recordTrace(trace: RunTrace): void {
    this.runTraces.unshift(trace);
    if (this.runTraces.length > RECENT_TRACES_MAX) {
      this.runTraces = this.runTraces.slice(0, RECENT_TRACES_MAX);
    }
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
      if (entry.useCount < 2 && now - entry.createdAt > opts.weakSkillDays * 86_400_000) {
        entry.archived = true;
        archived++;
      }
    }
    if (archived > 0) this.markDirty();
    return archived;
  }

  // ── Persistence ──────────────────────────────────────────────

  private markDirty(): void {
    this.indexDirty = true;
    this.scheduleFlush();
  }

  private enqueuePersist(): void {
    this.writeChain = this.writeChain.then(() => this.doPersist()).catch(() => {});
  }

  private async doPersist(): Promise<void> {
    if (!this.indexDirty) return;
    const payload = JSON.stringify(this.index, null, 2);
    this.indexDirty = false;
    try {
      await fsp.mkdir(this.skillsDir, { recursive: true });
      await atomicWrite(this.indexPath, payload);
    } catch {
      this.indexDirty = true;
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
  _deps: DistillDeps, _traces: RunTrace[], _existing: SkillEntry[], _minRecurrence: number,
): Promise<DistillResult | null> { return null; }

export function matchSkill(_task: string, _skills: SkillEntry[]): SkillEntry | null { return null; }

export async function confirmMatch(
  _deps: DistillDeps, _task: string, _skill: SkillEntry,
): Promise<boolean> { return false; }

export function applySkill(task: string, skill: SkillEntry): string { return task; }

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
git commit -m "feat(skills): SkillStore types, CRUD, traces, GC, and function stubs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
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
import { SkillStore, RECENT_TRACES_MAX } from './skill-crystallizer';

describe('SkillStore', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skills-test-'));
    store = new SkillStore(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds a skill and persists to index.json', async () => {
    await store.load();
    const entry = store.add({
      name: 'release-notes',
      description: 'Draft release notes from merged PRs',
      whenToUse: 'user asks for release notes or changelog',
      steps: '1. fetch merged PRs\n2. group by type\n3. format output',
      sourceRunId: 'run_001',
    });
    expect(entry.name).toBe('release-notes');
    expect(entry.version).toBe(1);
    expect(entry.archived).toBe(false);
    expect(entry.useCount).toBe(0);
    await store.flush();
    const indexPath = path.join(tmp, 'skills', 'index.json');
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(raw.entries.length).toBe(1);
    expect(raw.entries[0].name).toBe('release-notes');
  });

  it('loads existing skills from disk', async () => {
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
  });

  it('add() on existing name updates in place', async () => {
    await store.load();
    store.add({ name: 'test', description: 'first', whenToUse: 'w', steps: 's' });
    store.add({ name: 'test', description: 'second', whenToUse: 'w2', steps: 's2' });
    expect(store.getAll().length).toBe(1);
    expect(store.get('test')!.description).toBe('second');
  });

  it('archive() and restore()', async () => {
    await store.load();
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

  it('bumpVersion increments version and updates steps', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 'old' });
    expect(store.bumpVersion('test', 'new')).toBe(true);
    const u = store.get('test')!;
    expect(u.version).toBe(2);
    expect(u.steps).toBe('new');
  });

  it('recordTrace stores traces and caps at RECENT_TRACES_MAX', () => {
    for (let i = 0; i < RECENT_TRACES_MAX + 5; i++) {
      store.recordTrace({
        runId: `run_${i}`, promptSummary: 'task', outputShape: 'text',
        timestamp: Date.now() - i * 60000, mode: 'solo',
      });
    }
    const recent = store.getRecentTraces(100);
    expect(recent.length).toBe(RECENT_TRACES_MAX);
    expect(recent[0].runId).toBe(`run_${RECENT_TRACES_MAX + 4}`);
  });

  it('getRecentTraces returns most recent first', () => {
    store.recordTrace({ runId: 'older', promptSummary: 'o', outputShape: 't', timestamp: 1000, mode: 'solo' });
    store.recordTrace({ runId: 'newer', promptSummary: 'n', outputShape: 't', timestamp: 2000, mode: 'solo' });
    expect(store.getRecentTraces(10)[0].runId).toBe('newer');
  });

  it('runCollectGarbage archives stale and weak skills', () => {
    store.load();
    const old = Date.now() - 31 * 86_400_000;
    const s1 = store.add({ name: 'old', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r1' });
    s1.lastUsedAt = old;
    const s2 = store.add({ name: 'weak', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r2' });
    s2.createdAt = old;
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
Expected: 10 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/skill-crystallizer.test.ts
git commit -m "test(skills): SkillStore CRUD, traces, and GC tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Distill candidate skills (LLM)

**Files:**
- Modify: `packages/core/src/skill-crystallizer.ts` — replace `distillCandidate` stub
- Modify: `packages/core/src/skill-crystallizer.test.ts` — add distill tests

- [ ] **Step 1: Add distill tests**

Append to `packages/core/src/skill-crystallizer.test.ts`:

```typescript
import { distillCandidate, RunTrace } from './skill-crystallizer';

describe('distillCandidate', () => {
  it('returns null for empty traces', async () => {
    const result = await distillCandidate(null as any, [], [], 2);
    expect(result).toBeNull();
  });

  it('returns null when fewer traces than minRecurrence', async () => {
    const result = await distillCandidate(null as any,
      [{ runId: '1', promptSummary: 'x', outputShape: 'y', timestamp: 0, mode: 'solo' }],
      [], 2);
    expect(result).toBeNull();
  });

  it('calls agent with traces and parses JSON result', async () => {
    let calledPrompt = '';
    const deps = {
      activeAgent: 'claude-code' as any,
      activeModel: { model: 'test' } as any,
      workingDir: '/tmp',
      agentFactory: {
        run: async (_agent: any, req: any) => {
          calledPrompt = req.prompt;
          return { success: true, output: JSON.stringify({
            name: 'release-notes',
            description: 'Generate release notes from merged PRs',
            whenToUse: 'user asks for release notes or changelog',
            steps: '1. fetch PRs\n2. group by type\n3. format with links',
          }), error: null, tokens: { total: 100 } } as any;
        },
      },
    };
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'Draft release notes', outputShape: 'markdown list', timestamp: 1, mode: 'solo' },
      { runId: '2', promptSummary: 'Generate changelog', outputShape: 'markdown list', timestamp: 2, mode: 'solo' },
      { runId: '3', promptSummary: 'Write release announcement', outputShape: 'markdown list', timestamp: 3, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], 2);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('release-notes');
    expect(result!.steps).toContain('fetch PRs');
    expect(calledPrompt).toContain('Draft release notes');
    expect(calledPrompt).toContain('release announcement');
  });

  it('returns null on "NONE" response', async () => {
    const deps = {
      activeAgent: 'claude-code' as any, activeModel: { model: 'test' } as any,
      workingDir: '/tmp',
      agentFactory: { run: async () => ({ success: true, output: 'NONE', error: null, tokens: { total: 10 } } as any) },
    };
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputShape: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputShape: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], 2);
    expect(result).toBeNull();
  });

  it('returns null on unparseable output', async () => {
    const deps = {
      activeAgent: 'claude-code' as any, activeModel: { model: 'test' } as any,
      workingDir: '/tmp',
      agentFactory: { run: async () => ({ success: true, output: 'garbage', error: null, tokens: { total: 10 } } as any) },
    };
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputShape: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputShape: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], 2);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```
Expected: distill tests FAIL (stubs return null).

- [ ] **Step 3: Implement distillCandidate**

Replace the `distillCandidate` stub in `packages/core/src/skill-crystallizer.ts`:

```typescript
const DISTILL_PROMPT = `You analyze coding-agent runs to find recurring work patterns.

Given these recent run traces and existing skills, identify a repeatable sub-process that appears in 2+ runs. If you find one, describe it as a reusable skill. If none, return exactly "NONE".

Recent traces:
%TRACES%

Existing skills (don't duplicate):
%SKILLS%

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

function tryParseDistill(raw: string): DistillResult | null {
  const trimmed = raw.trim();
  if (trimmed === 'NONE' || trimmed === '"NONE"') return null;
  try { return JSON.parse(stripCodeFences(trimmed)); } catch { return null; }
}

export async function distillCandidate(
  deps: DistillDeps,
  traces: RunTrace[],
  existing: SkillEntry[],
  minRecurrence: number,
): Promise<DistillResult | null> {
  if (traces.length < minRecurrence) return null;

  const composed = DISTILL_PROMPT
    .replace('%TRACES%', formatTracesForPrompt(traces))
    .replace('%SKILLS%', formatSkillsForPrompt(existing.filter(s => !s.archived)));

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await deps.agentFactory.run(deps.activeAgent, {
      prompt: attempt === 0 ? composed
        : `${composed}\n\nReminder: return ONLY the JSON object or the word "NONE". No markdown.`,
      agent: deps.activeAgent,
      model: deps.activeModel,
      interactive: false,
      skipPermissions: true,
      context: { workingDir: deps.workingDir },
    });
    if (!response.success) continue;
    const parsed = tryParseDistill(response.output);
    if (parsed && parsed.name && parsed.steps) {
      if (/^[a-z][a-z0-9-]*$/.test(parsed.name) && parsed.name.length >= 3 && parsed.name.length <= 30) {
        return parsed;
      }
    }
    if (response.output.trim() === 'NONE') return null;
  }
  return null;
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```
Expected: 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts packages/core/src/skill-crystallizer.test.ts
git commit -m "feat(skills): LLM-based distillCandidate for pattern detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Skill matching (keyword + LLM)

**Files:**
- Modify: `packages/core/src/skill-crystallizer.ts` — replace `matchSkill` + `confirmMatch` stubs
- Modify: `packages/core/src/skill-crystallizer.test.ts` — add matching tests

- [ ] **Step 1: Add matching tests**

Append to test file:

```typescript
import { matchSkill, SkillEntry } from './skill-crystallizer';

describe('matchSkill', () => {
  const skills: SkillEntry[] = [
    { name: 'release-notes', description: 'Generate release notes', whenToUse: 'user asks for release notes or changelog', steps: '1. fetch\n2. group', version: 1, useCount: 3, lastUsedAt: Date.now(), successSignals: { cleanRuns: 3, corrections: 0 }, sourceRunIds: ['r1'], createdAt: Date.now(), archived: false },
    { name: 'fix-lint', description: 'Fix lint errors', whenToUse: 'user reports lint errors or ESLint failures', steps: '1. lint\n2. fix', version: 1, useCount: 1, lastUsedAt: Date.now(), successSignals: { cleanRuns: 1, corrections: 0 }, sourceRunIds: ['r2'], createdAt: Date.now(), archived: false },
    { name: 'archived-x', description: 'Hidden', whenToUse: 'anything', steps: 's', version: 1, useCount: 0, lastUsedAt: Date.now(), successSignals: { cleanRuns: 0, corrections: 0 }, sourceRunIds: [], createdAt: Date.now(), archived: true },
  ];

  it('matches release-notes for changelog task', () => {
    expect(matchSkill('write a changelog for v2.1', skills)?.name).toBe('release-notes');
  });

  it('matches release-notes for release notes task', () => {
    expect(matchSkill('generate release notes from merged PRs', skills)?.name).toBe('release-notes');
  });

  it('matches fix-lint for ESLint task', () => {
    expect(matchSkill('eslint is failing on CI, can you fix?', skills)?.name).toBe('fix-lint');
  });

  it('returns null for unrelated task', () => {
    expect(matchSkill('build a REST API for users', skills)).toBeNull();
  });

  it('never matches archived skills', () => {
    expect(matchSkill('do anything at all please', skills)).toBeNull();
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
export function matchSkill(task: string, skills: SkillEntry[]): SkillEntry | null {
  const active = skills.filter(s => !s.archived);
  if (active.length === 0) return null;
  const taskTokens = tokenizeLax(task);
  if (taskTokens.length === 0) return null;
  let best: { skill: SkillEntry; score: number } | null = null;
  for (const skill of active) {
    const searchText = `${skill.description} ${skill.whenToUse}`;
    const skillTokens = tokenizeLax(searchText);
    if (skillTokens.length === 0) continue;
    const intersection = skillTokens.filter(t => taskTokens.includes(t));
    if (intersection.length < 2) continue;
    const unionSize = new Set([...taskTokens, ...skillTokens]).size;
    const score = intersection.length / unionSize;
    if (score > 0.1 && (!best || score > best.score)) {
      best = { skill, score };
    }
  }
  return best?.skill ?? null;
}

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
  const prompt = MATCH_CONFIRM_PROMPT
    .replace('%SKILL_NAME%', skill.name)
    .replace('%SKILL_DESC%', skill.description)
    .replace('%SKILL_WHEN%', skill.whenToUse)
    .replace('%TASK%', task);
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
Expected: 19 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts packages/core/src/skill-crystallizer.test.ts
git commit -m "feat(skills): keyword pre-filter matchSkill + LLM confirmMatch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
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
  const skill: SkillEntry = {
    name: 'release-notes', description: 'Generate release notes',
    whenToUse: 'user asks for release notes',
    steps: '1. fetch merged PRs\n2. group by type\n3. format with links',
    version: 2, useCount: 3, lastUsedAt: Date.now(),
    successSignals: { cleanRuns: 3, corrections: 0 },
    sourceRunIds: ['r1'], createdAt: Date.now(), archived: false,
  };

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
  const skill: SkillEntry = {
    name: 'release-notes', description: 'Release notes',
    whenToUse: 'release notes', steps: '1. fetch PRs\n2. group',
    version: 1, useCount: 3, lastUsedAt: Date.now(),
    successSignals: { cleanRuns: 2, corrections: 1 },
    sourceRunIds: ['r1'], createdAt: Date.now(), archived: false,
  };
  const trace: RunTrace = {
    runId: 'r2', promptSummary: 'Draft release notes',
    outputShape: 'markdown with sections', timestamp: Date.now(), mode: 'solo',
  };

  it('evolves when agent finds better steps', async () => {
    const deps = {
      activeAgent: 'claude-code' as any,
      activeModel: { model: 'test' } as any,
      workingDir: '/tmp',
      agentFactory: { run: async () => ({ success: true, output: JSON.stringify({ improved: true, steps: '1. fetch\n2. group\n3. add links\n4. format' }), error: null, tokens: { total: 100 } } as any) },
    };
    const result = await evolveSkill(deps, skill, trace);
    expect(result).not.toBeNull();
    expect(result).toContain('add links');
  });

  it('returns null when no improvement needed', async () => {
    const deps = {
      activeAgent: 'claude-code' as any, activeModel: { model: 'test' } as any,
      workingDir: '/tmp',
      agentFactory: { run: async () => ({ success: true, output: JSON.stringify({ improved: false }), error: null, tokens: { total: 50 } } as any) },
    };
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });

  it('returns null on failed agent call', async () => {
    const deps = {
      activeAgent: 'claude-code' as any, activeModel: { model: 'test' } as any,
      workingDir: '/tmp',
      agentFactory: { run: async () => ({ success: false, output: '', error: 'crash', tokens: { total: 0 } } as any) },
    };
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

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
- Output shape: %OUTPUT_SHAPE%
- Mode: %MODE%
%WORKER_STEPS%

Does the run suggest a better version of the steps? If yes, return improved steps. If the current steps are fine, say no change.

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
  const composed = EVOLVE_PROMPT
    .replace('%SKILL_NAME%', skill.name)
    .replace('%SKILL_DESC%', skill.description)
    .replace('%SKILL_WHEN%', skill.whenToUse)
    .replace('%STEPS%', skill.steps)
    .replace('%TASK_SUMMARY%', trace.promptSummary)
    .replace('%OUTPUT_SHAPE%', trace.outputShape)
    .replace('%MODE%', trace.mode)
    .replace('%WORKER_STEPS%', workerPart);

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
Expected: 24 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts packages/core/src/skill-crystallizer.test.ts
git commit -m "feat(skills): applySkill prompt injection + evolveSkill refinement

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
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

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Gateway config — skills block

**Files:**
- Modify: `packages/gateway/src/config.ts`

- [ ] **Step 1: Add `skills?` to GatewayConfigJson**

In the `GatewayConfigJson` interface, add after the `aide?` block (before `teams?`):

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

In the `normalize()` function, after the `aide` block (roughly after line 556):

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

After the existing `getAideAgentAndModel()` method pattern, add:

```typescript
  getSkillsConfig(): Required<NonNullable<GatewayConfigJson['skills']>> & { distillModel: string | undefined } {
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

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Gateway — SkillStore lifecycle + /skills command

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Add imports**

At the top of `packages/gateway/src/gateway.ts`, find the `@codey/core` import block and add:

```typescript
import { SkillStore, matchSkill, applySkill, distillCandidate, evolveSkill, RunTrace, DistillDeps, DistillResult } from '@codey/core';
```

- [ ] **Step 2: Add fields to Gateway class**

Find the class property declarations (near other `private` fields) and add:

```typescript
  private skillStore!: SkillStore;
  private pendingSkillSuggestion: (DistillResult & { chatId: string; channel: ChannelType }) | null = null;
  private lastSkillDistillTime = 0;
  private static SKILL_DISTILL_COOLDOWN_MS = 300_000; // 5 min
```

- [ ] **Step 3: Initialize SkillStore in constructor/init**

Find where the gateway initializes (constructor or `init()`). After workspace is available, add:

```typescript
    this.skillStore = new SkillStore(this.workspaceManager.getWorkingDir());
```

And after workspaceManager is loaded (in an async init if one exists):

```typescript
    await this.skillStore.load();
    const skillsCfg = this.configManager.getSkillsConfig();
    if (skillsCfg.enabled) {
      this.skillStore.runCollectGarbage({
        staleDays: skillsCfg.staleDays,
        weakSkillDays: skillsCfg.weakSkillDays,
      });
    }
```

(If there is no async init, add the `load()` + GC call at the end of the constructor as a fire-and-forget:

```typescript
    this.skillStore.load().then(() => {
      const cfg = this.configManager.getSkillsConfig();
      if (cfg.enabled) this.skillStore.runCollectGarbage({ staleDays: cfg.staleDays, weakSkillDays: cfg.weakSkillDays });
    }).catch(() => {});
```

)

- [ ] **Step 4: Add /skills and /skill commands to parseCommand**

In `parseCommand()` (inside the `if (commandMatch)` block), add *before* the worker match:

```typescript
      // /skill create <name> — manually create a skill (unlikely but supported)
      // /skill forget <name> — archive a skill
      // /skill restore <name> — unarchive a skill
      // /skills — list active skills
      const skillMatch = text.match(/^\/skill\s+(create\s+(\S+)|forget\s+(\S+)|restore\s+(\S+))/i);
      if (skillMatch) {
        if (skillMatch[2]) return { command: 'skill-create', args: [skillMatch[2]], agent: undefined as any, model: undefined, prompt: '' };
        if (skillMatch[3]) return { command: 'skill-forget', args: [skillMatch[3]], agent: undefined as any, model: undefined, prompt: '' };
        if (skillMatch[4]) return { command: 'skill-restore', args: [skillMatch[4]], agent: undefined as any, model: undefined, prompt: '' };
      }
```

- [ ] **Step 5: Add command cases to handleCommand**

In the `handleCommand` switch statement, add:

```typescript
      case 'skills':
        await this.cmdSkills(chatId, channel);
        break;
      case 'skill-create':
        // handled via suggestion flow — manual creation by name is a no-op since
        // there's no steps to save. The user should use the suggestion flow.
        await this.sendResponse({ chatId, channel, text: 'Use the skill suggestion flow — say "yes" when I suggest a skill.' });
        break;
      case 'skill-forget':
        if (args.length > 0) {
          const archived = this.skillStore.archive(args[0]);
          await this.sendResponse({ chatId, channel, text: archived ? `🗑️ Skill **${args[0]}** archived.` : `Skill "${args[0]}" not found.` });
        }
        break;
      case 'skill-restore':
        if (args.length > 0) {
          const restored = this.skillStore.restore(args[0]);
          await this.sendResponse({ chatId, channel, text: restored ? `🔄 Skill **${args[0]}** restored.` : `Skill "${args[0]}" not found.` });
        }
        break;
```

- [ ] **Step 6: Implement cmdSkills helper**

Add to the Gateway class:

```typescript
  private async cmdSkills(chatId: string, channel: ChannelType): Promise<void> {
    const active = this.skillStore.getActive();
    if (active.length === 0) {
      await this.sendResponse({ chatId, channel, text: 'No active skills. Skills crystallize from repeated work patterns.' });
      return;
    }
    const lines = active.map(s =>
      `- **${s.name}** (v${s.version}): ${s.description} — used ${s.useCount}×, last ${relativeTime(s.lastUsedAt)}`
    );
    await this.sendResponse({ chatId, channel, text: `📋 **Skills** (${active.length})\n\n${lines.join('\n')}` });
  }
```

- [ ] **Step 7: Add relativeTime helper**

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

- [ ] **Step 8: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/gateway -w packages/core 2>&1
```
Expected: Build succeeds (gateway compiles with new imports).

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(skills): SkillStore lifecycle + /skills /skill commands in gateway

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Gateway — Pre-run skill injection + post-run trace in runOneTurn

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Add pre-run skill injection in runOneTurn**

In `runOneTurn()`, find the line `let prep = this.prepareAgentTurn(ctxWindow, agent, parsed.prompt, memoryContext);` (around line 1123) and replace with:

```typescript
    // ── Skill matching (pre-run) ──────────────────────────
    let appliedSkill: SkillEntry | null = null;
    const skillsCfg = this.configManager.getSkillsConfig();
    let runPrompt = parsed.prompt;
    if (skillsCfg.enabled && runPrompt.trim()) {
      const matched = matchSkill(runPrompt, this.skillStore.getActive());
      if (matched && skillsCfg.autoApply) {
        appliedSkill = matched;
        runPrompt = applySkill(runPrompt, matched);
        this.skillStore.recordUse(matched.name);
        this.logger.info(`[skills] auto-applied: ${matched.name} v${matched.version}`);
      }
    }

    let prep = this.prepareAgentTurn(ctxWindow, agent, runPrompt, memoryContext);
    // keep the rest of buildRequest using runPrompt via prep
```

- [ ] **Step 2: Add post-run trace recording + distillation**

After the memory auto-extraction block (`memoryStore.extractFromInteraction(...)` around line 1175), add:

```typescript
    // ── Skill: record trace + distill ─────────────────────
    if (skillsCfg.enabled && response.success) {
      const trace: RunTrace = {
        runId: `solo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        promptSummary: parsed.prompt.slice(0, 200),
        outputShape: response.output.slice(0, 300),
        timestamp: Date.now(),
        mode: 'solo',
      };
      this.skillStore.recordTrace(trace);

      // If a skill was applied, check for evolution
      if (appliedSkill) {
        const deps = this.getSkillDistillDeps();
        const evolved = await evolveSkill(deps, appliedSkill, trace);
        if (evolved) {
          this.skillStore.bumpVersion(appliedSkill.name, evolved);
          this.logger.info(`[skills] evolved ${appliedSkill.name} → v${this.skillStore.get(appliedSkill.name)?.version}`);
        }
        this.skillStore.recordSuccessSignal(appliedSkill.name, response.success);
      }

      // Periodic distillation check
      const now = Date.now();
      if (now - this.lastSkillDistillTime > Gateway.SKILL_DISTILL_COOLDOWN_MS) {
        this.lastSkillDistillTime = now;
        const recent = this.skillStore.getRecentTraces(skillsCfg.suggestOnRepeat + 5);
        const candidate = await distillCandidate(
          this.getSkillDistillDeps(),
          recent,
          this.skillStore.getAll(),
          skillsCfg.suggestOnRepeat,
        );
        if (candidate) {
          const suggestText = `🧩 I've done something like this ~${skillsCfg.suggestOnRepeat}× ("${candidate.description}"). Save it as a reusable skill **${candidate.name}**? (reply "yes", "no", or "/skill create ${candidate.name}")`;
          await this.sendResponse({ chatId, channel, text: suggestText });
          this.pendingSkillSuggestion = { ...candidate, chatId, channel };
        }
      }
    }
```

- [ ] **Step 3: Add getSkillDistillDeps helper**

Add to the Gateway class:

```typescript
  private getSkillDistillDeps(): DistillDeps {
    const { agent, model } = this.getAdvisorAgentAndModel();
    return {
      agentFactory: this.agentFactory,
      activeAgent: agent,
      activeModel: model || this.getDefaultModelConfig(agent),
      workingDir: this.workingDir,
    };
  }
```

- [ ] **Step 4: Add pending suggestion handler in handleMessage**

In `handleMessage()`, after the `lastAskedOptions` clearing block (after line 978) and *before* the `pending` team check (line 980), add:

```typescript
      // ── Pending skill suggestion check ──────────────────
      if (this.pendingSkillSuggestion) {
        const s = this.pendingSkillSuggestion;
        const lower = message.text.trim().toLowerCase();
        if (lower === 'yes') {
          this.skillStore.add({ name: s.name, description: s.description, whenToUse: s.whenToUse, steps: s.steps, sourceRunId: 'user-confirmed' });
          await this.sendResponse({ chatId: s.chatId, channel: s.channel, text: `✅ Skill **${s.name}** saved! Use \`/skills\` to see all.` });
          this.pendingSkillSuggestion = null;
          return;
        } else if (lower === 'no') {
          await this.sendResponse({ chatId: s.chatId, channel: s.channel, text: 'Got it, I won\'t suggest this one again.' });
          this.pendingSkillSuggestion = null;
          return;
        }
        // Otherwise clear pending and fall through to normal handling
        this.pendingSkillSuggestion = null;
      }
```

- [ ] **Step 5: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/gateway -w packages/core 2>&1
```
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(skills): pre-run injection, post-run trace + distill in runOneTurn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Gateway — sendToChat (Chat/Mac) integration

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Pre-run skill injection in sendToChat**

In `sendToChat()`, find where `prompt` is assigned for the solo path (around line 4105, `prompt = selPrefix + buildChatBootstrapPrompt(...)`). After the solo-advisor injection block (line 4113), add:

```typescript
    // ── Skill matching (pre-run) ──────────────────────────
    let appliedChatSkill: SkillEntry | null = null;
    const skillsCfg = this.configManager.getSkillsConfig();
    if (skillsCfg.enabled && chat.selection.type !== 'team') {
      const matched = matchSkill(userText, this.skillStore.getActive());
      if (matched && skillsCfg.autoApply) {
        appliedChatSkill = matched;
        prompt = applySkill(prompt, matched);
        this.skillStore.recordUse(matched.name);
        this.logger.info(`[skills] auto-applied (chat): ${matched.name} v${matched.version}`);
      }
    }
```

Note: this variable is scoped within `sendToChat`. Declare `appliedChatSkill` alongside `output`, `tokens`, etc. near the top of the method (around line 3975 where other locals are initialized):

```typescript
    let appliedChatSkill: SkillEntry | null = null;
```

- [ ] **Step 2: Post-run trace recording in sendToChat**

After the `sink({ type: 'done', ... })` call (around line 4406), add:

```typescript
      // ── Skill: record trace + distill (Chat/Mac path) ───
      if (skillsCfg.enabled && output) {
        const chatTrace: RunTrace = {
          runId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          promptSummary: userText.slice(0, 200),
          outputShape: output.slice(0, 300),
          workerSequence: teamThinkingByStep ? teamThinkingByStep.map((s: any) => s.worker || s.name || '').filter(Boolean) : undefined,
          timestamp: Date.now(),
          mode: teamTurnId ? 'team-sequential' : 'solo',
        };
        this.skillStore.recordTrace(chatTrace);

        if (appliedChatSkill) {
          const deps = this.getSkillDistillDeps();
          const evolved = await evolveSkill(deps, appliedChatSkill, chatTrace);
          if (evolved) {
            this.skillStore.bumpVersion(appliedChatSkill.name, evolved);
            this.logger.info(`[skills] evolved ${appliedChatSkill.name} → v${this.skillStore.get(appliedChatSkill.name)?.version}`);
          }
          this.skillStore.recordSuccessSignal(appliedChatSkill.name, true);
        }

        // Periodic distillation check (same cooldown as runOneTurn)
        const now = Date.now();
        if (now - this.lastSkillDistillTime > Gateway.SKILL_DISTILL_COOLDOWN_MS) {
          this.lastSkillDistillTime = now;
          const recent = this.skillStore.getRecentTraces(skillsCfg.suggestOnRepeat + 5);
          const candidate = await distillCandidate(
            this.getSkillDistillDeps(), recent, this.skillStore.getAll(), skillsCfg.suggestOnRepeat,
          );
          if (candidate) {
            // For Chat/Mac, send suggestion as an info event
            sink({
              type: 'info',
              chatId,
              message: `🧩 I've done something like this ~${skillsCfg.suggestOnRepeat}× ("${candidate.description}"). Save it as a reusable skill **${candidate.name}**? (reply "yes" or "no")`,
            });
            this.pendingSkillSuggestion = { ...candidate, chatId, channel: '__mac__' as ChannelType };
          }
        }
      }
```

- [ ] **Step 3: Verify build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/gateway -w packages/core 2>&1
```
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(skills): pre-run injection + post-run trace in sendToChat (Chat/Mac)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Full test suite verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test 2>&1 | tail -30
```
Expected: All tests PASS. Core tests (~24 skill-crystallizer + ~24 existing = ~48). Gateway tests (existing ~18). Codey-mac tests (existing ~151).

- [ ] **Step 2: Verify full build**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build 2>&1
```
Expected: Build succeeds.

- [ ] **Step 3: Manual smoke test (optional)**

Start gateway: `npm run dev`
Send `/skills` → expect "No active skills."
Run a task twice → expect suggestion after second run.
Reply "yes" → expect skill saved.
Run similar task → expect auto-apply with `⚙︎ using skill:` prefix.
Run `cd packages/core && npx vitest run src/skill-crystallizer.test.ts` → all pass.

---

## Spec Coverage Checklist

| Spec requirement | Task(s) |
|-----------------|---------|
| Skill store with index.json + .md files | Task 1, 2 |
| Run trace recorder | Task 1, 2 |
| Distiller — LLM-based pattern detection | Task 3 |
| Suggested creation (asks before saving) | Task 8, 9 |
| Auto-apply on match | Task 4, 9, 10 |
| Self-evolution on use | Task 5, 9, 10 |
| GC — stale + weak skill archiving | Task 1, 2, 8 |
| Config block (suggestOnRepeat, staleDays, etc.) | Task 7 |
| /skills + /skill commands | Task 8 |
| solo path (runOneTurn) hooks | Task 9 |
| Chat/Mac path (sendToChat) hooks | Task 10 |
| Suppress re-suggestions after "no" | Task 9 (pendingSkillSuggestion cleared) |

---

## Out of Scope (explicit YAGNI)

- Embeddings-based similarity (LLM distiller is sufficient for current scale).
- Cross-workspace / global skills (workspace-scoped only).
- Sharing/exporting skills between users.
- `skills/archived/` subdirectory — archived skills stay in index with `archived: true`.
- Per-skill `.md` files on disk — only `index.json` is persisted for v1; md is a follow-up.
