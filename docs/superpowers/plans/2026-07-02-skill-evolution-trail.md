# Skill Evolution Trail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each crystallized skill an append-only evolution trail (created / evolved / rolled-back events with timestamps and triggering runs), readable via `/skill history <name>`, on disk, and in a new Mac "Learned Skills" settings tab with forget/restore/rollback actions.

**Architecture:** Events are appended inside `SkillStore`'s own mutators (`add`/`bumpVersion`/`rollback`) so every surface records automatically at one choke point; the rollback stack (`history`) is unchanged and the trail is never consumed. The gateway threads the triggering run into `bumpVersion` and adds a `history` subcommand. The Mac app gets a `learnedSkills:*` IPC namespace (NOT `skills:*` — that namespace already exists for agent-skill *directories*, a different concept) backed by an extracted, unit-testable `electron/learned-skills.ts` module, plus a `LearnedSkillsTab` following the existing SettingsOverlay tab pattern.

**Tech Stack:** TypeScript (strict), Vitest, Electron IPC (`ipcMain.handle` + `wrap()` + contextBridge), React with inline styles + `theme.C` tokens.

**Environment note:** default node is v16 and cannot run vitest/tsc. Prefix every build/test command with `source ~/.nvm/nvm.sh && nvm use v22.17.1 && `. Work in `/path/to/codey/.worktrees/skill-evolution-trail` (branch `feat/skill-evolution-trail`, stacked on `feat/self-crystallizing-skills`).

---

## File Map

| File | Responsibility |
|------|---------------|
| `packages/core/src/skill-crystallizer.ts` | `SkillEvolutionEvent` type, `EVOLUTION_MAX`, `SkillEntry.evolution`, event appends in `add`/`bumpVersion`/`rollback`, load backfill |
| `packages/core/src/skill-crystallizer.test.ts` | Evolution-trail unit tests |
| `packages/gateway/src/gateway.ts` | Trigger threading from the evolve stage; `/skill history <name>` command |
| `codey-mac/electron/learned-skills.ts` (new) | Pure functions over a `SkillStore` (list/history/forget/restore/rollback) — the testable IPC core |
| `codey-mac/electron/learned-skills.test.ts` (new) | Tests against a real temp-dir SkillStore |
| `codey-mac/electron/main.ts` | `learnedSkills:*` `ipcMain.handle` registrations |
| `codey-mac/electron/preload.ts` | `learnedSkills` contextBridge namespace |
| `codey-mac/src/components/learnedSkillsModel.ts` (new) | Pure view helpers (timeline rows, relative time) |
| `codey-mac/src/components/learnedSkillsModel.test.ts` (new) | View-model tests |
| `codey-mac/src/components/LearnedSkillsTab.tsx` (new) | The panel UI |
| `codey-mac/src/components/SettingsOverlay.tsx` | New tab entry |

---

### Task 1: Core — evolution events in SkillStore (TDD)

**Files:**
- Modify: `packages/core/src/skill-crystallizer.ts`
- Test: `packages/core/src/skill-crystallizer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/skill-crystallizer.test.ts` (inside the file; merge imports into the existing top import — add `EVOLUTION_MAX` and `SkillEvolutionEvent`):

