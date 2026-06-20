# Team Auto-Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in `dispatch: 'auto'` mode to `/team` so a built-in dispatcher routes each task to the relevant subset of workers, while preserving sequential carry-chain semantics for the chosen subset.

**Architecture:** Pre-step in the existing `runTeamTask` / `runTeamForChat` paths invokes a new `runDispatcher` (using the existing `runWithFallback` infrastructure with a configurable agent/model). The downstream sequential loop is untouched. Backward compatible: legacy `string[]` team configs normalize to `dispatch: 'all'`.

**Tech Stack:** TypeScript (CommonJS, ES2020, strict), monorepo with `packages/core` + `packages/gateway`. No test runner — verification via small node scripts and manual gateway runs.

**Reference spec:** `docs/superpowers/specs/2026-05-01-team-auto-dispatch-design.md`

---

## Verification convention

Project has no test runner. For each module-level change we write a minimal verification script under `scripts/verify/<task>.ts` that uses node's built-in `assert` and is run via `ts-node`. These scripts are **not** committed as tests — they exist to make each task independently verifiable. Delete or keep ad-hoc; the canonical test surface is the manual checklist at the end.

To run a verify script:
```bash
npx ts-node scripts/verify/<file>.ts
```

---

## Task 1: Extend core type schema

**Files:**
- Modify: `packages/core/src/types/index.ts`
- Modify: `packages/core/src/workspace.ts:13-16` (`WorkspaceJson` interface)
- Modify: `packages/core/src/workers.ts:10-14` (`WorkerConfig` interface)

- [ ] **Step 1: Add `dispatchHint` to `WorkerConfig`**

In `packages/core/src/workers.ts`, change the `WorkerConfig` interface:

```ts
export interface WorkerConfig {
  codingAgent: 'claude-code' | 'opencode' | 'codex';
  model: string;
  tools: string[];
  /**
   * Optional one-line summary fed to the auto-dispatcher when this worker
   * appears in a team with `dispatch: 'auto'`. When unset, the dispatcher
   * uses the first line of `personality.role` truncated to 120 chars.
   * `personality.soul` and `.instructions` are never sent to the dispatcher.
   */
  dispatchHint?: string;
}
```

- [ ] **Step 2: Define team config shapes in workspace.ts**

In `packages/core/src/workspace.ts`, replace the `WorkspaceJson` interface (lines 13–16) with:

```ts
export type TeamDispatchMode = 'all' | 'auto';

/** Raw team value as it can appear in workspace.json. */
export type TeamConfigRaw = string[] | { members: string[]; dispatch?: TeamDispatchMode };

/** Normalized team value used at runtime. */
export interface TeamConfig {
  members: string[];
  dispatch: TeamDispatchMode;
}

export interface WorkspaceJson {
  workingDir: string;
  teams?: Record<string, TeamConfigRaw>;
}
```

- [ ] **Step 3: Add dispatcher block to `GatewayConfig` and `GatewayConfigJson`**

In `packages/core/src/types/index.ts`, append a field to the `GatewayConfig` interface (around line 217, before the closing brace):

```ts
  /** Optional auto-dispatcher settings used when a team has dispatch: 'auto'. */
  dispatcher?: {
    /** Coding agent to use for the dispatch decision. Defaults to gateway default. */
    agent?: CodingAgent;
    /** Model name (must exist in the global model catalog). Defaults to default agent's default model. */
    model?: string;
  };
```

In `packages/gateway/src/config.ts`, append the same field to `GatewayConfigJson` (after the `dev` block, line 41 area — keep the closing brace intact):

```ts
  /** See GatewayConfig.dispatcher in @codey/core types. Optional. */
  dispatcher?: {
    agent?: CodingAgent;
    model?: string;
  };
```

- [ ] **Step 4: Build to confirm types compile**