```typescript
describe('evolution trail', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-evo-test-'));
    store = new SkillStore(tmp);
    await store.load();
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('add() records a created event on new skills', () => {
    store.add({ name: 'rel', description: 'd', whenToUse: 'w', steps: 's1' });
    const ev = store.get('rel')!.evolution;
    expect(ev.length).toBe(1);
    expect(ev[0].kind).toBe('created');
    expect(ev[0].toVersion).toBe(1);
    expect(ev[0].fromVersion).toBeUndefined();
    expect(ev[0].steps).toBe('s1');
    expect(ev[0].at).toBeGreaterThan(0);
  });

  it('upsert with changed steps records an evolved event with trigger', () => {
    store.add({ name: 'rel', description: 'd', whenToUse: 'w', steps: 's1' });
    store.add({ name: 'rel', description: 'd2', whenToUse: 'w', steps: 's2',
                trigger: { runId: 'r9', promptSummary: 'redo notes' } });
    const ev = store.get('rel')!.evolution;
    expect(ev.length).toBe(2);
    expect(ev[1].kind).toBe('evolved');
    expect(ev[1].fromVersion).toBe(1);
    expect(ev[1].toVersion).toBe(2);
    expect(ev[1].trigger).toEqual({ runId: 'r9', promptSummary: 'redo notes' });
    expect(ev[1].steps).toBe('s2');
  });

  it('upsert with identical steps records no event', () => {
    store.add({ name: 'rel', description: 'd', whenToUse: 'w', steps: 's1' });
    store.add({ name: 'rel', description: 'd2', whenToUse: 'w2', steps: 's1' });
    expect(store.get('rel')!.evolution.length).toBe(1);
  });

  it('bumpVersion records an evolved event with trigger', () => {
    store.add({ name: 'rel', description: 'd', whenToUse: 'w', steps: 's1' });
    store.bumpVersion('rel', 's2', { runId: 'r1', promptSummary: 'draft notes' });
    const ev = store.get('rel')!.evolution;
    expect(ev.length).toBe(2);
    expect(ev[1]).toMatchObject({
      kind: 'evolved', fromVersion: 1, toVersion: 2, steps: 's2',
      trigger: { runId: 'r1', promptSummary: 'draft notes' },
    });
  });

  it('rollback records a rolled-back event with restored version and steps', () => {
    store.add({ name: 'rel', description: 'd', whenToUse: 'w', steps: 's1' });
    store.bumpVersion('rel', 's2', { runId: 'r1', promptSummary: 'p' });
    store.rollback('rel');
    const ev = store.get('rel')!.evolution;
    expect(ev.length).toBe(3);
    expect(ev[2]).toMatchObject({ kind: 'rolled-back', fromVersion: 2, toVersion: 1, steps: 's1' });
    expect(ev[2].trigger).toBeUndefined();
  });

  it('trail is capped at EVOLUTION_MAX, dropping oldest', () => {
    store.add({ name: 'rel', description: 'd', whenToUse: 'w', steps: 'v1' });
    for (let i = 2; i <= EVOLUTION_MAX + 5; i++) {
      store.bumpVersion('rel', `v${i}`);
    }
    const ev = store.get('rel')!.evolution;
    expect(ev.length).toBe(EVOLUTION_MAX);
    expect(ev[ev.length - 1].steps).toBe(`v${EVOLUTION_MAX + 5}`);
    expect(ev[0].kind).toBe('evolved'); // the 'created' event fell off the front
  });

  it('legacy entries load with evolution: []', async () => {
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'index.json'), JSON.stringify({
      version: 1,
      entries: [{
        name: 'legacy', description: 'd', whenToUse: 'w', steps: 's',
        version: 3, useCount: 1, lastUsedAt: 1, history: [],
        successSignals: { cleanRuns: 0, corrections: 0 },
        sourceRunIds: [], createdAt: 1, archived: false,
      }],
      rejected: [],
    }));
    const store2 = new SkillStore(tmp);
    await store2.load();
    expect(store2.get('legacy')!.evolution).toEqual([]);
  });

  it('events survive a persist/reload round-trip', async () => {
    store.add({ name: 'rel', description: 'd', whenToUse: 'w', steps: 's1' });
    store.bumpVersion('rel', 's2', { runId: 'r1', promptSummary: 'p' });
    await store.flush();
    const store2 = new SkillStore(tmp);
    await store2.load();
    const ev = store2.get('rel')!.evolution;
    expect(ev.length).toBe(2);
    expect(ev[1].trigger?.runId).toBe('r1');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core -- skill-crystallizer 2>&1 | tail -15
```
Expected: the new tests fail to compile / fail (no `evolution` field, no `EVOLUTION_MAX` export, `add`/`bumpVersion` reject the new params).

- [ ] **Step 3: Implement in `packages/core/src/skill-crystallizer.ts`**

3a. Add the type and constant (type after `SkillEntry`'s dependencies, constant next to `HISTORY_MAX` at ~line 75):

```typescript
export interface SkillEvolutionEvent {
  at: number;
  kind: 'created' | 'evolved' | 'rolled-back';
  /** Absent for 'created'. */
  fromVersion?: number;
  toVersion: number;
  /** The run that triggered an 'evolved' event; absent for created/rolled-back. */
  trigger?: { runId: string; promptSummary: string };
  /** Snapshot of the steps as of this event — the trail alone reconstructs
   *  every version even after the rollback stack's cap prunes old steps. */
  steps: string;
}

export const EVOLUTION_MAX = 20;
```

3b. Add to `SkillEntry` (after `history`):

```typescript
  /** Append-only audit trail of version changes, capped at EVOLUTION_MAX.
   *  Never consumed — rollback pops `history`, not this. */
  evolution: SkillEvolutionEvent[];
```

3c. Extend the `load()` backfill (line ~115) to also default `evolution`:

```typescript
entries: parsed.entries.map(e => ({ ...e, history: e.history ?? [], evolution: e.evolution ?? [] })),
```

3d. Add a private static helper (near the persistence helpers):

```typescript
  private static appendEvolution(entry: SkillEntry, event: SkillEvolutionEvent): void {
    entry.evolution.push(event);
    if (entry.evolution.length > EVOLUTION_MAX) {
      entry.evolution = entry.evolution.slice(-EVOLUTION_MAX);
    }
  }
```

3e. `add()` — extend the params type with `trigger?: { runId: string; promptSummary: string }`. In the upsert branch, inside the existing `if steps changed` block (which already pushes history and bumps version), capture `const fromVersion = existing.version;` BEFORE the increment and append after it:

```typescript
      SkillStore.appendEvolution(existing, {
        at: now, kind: 'evolved', fromVersion, toVersion: existing.version,
        trigger: params.trigger, steps: params.steps,
      });
```

In the new-entry branch, initialize `evolution` on the literal and record creation:

```typescript
      evolution: [{ at: now, kind: 'created', toVersion: 1, steps: params.steps }],
```

3f. `bumpVersion()` — new signature `bumpVersion(name: string, newSteps: string, trigger?: { runId: string; promptSummary: string }): boolean`. Capture `const fromVersion = entry.version;` before the increment; after `entry.steps = newSteps;` append:

```typescript
    SkillStore.appendEvolution(entry, {
      at: Date.now(), kind: 'evolved', fromVersion, toVersion: entry.version,
      trigger, steps: newSteps,
    });
```

3g. `rollback()` — capture `const fromVersion = entry.version;` before the pop; after restoring version/steps append:

```typescript
    SkillStore.appendEvolution(entry, {
      at: Date.now(), kind: 'rolled-back', fromVersion,
      toVersion: prior.version, steps: prior.steps,
    });
```

- [ ] **Step 4: Run — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w packages/core 2>&1 | tail -8
```
Expected: all core tests pass (147 existing + 8 new = 155).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skill-crystallizer.ts packages/core/src/skill-crystallizer.test.ts
git commit -m "feat(skills): per-skill evolution trail in SkillStore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Gateway — trigger threading + /skill history command

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Thread the trigger from the evolve stage**

In `afterRunSkillPass` (~line 1829-1841), change the `bumpVersion` call:

```typescript
      store.bumpVersion(entry.name, evolved, {
        runId: opts.trace.runId,
        promptSummary: opts.trace.promptSummary,
      });
```

- [ ] **Step 2: Extend the parseCommand subcommand regex**

At ~line 3785, change the regex to include `history`:

```typescript
      const skillSubMatch = text.match(/^\/skill\s+(forget|restore|rollback|history)\s+(\S+)/i);
```

(The return statement is unchanged — it already builds `skill-${sub}`.)

- [ ] **Step 3: Exclude `history` from BOTH explicit-invoke regexes**

There are two `/skill <name> <task>` matchers with a negative lookahead `(?!forget\b|restore\b|rollback\b)` — one in `handleMessage` (~line 1049) and one in `sendToChat` (search for the second occurrence of `forget\\b|restore\\b|rollback\\b`). Add `|history\b` to BOTH:

```typescript
/^\/skill\s+(?!forget\b|restore\b|rollback\b|history\b)(\S+)\s+([\s\S]+)/i
```

- [ ] **Step 4: Add the handleCommand case**

Next to `skill-rollback` (~line 1588):

```typescript
      case 'skill-history':
        await this.cmdSkillHistory(chatId, channel, args[0]);
        break;
```

(Match how the neighboring cases access `chatId`/`channel` — read them first.)

- [ ] **Step 5: Implement cmdSkillHistory**

Add next to `cmdSkills` (~line 1763):

```typescript
  private async cmdSkillHistory(chatId: string, channel: ChannelType, name: string): Promise<void> {
    const skill = this.workspaceManager.getSkillStore().get(name);
    if (!skill) {
      await this.sendResponse({ chatId, channel, text: `Skill "${name}" not found.` });
      return;
    }
    if (!skill.evolution || skill.evolution.length === 0) {
      await this.sendResponse({ chatId, channel,
        text: `📜 **${skill.name}** (v${skill.version}) — no recorded evolution events yet.` });
      return;
    }
    const lines = skill.evolution.map(ev => {
      const trig = ev.trigger ? ` ← "${ev.trigger.promptSummary.slice(0, 80)}"` : '';
      return `- v${ev.toVersion} ${ev.kind} · ${Codey.relativeTime(ev.at)}${trig}`;
    });
    await this.sendResponse({
      chatId, channel,
      text: `📜 **${skill.name}** — evolution (v${skill.version} current)\n\n${lines.join('\n')}\n\nCurrent steps (v${skill.version}):\n${skill.steps}`,
    });
  }
```

- [ ] **Step 6: Verify build + tests**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w packages/core -w packages/gateway 2>&1 | tail -3 && npm test -w packages/gateway 2>&1 | tail -5
```
Expected: build clean, 53 gateway tests pass. (There is no command-level test seam in gateway.ts; the command is exercised via the Mac module tests in Task 3 and the smoke test in Task 5.)

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(skills): /skill history command + evolve trigger threading

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Mac — learned-skills IPC module (TDD)

**Files:**
- Create: `codey-mac/electron/learned-skills.ts`
- Test: `codey-mac/electron/learned-skills.test.ts`
- Modify: `codey-mac/electron/main.ts`, `codey-mac/electron/preload.ts`

NAMING: the `skills:*` IPC namespace and `SkillsTab.tsx` already exist for agent-skill DIRECTORIES (`~/.claude/skills/` etc.) — a different concept. This feature uses `learnedSkills:*` everywhere.

- [ ] **Step 1: Write the failing tests**

Create `codey-mac/electron/learned-skills.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore } from '@codey/core';
import {
  listLearnedSkills, learnedSkillHistory,
  forgetLearnedSkill, restoreLearnedSkill, rollbackLearnedSkill,
} from './learned-skills';

describe('learned-skills IPC module', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-learned-test-'));
    store = new SkillStore(tmp);
    await store.load();
    store.add({ name: 'rel', description: 'Release notes', whenToUse: 'w', steps: 's1' });
    store.bumpVersion('rel', 's2', { runId: 'r1', promptSummary: 'draft notes' });
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists summaries with canRollback derived from the rollback stack', () => {
    const list = listLearnedSkills(store);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      name: 'rel', version: 2, archived: false, canRollback: true,
    });
    store.rollback('rel');
    expect(listLearnedSkills(store)[0]).toMatchObject({ version: 1, canRollback: false });
  });

  it('returns the evolution trail for a skill', () => {
    const ev = learnedSkillHistory(store, 'rel');
    expect(ev.length).toBe(2);
    expect(ev[0].kind).toBe('created');
    expect(ev[1]).toMatchObject({ kind: 'evolved', toVersion: 2 });
  });

  it('history throws for unknown skill', () => {
    expect(() => learnedSkillHistory(store, 'nope')).toThrow(/not found/i);
  });

  it('forget archives, restore unarchives', () => {
    forgetLearnedSkill(store, 'rel');
    expect(listLearnedSkills(store)[0].archived).toBe(true);
    restoreLearnedSkill(store, 'rel');
    expect(listLearnedSkills(store)[0].archived).toBe(false);
  });

  it('forget/restore throw for unknown skill', () => {
    expect(() => forgetLearnedSkill(store, 'nope')).toThrow(/not found/i);
    expect(() => restoreLearnedSkill(store, 'nope')).toThrow(/not found/i);
  });

  it('rollback restores the prior version and returns it', () => {
    expect(rollbackLearnedSkill(store, 'rel')).toBe(1);
    expect(listLearnedSkills(store)[0].version).toBe(1);
  });

  it('rollback throws when there is no prior version', () => {
    store.rollback('rel');
    expect(() => rollbackLearnedSkill(store, 'rel')).toThrow(/no prior version/i);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w codey-mac 2>&1 | tail -8
```
Expected: FAIL — module `./learned-skills` does not exist. (The vitest include already covers `electron/**/*.test.ts`.) If `@codey/core` fails to resolve, run `npm run build -w packages/core` first — codey-mac consumes core's dist.

- [ ] **Step 3: Implement `codey-mac/electron/learned-skills.ts`**

```typescript
// Pure functions over the gateway's crystallizer SkillStore, extracted so the
// learnedSkills:* IPC handlers are unit-testable without Electron.
// NOT the same thing as the agent-skill directories behind the skills:* IPC.
import type { SkillStore, SkillEvolutionEvent } from '@codey/core';

export interface LearnedSkillSummary {
  name: string;
  description: string;
  version: number;
  useCount: number;
  lastUsedAt: number;
  archived: boolean;
  successSignals: { cleanRuns: number; corrections: number };
  canRollback: boolean;
}

export function listLearnedSkills(store: SkillStore): LearnedSkillSummary[] {
  return store.getAll().map(s => ({
    name: s.name,
    description: s.description,
    version: s.version,
    useCount: s.useCount,
    lastUsedAt: s.lastUsedAt,
    archived: s.archived,
    successSignals: s.successSignals,
    canRollback: s.history.length > 0,
  }));
}

export function learnedSkillHistory(store: SkillStore, name: string): SkillEvolutionEvent[] {
  const skill = store.get(name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  return [...skill.evolution];
}

export function forgetLearnedSkill(store: SkillStore, name: string): void {
  if (!store.archive(name)) throw new Error(`Skill not found: ${name}`);
}

export function restoreLearnedSkill(store: SkillStore, name: string): void {
  if (!store.restore(name)) throw new Error(`Skill not found: ${name}`);
}

export function rollbackLearnedSkill(store: SkillStore, name: string): number {
  if (!store.rollback(name)) {
    throw new Error(`Skill "${name}" has no prior version (or was not found).`);
  }
  return store.get(name)!.version;
}
```

- [ ] **Step 4: Run — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w codey-mac 2>&1 | tail -5
```
Expected: 151 existing + 7 new = 158 pass.

- [ ] **Step 5: Register IPC handlers in `codey-mac/electron/main.ts`**

Next to the existing `skills:*` handlers (~line 2212), add — note the store MUST come from the gateway's own workspace manager (`inProcessGateway.getWorkspaceManager()`), NOT the separate top-level `workspaceManager` singleton in main.ts, or the panel would read a different store than the one the gateway mutates:

```typescript
// ── Learned skills (crystallizer SkillStore) — distinct from skills:* above,
//    which manages agent-skill directories on disk. ──────────────────────────
function learnedSkillStore() {
  if (!inProcessGateway) throw new Error('Gateway not initialized');
  // The gateway's OWN workspace manager — not main.ts's workspaceManager singleton.
  return inProcessGateway.getWorkspaceManager().getSkillStore();
}
ipcMain.handle('learnedSkills:list', async () =>
  wrap(async () => listLearnedSkills(learnedSkillStore())));
ipcMain.handle('learnedSkills:history', async (_e, name: string) =>
  wrap(async () => learnedSkillHistory(learnedSkillStore(), name)));
ipcMain.handle('learnedSkills:forget', async (_e, name: string) =>
  wrap(async () => forgetLearnedSkill(learnedSkillStore(), name)));
ipcMain.handle('learnedSkills:restore', async (_e, name: string) =>
  wrap(async () => restoreLearnedSkill(learnedSkillStore(), name)));
ipcMain.handle('learnedSkills:rollback', async (_e, name: string) =>
  wrap(async () => rollbackLearnedSkill(learnedSkillStore(), name)));
```

Add the import at the top of main.ts:

```typescript
import { listLearnedSkills, learnedSkillHistory, forgetLearnedSkill, restoreLearnedSkill, rollbackLearnedSkill } from './learned-skills';
```

Verify `getWorkspaceManager()` is public on the gateway class (gateway.ts:616) — it is.

- [ ] **Step 6: Expose in `codey-mac/electron/preload.ts`**

Next to the existing `skills` namespace (~line 82):

```typescript
  learnedSkills: {
    list: () => ipcRenderer.invoke('learnedSkills:list'),
    history: (name: string) => ipcRenderer.invoke('learnedSkills:history', name),
    forget: (name: string) => ipcRenderer.invoke('learnedSkills:forget', name),
    restore: (name: string) => ipcRenderer.invoke('learnedSkills:restore', name),
    rollback: (name: string) => ipcRenderer.invoke('learnedSkills:rollback', name),
  },
```

If preload.ts has a typed `window.codey` declaration (check for a `declare global` or a `CodeyApi` type — also check `codey-mac/src` for a `window.codey` type declaration file), extend it with the same shape.

- [ ] **Step 7: Build + test**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build -w codey-mac 2>&1 | tail -3 && npm test -w codey-mac 2>&1 | tail -5
```
Expected: build clean, 158 tests pass.

- [ ] **Step 8: Commit**

```bash
git add codey-mac/electron/learned-skills.ts codey-mac/electron/learned-skills.test.ts codey-mac/electron/main.ts codey-mac/electron/preload.ts
git commit -m "feat(mac): learnedSkills IPC over the crystallizer SkillStore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mac — Learned Skills tab (view-model TDD + UI)

**Files:**
- Create: `codey-mac/src/components/learnedSkillsModel.ts`
- Test: `codey-mac/src/components/learnedSkillsModel.test.ts`
- Create: `codey-mac/src/components/LearnedSkillsTab.tsx`
- Modify: `codey-mac/src/components/SettingsOverlay.tsx`

Follow the codebase's extract-pure-model pattern: all logic that formats or decides goes in `learnedSkillsModel.ts` (tested); the `.tsx` only renders.

- [ ] **Step 1: Write the failing view-model tests**

Create `codey-mac/src/components/learnedSkillsModel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { relativeTime, timelineRows, skillActions } from './learnedSkillsModel';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

describe('relativeTime', () => {
  const now = 1_000 * DAY;
  it('formats just now / minutes / hours / days', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * MIN, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * HOUR, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * DAY, now)).toBe('2d ago');
  });
});