Run: `npm run build`
Expected: PASS — no TypeScript errors. (No call sites consume the new fields yet.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workers.ts packages/core/src/workspace.ts packages/core/src/types/index.ts packages/gateway/src/config.ts
git commit -m "feat(types): add dispatchHint, TeamConfig, dispatcher schema"
```

---

## Task 2: WorkerManager — dispatchHint accessor + persistence

**Files:**
- Modify: `packages/core/src/workers.ts` (loadWorker, saveWorker, add getDispatchHint)
- Create: `scripts/verify/workers-dispatch-hint.ts`

- [ ] **Step 1: Persist `dispatchHint` in `loadWorker`**

In `packages/core/src/workers.ts`, the existing `loadWorker` parses `config.json` into `WorkerConfig`. Because `dispatchHint` is optional and TypeScript-only (no runtime validation needed), the existing `JSON.parse` already preserves it. No change required for load — verify by reading:

Open `packages/core/src/workers.ts:87-103`. Confirm `config = JSON.parse(...)` and the validation block does not strip extra fields. No edit needed in this step.

- [ ] **Step 2: Persist `dispatchHint` in `saveWorker`**

In `packages/core/src/workers.ts`, locate `saveWorker` (lines 190–197). The existing implementation already serializes the full `config` object via `JSON.stringify(config, null, 2)`, so optional fields are preserved automatically. No change required. Verify by reading.

- [ ] **Step 3: Add `getDispatchHint` method**

In `packages/core/src/workers.ts`, add this method to the `WorkerManager` class (after `getWorkerModel`, around line 167):

```ts
  /**
   * Returns the one-line summary the auto-dispatcher should see for this worker.
   * Prefers `config.dispatchHint`; otherwise falls back to the first line of
   * `personality.role` truncated to 120 characters. Empty string if the worker
   * is unknown.
   */
  getDispatchHint(name: string): string {
    const w = this.getWorker(name);
    if (!w) return '';
    if (w.config.dispatchHint && w.config.dispatchHint.trim()) {
      return w.config.dispatchHint.trim();
    }
    const firstLine = (w.personality.role || '').split('\n')[0].trim();
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }
```

- [ ] **Step 4: Write verify script**

Create `scripts/verify/workers-dispatch-hint.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import { WorkerManager } from '../../packages/core/src/workers';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-verify-'));
  const wDir = path.join(tmp, 'workers');
  fs.mkdirSync(path.join(wDir, 'with-hint'), { recursive: true });
  fs.mkdirSync(path.join(wDir, 'no-hint'), { recursive: true });
  fs.mkdirSync(path.join(wDir, 'long-role'), { recursive: true });

  fs.writeFileSync(path.join(wDir, 'with-hint', 'personality.md'),
    '# with-hint\n\n## Role\nIgnored when hint present\n\n## Soul\nx\n\n## Instructions\ny\n');
  fs.writeFileSync(path.join(wDir, 'with-hint', 'config.json'),
    JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [], dispatchHint: '  Reviews PRs  ' }));

  fs.writeFileSync(path.join(wDir, 'no-hint', 'personality.md'),
    '# no-hint\n\n## Role\nDesigns systems\nMore detail on next line\n\n## Soul\nx\n');
  fs.writeFileSync(path.join(wDir, 'no-hint', 'config.json'),
    JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));

  const longRole = 'A'.repeat(200);
  fs.writeFileSync(path.join(wDir, 'long-role', 'personality.md'),
    `# long-role\n\n## Role\n${longRole}\n`);
  fs.writeFileSync(path.join(wDir, 'long-role', 'config.json'),
    JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));

  const wm = new WorkerManager(wDir);
  await wm.loadWorkers();

  assert.strictEqual(wm.getDispatchHint('with-hint'), 'Reviews PRs', 'trims and uses dispatchHint');
  assert.strictEqual(wm.getDispatchHint('no-hint'), 'Designs systems', 'falls back to role first line');
  const long = wm.getDispatchHint('long-role');
  assert.strictEqual(long.length, 120, 'truncates long role to 120 chars');
  assert.ok(long.endsWith('...'), 'truncated value ends with ellipsis');
  assert.strictEqual(wm.getDispatchHint('missing'), '', 'unknown worker returns empty string');

  console.log('OK workers-dispatch-hint');
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Run verify**

Run: `npx ts-node scripts/verify/workers-dispatch-hint.ts`
Expected: prints `OK workers-dispatch-hint`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workers.ts scripts/verify/workers-dispatch-hint.ts
git commit -m "feat(workers): add getDispatchHint with role fallback and 120-char cap"
```

---

## Task 3: WorkspaceManager — normalize team config

**Files:**
- Modify: `packages/core/src/workspace.ts:24` (teams Map type)
- Modify: `packages/core/src/workspace.ts:78-92` (load → normalize)
- Modify: `packages/core/src/workspace.ts:201-213` (getTeam, listTeams)
- Modify: `packages/core/src/workspace.ts:216-233` (setTeams, getTeams)
- Create: `scripts/verify/workspace-team-normalize.ts`

- [ ] **Step 1: Change teams Map to hold normalized `TeamConfig`**

In `packages/core/src/workspace.ts`, change the field declaration on line 24:

```ts
  private teams: Map<string, TeamConfig> = new Map();
```

(Add `TeamConfig`, `TeamConfigRaw`, `TeamDispatchMode` to the export list — they're declared at the top of this file in Task 1.)

- [ ] **Step 2: Normalize during load**

Replace the team-parsing block in `load()` (lines 78–92) with:

```ts
    // Parse + validate teams against the global worker library. Accept legacy
    // string[] form (= dispatch:'all') and the object form { members, dispatch }.
    this.teams.clear();
    const rawTeams = this.config?.teams || {};
    for (const [teamName, raw] of Object.entries(rawTeams)) {
      const normalized = this.normalizeTeam(teamName, raw);
      if (normalized) this.teams.set(teamName.toLowerCase(), normalized);
    }
```

Then add the helper method on the `WorkspaceManager` class (place it just below `load`):

```ts
  private normalizeTeam(name: string, raw: TeamConfigRaw): TeamConfig | null {
    let members: string[];
    let dispatch: TeamDispatchMode = 'all';

    if (Array.isArray(raw)) {
      members = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray(raw.members)) {
      members = raw.members;
      if (raw.dispatch === 'auto' || raw.dispatch === 'all') dispatch = raw.dispatch;
      else if (raw.dispatch !== undefined) {
        this.logger.warn(`[Workspace] Team "${name}" has invalid dispatch="${raw.dispatch}" — defaulting to "all"`);
      }
    } else {
      this.logger.error(`[Workspace] Team "${name}" has invalid shape — skipping`);
      return null;
    }

    const unknown = members.filter(m => !this.workerManager.hasWorker(m));
    if (unknown.length > 0) {
      this.logger.error(`[Workspace] Team "${name}" references unknown workers: ${unknown.join(', ')} — skipping`);
      return null;
    }
    return { members, dispatch };
  }