describe('timelineRows', () => {
  const now = 1_000 * DAY;
  it('maps evolution events to display rows, oldest first', () => {
    const rows = timelineRows([
      { at: now - 2 * DAY, kind: 'created', toVersion: 1, steps: 's1' },
      { at: now - DAY, kind: 'evolved', fromVersion: 1, toVersion: 2,
        trigger: { runId: 'r1', promptSummary: 'draft release notes for v2.1' }, steps: 's2' },
      { at: now - HOUR, kind: 'rolled-back', fromVersion: 2, toVersion: 1, steps: 's1' },
    ], now);
    expect(rows).toEqual([
      { label: 'v1 created', when: '2d ago', trigger: undefined, steps: 's1' },
      { label: 'v2 evolved', when: '1d ago', trigger: 'draft release notes for v2.1', steps: 's2' },
      { label: 'v1 rolled back', when: '3h ago', trigger: undefined, steps: 's1' },
    ]);
  });

  it('truncates long trigger summaries to 80 chars with ellipsis', () => {
    const long = 'x'.repeat(120);
    const rows = timelineRows([
      { at: 0, kind: 'evolved', fromVersion: 1, toVersion: 2,
        trigger: { runId: 'r', promptSummary: long }, steps: 's' },
    ], 0);
    expect(rows[0].trigger!.length).toBe(81); // 80 + ellipsis char
    expect(rows[0].trigger!.endsWith('…')).toBe(true);
  });
});