```

- [ ] **Step 3: Update `getTeam`, `listTeams`, `getTeams`, `setTeams`**

Replace lines 201–233 with:

```ts
  getTeam(name: string): TeamConfig | undefined {
    return this.teams.get(name.toLowerCase());
  }

  getTeamNames(): string[] {
    return Array.from(this.teams.keys());
  }

  listTeams(): string {
    if (this.teams.size === 0) return 'No teams declared for this workspace.';
    return Array.from(this.teams.entries())
      .map(([name, t]) => {
        const mode = t.dispatch === 'auto' ? ' [auto]' : '';
        return `• **${name}**${mode} → ${t.members.join(' → ')}`;
      })
      .join('\n');
  }

  async setTeams(teams: Record<string, TeamConfigRaw>): Promise<void> {
    this.teams.clear();
    for (const [name, raw] of Object.entries(teams)) {
      const normalized = this.normalizeTeam(name, raw);
      if (normalized) this.teams.set(name.toLowerCase(), normalized);
    }
    const configPath = this.getConfigPath();
    const existing = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
    existing.teams = teams;
    await fs.promises.writeFile(configPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  /** Returns the raw team configs as they were last persisted to disk. */
  getTeams(): Record<string, TeamConfigRaw> {
    const result: Record<string, TeamConfigRaw> = {};
    for (const [name, t] of this.teams.entries()) {
      // Round-trip back to the most compact form: legacy string[] when default dispatch, else object.
      result[name] = t.dispatch === 'all' ? t.members : { members: t.members, dispatch: t.dispatch };
    }
    return result;
  }
```

- [ ] **Step 4: Verify script**

Create `scripts/verify/workspace-team-normalize.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import { WorkerManager } from '../../packages/core/src/workers';
import { WorkspaceManager } from '../../packages/core/src/workspace';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-verify-'));
  const workersDir = path.join(tmp, 'workers');
  const workspacesDir = path.join(tmp, 'workspaces');
  fs.mkdirSync(path.join(workersDir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(workersDir, 'b'), { recursive: true });
  for (const n of ['a', 'b']) {
    fs.writeFileSync(path.join(workersDir, n, 'personality.md'), `# ${n}\n\n## Role\nrole-${n}\n`);
    fs.writeFileSync(path.join(workersDir, n, 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));
  }

  fs.mkdirSync(path.join(workspacesDir, 'ws'), { recursive: true });
  fs.writeFileSync(path.join(workspacesDir, 'ws', 'workspace.json'), JSON.stringify({
    workingDir: '/tmp',
    teams: {
      legacy: ['a', 'b'],
      modern: { members: ['a'], dispatch: 'auto' },
      explicit_all: { members: ['a', 'b'], dispatch: 'all' },
      bad_dispatch: { members: ['a'], dispatch: 'parallel' },
    },
  }));

  const wm = new WorkerManager(workersDir);
  await wm.loadWorkers();
  const ws = new WorkspaceManager(wm, workspacesDir);
  await ws.switchWorkspace('ws');

  assert.deepStrictEqual(ws.getTeam('legacy'), { members: ['a', 'b'], dispatch: 'all' }, 'legacy → all');
  assert.deepStrictEqual(ws.getTeam('modern'), { members: ['a'], dispatch: 'auto' }, 'modern preserved');
  assert.deepStrictEqual(ws.getTeam('explicit_all'), { members: ['a', 'b'], dispatch: 'all' }, 'explicit all');
  assert.deepStrictEqual(ws.getTeam('bad_dispatch'), { members: ['a'], dispatch: 'all' }, 'invalid dispatch falls back to all');

  const list = ws.listTeams();
  assert.ok(list.includes('**modern** [auto]'), 'list shows [auto] tag');
  assert.ok(list.includes('**legacy** →'), 'list omits tag for default mode');

  console.log('OK workspace-team-normalize');
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Run verify**

Run: `npx ts-node scripts/verify/workspace-team-normalize.ts`
Expected: prints `OK workspace-team-normalize`.

- [ ] **Step 6: Build whole repo (catches downstream type errors)**

Run: `npm run build`
Expected: PASS. (Gateway code calling `getTeam` will now see `TeamConfig` instead of `string[]` — fix call sites in Task 5.)

If build fails on `gateway.ts` because it iterates `members` directly on the old return type, that is **expected**; defer to Task 5. To unblock the build now, leave the build error and proceed to Task 5 in the same session. If working in subagent mode, mark this task done despite the gateway type error and pass that fact to the next task.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/workspace.ts scripts/verify/workspace-team-normalize.ts
git commit -m "feat(workspace): normalize team config to {members, dispatch}"
```

---

## Task 4: Dispatcher module

**Files:**
- Create: `packages/core/src/dispatcher-personality.ts`
- Create: `packages/core/src/dispatcher.ts`
- Modify: `packages/core/src/index.ts` (export new modules)
- Create: `scripts/verify/dispatcher-parse.ts`

- [ ] **Step 1: Hard-coded personality**

Create `packages/core/src/dispatcher-personality.ts`:

```ts
/**
 * Built-in personality used when running the auto-dispatcher. Not user-editable.
 * Kept short on purpose — the dispatcher is a routing role, not a coder.
 */
export const DISPATCHER_PERSONALITY = {
  role: 'Task router that selects the subset of workers needed for a task.',
  instructions: [
    'You are a task router for a team of specialized workers.',
    'Given a TASK and a list of WORKERS (each with a one-line hint),',
    'select the SUBSET that should handle this task.',
    '',
    'Rules:',
    '- Preserve the input order of names. Do not reorder.',
    '- If you are unsure whether a worker is needed, INCLUDE it.',
    '- Never invent worker names; only use names from the provided list.',
    '- Output JSON ONLY, no prose, no markdown fences.',
    '',
    'Output schema:',
    '{"selected": ["name", ...], "reason": "<one short sentence>"}',
  ].join('\n'),
};
```

- [ ] **Step 2: Dispatcher module skeleton + types + prompt builder**

Create `packages/core/src/dispatcher.ts`:

```ts
import { AgentRequest, AgentResponse, CodingAgent, ModelConfig } from './types';
import { DISPATCHER_PERSONALITY } from './dispatcher-personality';

export interface DispatchMember {
  name: string;
  hint: string;
}

export interface DispatchInput {
  task: string;
  members: DispatchMember[];
}

export interface DispatchResult {
  /** Subset of input member names, sorted to match members' input order. */
  selected: string[];
  /** One-sentence explanation surfaced to the user. */
  reason: string;
  /** True when dispatcher failed and the caller should run all members. */
  fallback: boolean;
  /** Optional human-readable detail about the fallback cause. */
  fallbackReason?: string;
}

export type DispatcherRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface DispatcherOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: DispatcherRunner;
  /** Hard timeout in ms. Default 30_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildDispatcherPrompt(input: DispatchInput): string {
  const lines: string[] = [];
  lines.push('# Dispatcher');
  lines.push('## Role');
  lines.push(DISPATCHER_PERSONALITY.role);
  lines.push('## Instructions');
  lines.push(DISPATCHER_PERSONALITY.instructions);
  lines.push('## Task');
  lines.push(input.task);
  lines.push('## Workers');
  for (const m of input.members) {
    lines.push(`- ${m.name}: ${m.hint || '(no description)'}`);
  }
  return lines.join('\n\n');
}

/**
 * Extract the first balanced {...} object from a string and JSON.parse it.
 * Tolerates leading/trailing prose, markdown fences, and nested objects.
 * Returns null if no parseable object is found.
 */
export function extractJsonObject(text: string): unknown | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}
```

- [ ] **Step 3: Implement `runDispatcher`**

Append to `packages/core/src/dispatcher.ts`:

```ts
function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every(x => typeof x === 'string')) return null;
  return v as string[];
}