describe('skillActions', () => {
  it('derives which action buttons are enabled', () => {
    expect(skillActions({ archived: false, canRollback: true }))
      .toEqual({ forget: true, restore: false, rollback: true });
    expect(skillActions({ archived: true, canRollback: false }))
      .toEqual({ forget: false, restore: true, rollback: false });
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w codey-mac 2>&1 | tail -8
```

- [ ] **Step 3: Implement `codey-mac/src/components/learnedSkillsModel.ts`**

```typescript
// Pure view helpers for LearnedSkillsTab — kept renderer-free so vitest (node env) can test them.

export interface EvolutionEventLike {
  at: number;
  kind: 'created' | 'evolved' | 'rolled-back';
  fromVersion?: number;
  toVersion: number;
  trigger?: { runId: string; promptSummary: string };
  steps: string;
}

export interface TimelineRow {
  label: string;
  when: string;
  trigger: string | undefined;
  steps: string;
}

export function relativeTime(ts: number, now: number): string {
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const KIND_LABEL: Record<EvolutionEventLike['kind'], string> = {
  'created': 'created',
  'evolved': 'evolved',
  'rolled-back': 'rolled back',
};

export function timelineRows(events: EvolutionEventLike[], now: number): TimelineRow[] {
  return events.map(ev => ({
    label: `v${ev.toVersion} ${KIND_LABEL[ev.kind]}`,
    when: relativeTime(ev.at, now),
    trigger: ev.trigger
      ? (ev.trigger.promptSummary.length > 80
          ? `${ev.trigger.promptSummary.slice(0, 80)}…`
          : ev.trigger.promptSummary)
      : undefined,
    steps: ev.steps,
  }));
}

export function skillActions(s: { archived: boolean; canRollback: boolean }): {
  forget: boolean; restore: boolean; rollback: boolean;
} {
  return { forget: !s.archived, restore: s.archived, rollback: !s.archived && s.canRollback };
}
```

- [ ] **Step 4: Run — all pass**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test -w codey-mac 2>&1 | tail -5
```
Expected: 158 + 4 = 162 pass.

- [ ] **Step 5: Implement `codey-mac/src/components/LearnedSkillsTab.tsx`**

Model it on `SkillsTab.tsx` (READ IT FIRST — reuse its structural idioms: `useState` + `useCallback reload` + `useEffect`, `unwrap` from `./settingsAtoms`, inline styles with `import { C } from '../theme'`, `pillButton()` for actions). Shape:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { C } from '../theme';
import { unwrap, pillButton } from './settingsAtoms';
import {
  timelineRows, skillActions, relativeTime, EvolutionEventLike, TimelineRow,
} from './learnedSkillsModel';

interface Summary {
  name: string; description: string; version: number; useCount: number;
  lastUsedAt: number; archived: boolean;
  successSignals: { cleanRuns: number; corrections: number };
  canRollback: boolean;
}

export default function LearnedSkillsTab() {
  const [skills, setSkills] = useState<Summary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [trail, setTrail] = useState<TimelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSkills(unwrap(await (window as any).codey.learnedSkills.list()));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const toggleExpand = useCallback(async (name: string) => {
    if (expanded === name) { setExpanded(null); return; }
    try {
      const events = unwrap(await (window as any).codey.learnedSkills.history(name)) as EvolutionEventLike[];
      setTrail(timelineRows(events, Date.now()));
      setExpanded(name);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [expanded]);

  const act = useCallback(async (kind: 'forget' | 'restore' | 'rollback', name: string) => {
    const messages = {
      forget: `Archive skill "${name}"? It stops being applied but can be restored.`,
      restore: `Restore skill "${name}"?`,
      rollback: `Roll back "${name}" to its previous version?`,
    } as const;
    if (!window.confirm(messages[kind])) return;
    try {
      unwrap(await (window as any).codey.learnedSkills[kind](name));
      await reload();
      if (expanded === name) setExpanded(null); // trail is stale after a mutation
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [reload, expanded]);

  // Render: header, error line, empty state
  // ("No learned skills yet. Skills crystallize from repeated work patterns."),
  // then one card per skill:
  //   name (vN) · description · used N× · last <relativeTime(lastUsedAt, Date.now())>
  //   · archived badge when archived · ✓N ✗M from successSignals
  //   action pills from skillActions(s): Forget / Restore / Roll back
  //   click row → toggleExpand → timeline list of trail rows
  //     (label · when · trigger in quotes when present · steps in a
  //      collapsed <pre> with monospace font and C.bgSubtle background)
  // Follow SkillsTab.tsx's exact card/list styling idioms.
  ...
}
```

The render body is intentionally described rather than fully coded here because it must copy `SkillsTab.tsx`'s concrete style objects — transcribe its `cardStyle`/list idioms rather than inventing new ones. Everything with logic (enabled states, labels, truncation, times) comes from the tested model functions. If `settingsAtoms` doesn't export `unwrap`/`pillButton` under those names, use whatever SkillsTab.tsx actually imports.

- [ ] **Step 6: Register the tab in `codey-mac/src/components/SettingsOverlay.tsx`**

- Extend the `Tab` type (line ~15) with `'learned-skills'`.
- Add to the `TABS` array (after the existing skills entry, line ~21):

```typescript
  { key: 'learned-skills', label: 'Learned', icon: '🧩', description: 'Skills Codey crystallized from your work' },
```

- Add the render branch next to `{tab === 'skills' && <SkillsTab />}` (line ~89):

```tsx
      {tab === 'learned-skills' && <LearnedSkillsTab />}
```

- Import `LearnedSkillsTab` alongside the other tab imports.

- [ ] **Step 7: Build + full test + lint**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm run build 2>&1 | tail -3 && npm test 2>&1 | grep -E "Test Files|Tests " && npm run lint 2>&1 | tail -1
```
Expected: full build clean (core 155-test suite, gateway 53, codey-mac 162), lint passes.

- [ ] **Step 8: Commit**

```bash
git add codey-mac/src/components/learnedSkillsModel.ts codey-mac/src/components/learnedSkillsModel.test.ts codey-mac/src/components/LearnedSkillsTab.tsx codey-mac/src/components/SettingsOverlay.tsx
git commit -m "feat(mac): Learned Skills settings tab with evolution timeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-skill-evolution-trail-design.md` (status line only)

- [ ] **Step 1: Full suite**

```bash
source ~/.nvm/nvm.sh && nvm use v22.17.1 && npm test 2>&1 | grep -E "Test Files|Tests " && npm run build 2>&1 | tail -2 && npm run lint 2>&1 | tail -1
```
Expected: core 155, gateway 53, codey-mac 162 — all pass; build + lint clean.

- [ ] **Step 2: Manual smoke (optional but recommended)**

1. Launch the built app; open Settings → Learned tab → expect the empty state (or existing skills).
2. In a chat: get a skill saved (accept a suggestion), invoke it 3× via `/skill <name> <task>` with a deviating 3rd task → on evolution, check `/skill history <name>` shows `v2 evolved ← "<task>"`.
3. Open the Learned tab → expand the skill → timeline shows created + evolved rows with the trigger.
4. Click Roll back → confirm → version drops, timeline gains a rolled-back row, `⏪` semantics match the `/skill rollback` command.
5. `cat ~/.codey/workspaces/<ws>/skills/index.json | jq '.entries[0].evolution'` — events on disk.

- [ ] **Step 3: Update the spec status and commit**

Change the spec's `Status:` line to `Implemented (2026-07-02)`.

```bash
git add docs/superpowers/specs/2026-07-02-skill-evolution-trail-design.md
git commit -m "docs: mark skill-evolution-trail spec implemented

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec Coverage Checklist

| Spec requirement | Task(s) |
|-----------------|---------|
| `SkillEvolutionEvent` + `evolution` on SkillEntry, cap 20, backfill | Task 1 |
| Events appended in add/bumpVersion/rollback (single choke point) | Task 1 |
| Trigger (runId + promptSummary) threaded from the evolve stage | Task 2 |
| `/skill history <name>` with oldest-first timeline + current steps | Task 2 |
| `learnedSkills:*` IPC (list/history/forget/restore/rollback), wrap() errors | Task 3 |
| Store reached via `inProcessGateway.getWorkspaceManager().getSkillStore()` | Task 3 |
| Mac panel: list, expandable timeline, gated actions with confirmations | Task 4 |
| Mutations refresh from list (no optimistic state) | Task 4 (reload after act) |
| Testing: core events/cap/backfill/round-trip; IPC module; view model | Tasks 1, 3, 4 |

## Out of Scope (per spec YAGNI)

- Per-application logging; steps editing from the panel; diff rendering between versions; cross-workspace browsing; retro-fitting trails for pre-existing skills (they show "no recorded evolution events yet" until their next change).