export async function runDispatcher(
  input: DispatchInput,
  opts: DispatcherOptions,
): Promise<DispatchResult> {
  const memberNames = input.members.map(m => m.name);
  const allFallback = (reason: string): DispatchResult => ({
    selected: memberNames,
    reason: '',
    fallback: true,
    fallbackReason: reason,
  });

  if (input.members.length === 0) {
    return { selected: [], reason: '', fallback: false };
  }

  const prompt = buildDispatcherPrompt(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Compose AbortSignal that fires on either user signal or our timeout.
  const ac = new AbortController();
  const onUserAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response: AgentResponse;
  try {
    response = await opts.runner({
      prompt,
      agent: opts.agent,
      model: opts.model,
      signal: ac.signal,
    });
  } catch (err) {
    return allFallback(`runner threw: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort);
  }

  if (!response.success) {
    return allFallback(response.error || 'runner returned non-success');
  }

  const obj = extractJsonObject(response.output) as { selected?: unknown; reason?: unknown } | null;
  if (!obj) return allFallback('no JSON object in dispatcher output');

  const selectedRaw = asStringArray(obj.selected);
  if (!selectedRaw) return allFallback('selected is not a string array');

  // Filter unknown names; preserve input order.
  const known = new Set(memberNames);
  const filtered = selectedRaw.filter(n => known.has(n));
  if (filtered.length === 0) return allFallback('selection empty after filtering unknowns');

  // Reorder to match input order so callers' carry-chain semantics are preserved.
  const indexOf = new Map(memberNames.map((n, i) => [n, i]));
  const ordered = Array.from(new Set(filtered)).sort(
    (a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0),
  );

  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  return { selected: ordered, reason, fallback: false };
}
```

- [ ] **Step 4: Re-export from core barrel**

In `packages/core/src/index.ts`, add:

```ts
export * from './dispatcher';
export * from './dispatcher-personality';
```

- [ ] **Step 5: Verify script**

Create `scripts/verify/dispatcher-parse.ts`:

```ts
import * as assert from 'assert';
import { AgentRequest, AgentResponse } from '../../packages/core/src/types';
import { runDispatcher, extractJsonObject, buildDispatcherPrompt } from '../../packages/core/src/dispatcher';

function makeRunner(output: string, success = true): (r: AgentRequest) => Promise<AgentResponse> {
  return async () => ({ success, output, error: success ? undefined : output });
}

async function main() {
  const members = [
    { name: 'architect', hint: 'designs systems' },
    { name: 'frontend',  hint: 'builds UI' },
    { name: 'reviewer',  hint: 'audits code' },
  ];

  // 1. Happy path: pure JSON
  let r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":["frontend","reviewer"],"reason":"UI change"}') });
  assert.deepStrictEqual(r.selected, ['frontend', 'reviewer']);
  assert.strictEqual(r.fallback, false);
  assert.strictEqual(r.reason, 'UI change');

  // 2. Reorder to input order
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":["reviewer","architect"],"reason":""}') });
  assert.deepStrictEqual(r.selected, ['architect', 'reviewer'], 'reorder to input order');

  // 3. Markdown-wrapped JSON
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('Sure, here:\n```json\n{"selected":["architect"],"reason":"x"}\n```\n') });
  assert.deepStrictEqual(r.selected, ['architect']);
  assert.strictEqual(r.fallback, false);

  // 4. Filter unknown names
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":["frontend","ghost"],"reason":""}') });
  assert.deepStrictEqual(r.selected, ['frontend']);
  assert.strictEqual(r.fallback, false);

  // 5. Empty selection → fallback (all members)
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":[],"reason":""}') });
  assert.strictEqual(r.fallback, true);
  assert.deepStrictEqual(r.selected, ['architect', 'frontend', 'reviewer']);

  // 6. Non-JSON → fallback
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('I cannot do that') });
  assert.strictEqual(r.fallback, true);

  // 7. Runner non-success → fallback
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('boom', false) });
  assert.strictEqual(r.fallback, true);

  // 8. extractJsonObject edge cases
  assert.deepStrictEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(extractJsonObject('noise {"a":{"b":2}} more'), { a: { b: 2 } });
  assert.strictEqual(extractJsonObject(''), null);
  assert.strictEqual(extractJsonObject('no braces here'), null);
  assert.strictEqual(extractJsonObject('{ broken'), null);

  // 9. Prompt builder includes role + member lines
  const prompt = buildDispatcherPrompt({ task: 'do thing', members });
  assert.ok(prompt.includes('Task router'));
  assert.ok(prompt.includes('do thing'));
  assert.ok(prompt.includes('- architect: designs systems'));

  console.log('OK dispatcher-parse');
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Run verify**

Run: `npx ts-node scripts/verify/dispatcher-parse.ts`
Expected: prints `OK dispatcher-parse`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/dispatcher.ts packages/core/src/dispatcher-personality.ts packages/core/src/index.ts scripts/verify/dispatcher-parse.ts
git commit -m "feat(core): add runDispatcher with JSON-tolerant parsing and fallback semantics"
```

---

## Task 5: Gateway integration

**Files:**
- Modify: `packages/gateway/src/gateway.ts:62-63` (REGEX_TEAM)
- Modify: `packages/gateway/src/gateway.ts:1301-1380` (runTeamTask)
- Modify: `packages/gateway/src/gateway.ts:1382-1419` (runTeamForChat)
- Modify: `packages/gateway/src/gateway.ts` (where `parseCommand` builds team args — find via REGEX_TEAM usage)

- [ ] **Step 1: Extend `REGEX_TEAM` to parse `--all` flag**

Replace line 63 with:

```ts
  private static readonly REGEX_TEAM = /\/team\s+(\w+)(?:\s+(--all))?\s+(.+)/i;
```

Find every match of `REGEX_TEAM` in `gateway.ts` (use grep). At each call site that destructures the match, add the optional flag capture and pass `forceAll` through to `runTeamTask` / `runTeamForChat`. Example pattern:

```ts
const m = text.match(Gateway.REGEX_TEAM);
if (m) {
  const [, teamName, allFlag, taskText] = m;
  const forceAll = allFlag === '--all';
  await this.runTeamTask(message, teamName, taskText, { forceAll });
}
```

If `parseCommand` builds a different shape (the existing code splits args via a generic helper), preserve the existing helper but capture `--all` separately and route it through.

- [ ] **Step 2: Add a private helper to resolve dispatcher agent + model**

In the `Gateway` class, near `getDefaultAgent`, add:

```ts
  private getDispatcherAgentAndModel(): { agent: CodingAgent; model?: ModelConfig } {
    const cfg = this.config.dispatcher;
    const agent = (cfg?.agent as CodingAgent | undefined) ?? this.getDefaultAgent();
    const modelName = cfg?.model;
    const model = modelName ? this.getModelConfig(agent, modelName) : this.getDefaultModelConfig(agent);
    return { agent, model };
  }
```

- [ ] **Step 3: Add a thin runner adapter that wraps `runWithFallback`**

Inside the `Gateway` class, add:

```ts
  private dispatcherRunner = (req: AgentRequest): Promise<AgentResponse> => {
    return this.runWithFallback(req.agent, req);
  };
```

- [ ] **Step 4: Update `runTeamTask` to consume `TeamConfig` + dispatch**

Replace the body of `runTeamTask` (existing lines 1301–1380). New version:

```ts
  private async runTeamTask(
    message: UserMessage,
    teamName: string,
    task: string,
    opts: { forceAll?: boolean } = {},
  ): Promise<void> {
    const { chatId, channel } = message;

    if (!teamName || !task.trim()) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId, channel,
        text: `Usage: /team <name> [--all] <task>\n\nTeams on this workspace:\n${teamList}`,
      });
      return;
    }

    const team = this.workspaceManager.getTeam(teamName);
    if (!team) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId, channel,
        text: `Team "${teamName}" not found on workspace "${this.workspaceManager.getCurrentWorkspace()}".\n\nAvailable teams:\n${teamList}`,
      });
      return;
    }

    const workerManager = this.workspaceManager.getWorkerManager();
    const { members, dispatch } = team;
    let runMembers = members;
    let dispatchInfo: DispatchResult | null = null;

    if (dispatch === 'auto' && !opts.forceAll) {
      const { agent: dAgent, model: dModel } = this.getDispatcherAgentAndModel();
      dispatchInfo = await runDispatcher(
        {
          task,
          members: members.map(name => ({ name, hint: workerManager.getDispatchHint(name) })),
        },
        { agent: dAgent, model: dModel, runner: this.dispatcherRunner },
      );
      if (!dispatchInfo.fallback) runMembers = dispatchInfo.selected;
    }

    // Header line — separates "all", "auto-success", "auto-fallback".
    let header: string;
    if (dispatch === 'auto' && dispatchInfo && !dispatchInfo.fallback) {
      const skipped = members.filter(m => !runMembers.includes(m));
      header =
        `🧭 Dispatched **${teamName}**: ${runMembers.join(' → ')}` +
        (skipped.length ? ` (skipped: ${skipped.join(', ')})` : '') +
        (dispatchInfo.reason ? `\nReason: ${dispatchInfo.reason}` : '');
    } else if (dispatch === 'auto' && dispatchInfo && dispatchInfo.fallback) {
      header =
        `⚠️ Auto-dispatch failed (${dispatchInfo.fallbackReason ?? 'unknown'}), running all members.\n` +
        `👥 Running team **${teamName}** (${runMembers.join(' → ')})`;
    } else {
      header = `👥 Running team **${teamName}** (${runMembers.join(' → ')})`;
    }
    await this.sendResponse({
      chatId, channel,
      text: `${header}\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    let currentTask = task;
    const results: string[] = [];

    for (const memberName of runMembers) {
      const worker = workerManager.getWorker(memberName);
      if (!worker) {
        results.push(`**${memberName}**: ❌ not found in global library`);
        break;
      }

      const codingAgent = workerManager.getWorkerCodingAgent(memberName) as CodingAgent;
      const model = workerManager.getWorkerModel(memberName);

      await this.sendResponse({ chatId, channel, text: `🔄 Worker **${worker.name}** is working...` });

      const prompt = workerManager.buildWorkerPrompt(memberName, currentTask);
      const modelConfig = this.getModelConfig(codingAgent, model);
      const handler = this.handlers.get(channel);
      const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;

      const response = await this.runWithFallback(codingAgent, {
        prompt, agent: codingAgent, model: modelConfig,
        interactive: this.tuiMode, onStream, context: { workingDir: this.workingDir },
      });

      if (response.success) {
        results.push(`**${worker.name}**: ${response.output.substring(0, 500)}`);
        currentTask = `Previous worker output:\n${response.output}\n\nYour task: ${task}`;
      } else {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        break;
      }
    }

    await this.sendResponse({
      chatId, channel,
      text: `📊 Team **${teamName}** results\n\n${results.join('\n\n')}`,
    });
  }
```

Add the imports at the top of `gateway.ts`:

```ts
import { runDispatcher, DispatchResult } from '@codey/core';
```

- [ ] **Step 5: Update `runTeamForChat` analogously**

Replace the body of `runTeamForChat` (existing lines 1382–1419):

```ts
  private async runTeamForChat(
    teamName: string,
    team: { members: string[]; dispatch: 'all' | 'auto' },
    prompt: string,
    workingDir: string,
    sink: ChatStreamSink,
    chatId: string,
    signal?: AbortSignal,
    opts: { forceAll?: boolean } = {},
  ): Promise<{ response: string; tokens?: number }> {
    if (!team || !team.members || team.members.length === 0) {
      throw new Error(`Team not found or empty: ${teamName}`);
    }
    const workerManager = this.workspaceManager.getWorkerManager();

    let runMembers = team.members;
    let dispatchInfo: DispatchResult | null = null;
    if (team.dispatch === 'auto' && !opts.forceAll) {
      const { agent: dAgent, model: dModel } = this.getDispatcherAgentAndModel();
      dispatchInfo = await runDispatcher(
        {
          task: prompt,
          members: team.members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
        },
        { agent: dAgent, model: dModel, runner: this.dispatcherRunner, signal },
      );
      if (!dispatchInfo.fallback) runMembers = dispatchInfo.selected;
      if (dispatchInfo.fallback) {
        sink({ type: 'info', chatId, message: `Auto-dispatch failed (${dispatchInfo.fallbackReason ?? 'unknown'}), running all members` });
      } else {
        const skipped = team.members.filter(m => !runMembers.includes(m));
        sink({ type: 'info', chatId, message: `Dispatched ${runMembers.join(' → ')}` + (skipped.length ? ` (skipped: ${skipped.join(', ')})` : '') });
      }
    }

    let carry = prompt;
    const parts: string[] = [];
    for (let i = 0; i < runMembers.length; i++) {
      if (signal?.aborted) break;
      const memberName = runMembers[i];
      sink({ type: 'info', chatId, message: `Step ${i + 1}/${runMembers.length}: ${memberName}` });
      const stepPrompt = workerManager.buildWorkerPrompt(memberName, carry);
      const codingAgent = (workerManager.getWorkerCodingAgent(memberName) ?? this.getDefaultAgent()) as CodingAgent;
      const workerModel = workerManager.getWorkerModel(memberName);
      const modelConfig = this.getModelConfig(codingAgent, workerModel);
      const response = await this.runWithFallback(codingAgent, {
        prompt: stepPrompt, agent: codingAgent, model: modelConfig,
        context: { workingDir },
        onStream: (text: string) => sink({ type: 'stream', chatId, token: text }),
        onStatus: (_update: any) => { /* status forwarded via sink elsewhere */ },
        signal,
      });
      const output = response?.success ? this.formatAgentResponse(response) : '';
      parts.push(`### ${memberName}\n\n${output}`);
      carry = output;
    }
    return { response: parts.join('\n\n---\n\n') };
  }
```

- [ ] **Step 6: Update `runTeamForChat` callers**

Search `gateway.ts` for `runTeamForChat(` calls. The previous signature took `members: string[]`; now it takes `team: TeamConfig`. Each caller already has access to a team — replace `members` argument with `team` (the full `TeamConfig` object returned by `getTeam`). If a caller currently dereferences a `string[]` from `getTeam`, change it to use the object form.

- [ ] **Step 7: Update help text**

Locate the `/help` block (around line 1138 — `gateway.ts:1141-1142`). Change:

```
/team <name> <task> - Run a named team in sequence
```

to:

```
/team <name> [--all] <task> - Run a team. Use --all to bypass auto-dispatch when team mode is "auto".
```

Also update the inline usage strings (around line 798 and line 1309) similarly.

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): wire auto-dispatch into /team with --all override"
```

---

## Task 6: Persistable dispatcher config + example update

**Files:**
- Modify: `packages/gateway/src/config.ts` (loadConfig + normalize)
- Modify: `gateway.json.example`

- [ ] **Step 1: Read normalize/loadConfig flow**

Open `packages/gateway/src/config.ts`. Read `loadConfig` (line 58 area) and `normalize` (line 350 area). Locate where unknown top-level fields from disk are handled.

- [ ] **Step 2: Pass `dispatcher` through normalize**

In `normalize(raw)`, after the existing field assignments and before the `return`, add:

```ts
  if (raw.dispatcher && typeof raw.dispatcher === 'object') {
    out.dispatcher = {
      agent: raw.dispatcher.agent,
      model: raw.dispatcher.model,
    };
  }
```

(Use the existing `out` accumulator name — adjust the variable name to match what `normalize` uses.)

- [ ] **Step 3: Surface to GatewayConfig**

Find the function that converts `GatewayConfigJson` → `GatewayConfig` (the runtime shape) — typically at the bottom of `config.ts` or in the gateway constructor. Add a one-line copy of the `dispatcher` block.

If no such conversion exists and gateway reads `GatewayConfigJson` directly, no conversion edit is needed — the typed field added in Task 1 is enough.

- [ ] **Step 4: Update `gateway.json.example`**

Append to the example (before the closing brace, after the `dev` block):

```json
,
  "dispatcher": {
    "agent": "claude-code",
    "model": "claude-haiku-4-5"
  }
```

(Adjust comma placement to match existing trailing-comma style of the file.)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config.ts gateway.json.example
git commit -m "feat(config): persist optional dispatcher.{agent,model} block"
```

---

## Task 7: Manual test checklist + README

**Files:**
- Create: `scripts/test-dispatcher.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Manual test checklist**

Create `scripts/test-dispatcher.md` with the exact content:

```md
# Auto-Dispatch Manual Test Checklist

Project has no test runner; this is the canonical verification surface.

Setup:
- Two workers in `./workers/`: `architect` (role "designs systems"), `reviewer` (role "audits code").
- Workspace `./workspaces/test/workspace.json` with:

  ```json
  {
    "workingDir": "/tmp/scratch",
    "teams": {
      "legacy": ["architect", "reviewer"],
      "auto":   { "members": ["architect", "reviewer"], "dispatch": "auto" }
    }
  }
  ```

Run `npm run dev`, switch to workspace `test`, then:

1. **Legacy format unchanged.** `/team legacy refactor module X` → both workers run, sequential carry chain, no dispatcher invocation.
2. **`dispatch: 'all'` explicit.** Edit team to `{ "members": [...], "dispatch": "all" }`, repeat command, same behavior as 1.
3. **`dispatch: 'auto'` happy path.** `/team auto fix typo in README` → header shows `🧭 Dispatched auto: reviewer (skipped: architect)` (or similar — exact selection depends on the dispatcher model). UI prints `Reason:` line.
4. **Auto fallback on bad model.** Set `gateway.json` `dispatcher.model` to a non-existent name. Repeat command. Header shows `⚠️ Auto-dispatch failed (...), running all members.` followed by full-team execution.
5. **`--all` flag overrides.** With dispatch:'auto' team, run `/team auto --all do task` → no dispatcher invoked, full team runs.
6. **Unknown name filter.** Stub the dispatcher response (use a local Ollama with a prompt that always emits `{"selected":["ghost"], "reason":""}`); confirm header says `⚠️ Auto-dispatch failed (selection empty after filtering unknowns)`.

Each item should produce an obviously visible header difference and a sane `📊 Team results` summary.
```

- [ ] **Step 2: Update `README.md`**

Find the `/team` documentation in `README.md`. Replace the `/team <name> <task>` description with:

```
- `/team <name> [--all] <task>` — Run a named team. Members run sequentially with carry chain.
  - Teams default to `dispatch: 'all'` (every member runs).
  - Teams configured with `dispatch: 'auto'` first invoke a built-in dispatcher
    that selects the relevant subset; pass `--all` to bypass it for one call.
  - Optional `dispatchHint` on each worker's `config.json` improves routing accuracy.
  - Dispatcher agent/model is configured under `gateway.json` `dispatcher.{agent,model}`,
    defaulting to the gateway's default agent/model.
```

(If the README structure differs, locate the closest analogous section and add the same content.)

- [ ] **Step 3: Update `README.zh-CN.md`**

Locate the corresponding Chinese description and translate the same block.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-dispatcher.md README.md README.zh-CN.md
git commit -m "docs: document /team auto-dispatch and --all flag"
```

---

## Task 8: codey-mac UI — dispatcher settings panel

**Files:** TBD by exploration — the codey-mac sub-app lives under `codey-mac/` with its own settings UI. The agent doing this task should:

- [ ] **Step 1: Locate the settings panel that already manages models / agents**

Grep `codey-mac/` for the existing "Default Agent" or "Default Model" settings component. That same component is the right place to add the new section.

- [ ] **Step 2: Add a "Dispatcher (Auto Mode)" section**

The section contains two dropdowns:
- **Agent** — populated from the same agent list shown elsewhere (claude-code / opencode / codex).
- **Model** — populated from the global model catalog already used by other dropdowns. Filter by the selected agent's compatible models if the existing UI does so for other dropdowns.

Both dropdowns include a "Use default" sentinel that maps to leaving the corresponding field unset.

- [ ] **Step 3: Wire to gateway config**

Selections persist to `gateway.json` `dispatcher.{agent,model}` via the same RPC path the existing settings panel uses to write to `gateway.json`. When both dropdowns are "Use default", the `dispatcher` block is removed from JSON to keep the file minimal.

- [ ] **Step 4: Smoke-test in codey-mac**

Open the app, change dispatcher model, confirm `gateway.json` updates and the gateway picks up the new value (restart if hot-reload not wired). Run a `/team` with `dispatch: 'auto'` and confirm dispatcher invokes the chosen model (visible in gateway logs).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/<paths>
git commit -m "feat(codey-mac): add dispatcher settings panel"
```

---

## Self-Review Notes

Spec coverage check:

| Spec section | Implementing task |
|---|---|
| Worker `dispatchHint` field | Task 1 (schema), Task 2 (accessor + persist) |
| Team config `string[] \| {members,dispatch}` | Task 1 (types), Task 3 (loader normalize) |
| Built-in dispatcher personality | Task 4 (`dispatcher-personality.ts`) |
| `runDispatcher` with JSON-tolerant parsing | Task 4 |
| Failure modes → fallback | Task 4 (per failure-mode table) |
| Pre-step in `runTeamTask` / `runTeamForChat` | Task 5 |
| `--all` flag | Task 5 (REGEX, callers, help text) |
| User-visible dispatch header / fallback warning | Task 5 |
| `gateway.json` `dispatcher.{agent,model}` | Task 1 (types), Task 6 (loader + example) |
| codey-mac settings UI | Task 8 |
| Manual test checklist | Task 7 |
| README updates | Task 7 |

Type-name consistency check (cross-task):

- `TeamConfig` (Task 1) → consumed by Task 3, 5 ✓
- `TeamConfigRaw` (Task 1) → consumed by Task 3 (`setTeams`, `getTeams`) ✓
- `DispatchResult.fallback` / `.fallbackReason` (Task 4) → consumed by Task 5 header logic ✓
- `WorkerConfig.dispatchHint` (Task 1) → consumed by Task 2 (`getDispatchHint`) ✓
- `GatewayConfig.dispatcher` (Task 1) → consumed by Task 5 (`getDispatcherAgentAndModel`), persisted in Task 6 ✓

YAGNI check: Plan does not implement parallel/discussion modes, DAG, dispatcher caching, multi-team concurrency, user-editable dispatcher personality, or local inference engine — matches spec's "Out of Scope" list.
