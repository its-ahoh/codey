# Team Parallel Mode (Roundtable) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `parallel` dispatch mode for teams that runs all workers concurrently as a Manager-moderated roundtable, communicating via shared opinion/summary/control files on disk.

**Architecture:** Each `/team <parallel-team> <topic>` creates a Chat-linked discussion directory under `workspaces/<ws>/chats/<chatId>/discussion/`. Workers run as long-lived agent sessions in parallel via `Promise.all`, polling a shared `control.md` for status. A separate Manager loop (LLM-driven, triggered by `fs.watch` + 30s heartbeat) maintains `summary.md`, decides continuation/escalation/termination, and arbitrates `[ASK_MANAGER]` markers. Three exit gates: Manager judgment, max-duration supervisor, idle-timeout supervisor.

**Tech Stack:** TypeScript (strict, CommonJS), `fs.promises`, `fs.watch`, `Promise.all`, `AbortController`. Tests use vitest (matches `packages/gateway/vitest.config.ts`).

**Spec:** [docs/superpowers/specs/2026-05-24-team-parallel-mode-design.md](../specs/2026-05-24-team-parallel-mode-design.md)

---

## File Structure

**New files:**

- `packages/core/src/discussion/control.ts` — control.md parser/serializer + revision-aware reader
- `packages/core/src/discussion/control.test.ts`
- `packages/core/src/discussion/files.ts` — discussion directory layout + create/destroy/list helpers
- `packages/core/src/discussion/files.test.ts`
- `packages/core/src/discussion/parallel-advisor.ts` — Manager prompt builder + JSON parser for parallel mode
- `packages/core/src/discussion/parallel-advisor.test.ts`
- `packages/gateway/src/parallel-team.ts` — orchestrator (worker loops + Manager loop + supervisor)
- `packages/gateway/src/parallel-team.test.ts`

**Modified files:**

- `packages/core/src/workspace.ts` — accept `dispatch: 'parallel'` + optional `parallel: {…}` settings
- `packages/core/src/types/chat.ts` — add `Chat.discussion?: DiscussionMeta`
- `packages/core/src/workers.ts` — add `buildParallelWorkerPrompt(...)`
- `packages/gateway/src/chats.ts` — delete discussion dir on chat delete
- `packages/gateway/src/gateway.ts` — route `dispatch: 'parallel'` to new runner
- `packages/gateway/src/chat-runner.ts` — detect resume into completed discussion chat
- `packages/core/src/index.ts` + `packages/gateway/src/index.ts` — re-export new public symbols

---

## Conventions

- Every code change is TDD: failing test first, then implementation.
- Build check: `npm run build` from repo root after each task.
- Test runner: `npm test --workspace=@codey/core` and `npm test --workspace=@codey/gateway` (run only the affected workspace per task to keep cycles short).
- Commit per task with conventional-commit style: `feat(parallel-team): …`, `test(parallel-team): …`, `refactor: …`.

---

## Task 1: Extend team config schema for `parallel` dispatch

**Files:**
- Modify: `packages/core/src/workspace.ts` (lines 13–22 and 154–177)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/workspace.test.ts` (create the file if it does not exist; mirror the imports/setup used elsewhere — see `advisor.test.ts` for a vitest example):

```ts
import { describe, it, expect } from 'vitest';
import { WorkspaceManager } from './workspace';
import { WorkerManager } from './workers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('WorkspaceManager parallel team config', () => {
  it('normalizes dispatch: "parallel" with default parallel settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-parallel-'));
    const wsDir = path.join(root, 'workspaces');
    const workersDir = path.join(root, 'workers');
    fs.mkdirSync(path.join(wsDir, 'demo'), { recursive: true });
    fs.mkdirSync(path.join(workersDir, 'a'), { recursive: true });
    fs.mkdirSync(path.join(workersDir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(workersDir, 'a', 'personality.md'), '## Role\nA\n');
    fs.writeFileSync(path.join(workersDir, 'a', 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));
    fs.writeFileSync(path.join(workersDir, 'b', 'personality.md'), '## Role\nB\n');
    fs.writeFileSync(path.join(workersDir, 'b', 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));
    fs.writeFileSync(
      path.join(wsDir, 'demo', 'workspace.json'),
      JSON.stringify({ workingDir: root, teams: ['rt'] }),
    );

    const workers = new WorkerManager(workersDir);
    await workers.loadWorkers();
    const ws = new WorkspaceManager(workers, wsDir, undefined, () => ({
      rt: { members: ['a', 'b'], dispatch: 'parallel' },
    }));
    await ws.switchWorkspace('demo');

    const team = ws.getTeam('rt');
    expect(team).toBeTruthy();
    expect(team!.dispatch).toBe('parallel');
    expect(team!.parallel).toEqual({
      maxDurationMs: 600_000,
      idleTimeoutMs: 60_000,
      managerPollMs: 30_000,
    });
  });

  it('preserves explicit parallel settings', async () => {
    // …same setup as above, but pass dispatch: 'parallel' with explicit parallel: { maxDurationMs: 1000, idleTimeoutMs: 200, managerPollMs: 100 }
    // assert all three pass through unchanged.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=@codey/core -- workspace.test
```

Expected: FAIL with `Cannot read properties of undefined (reading 'parallel')` or `dispatch: "all"` (because the current normalizer rejects unknown dispatch values).

- [ ] **Step 3: Update types and normalizer**

In `packages/core/src/workspace.ts`:

```ts
export type TeamDispatchMode = 'all' | 'auto' | 'parallel';

export interface ParallelSettings {
  maxDurationMs: number;
  idleTimeoutMs: number;
  managerPollMs: number;
}

const DEFAULT_PARALLEL_SETTINGS: ParallelSettings = {
  maxDurationMs: 600_000,
  idleTimeoutMs: 60_000,
  managerPollMs: 30_000,
};

export type TeamConfigRaw =
  | string[]
  | {
      members: string[];
      dispatch?: TeamDispatchMode;
      parallel?: Partial<ParallelSettings>;
    };

export interface TeamConfig {
  members: string[];
  dispatch: TeamDispatchMode;
  /** Only populated when dispatch === 'parallel'. */
  parallel?: ParallelSettings;
}
```

Update `normalizeTeam` to accept `'parallel'` and merge defaults:

```ts
private normalizeTeam(name: string, raw: TeamConfigRaw): TeamConfig | null {
  let members: string[];
  let dispatch: TeamDispatchMode = 'all';
  let parallel: Partial<ParallelSettings> | undefined;

  if (Array.isArray(raw)) {
    members = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.members)) {
    members = raw.members;
    if (raw.dispatch === 'auto' || raw.dispatch === 'all' || raw.dispatch === 'parallel') {
      dispatch = raw.dispatch;
    } else if (raw.dispatch !== undefined) {
      this.logger.warn(`[Workspace] Team "${name}" has invalid dispatch="${raw.dispatch}" — defaulting to "all"`);
    }
    parallel = raw.parallel;
  } else {
    this.logger.error(`[Workspace] Team "${name}" has invalid shape — skipping`);
    return null;
  }

  const unknown = members.filter(m => !this.workerManager.hasWorker(m));
  if (unknown.length > 0) {
    this.logger.error(`[Workspace] Team "${name}" references unknown workers: ${unknown.join(', ')} — skipping`);
    return null;
  }

  const result: TeamConfig = { members, dispatch };
  if (dispatch === 'parallel') {
    result.parallel = { ...DEFAULT_PARALLEL_SETTINGS, ...(parallel ?? {}) };
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test --workspace=@codey/core -- workspace.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workspace.ts packages/core/src/workspace.test.ts
git commit -m "feat(workspace): accept dispatch: 'parallel' with parallel settings"
```

---

## Task 2: Add `Chat.discussion` metadata

**Files:**
- Modify: `packages/core/src/types/chat.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/chats.test.ts`:

```ts
it('persists chat.discussion metadata across save/load', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-disc-'));
  const wsDir = path.join(root, 'workspaces', 'demo');
  fs.mkdirSync(wsDir, { recursive: true });
  const mgr = new ChatManager(path.join(root, 'workspaces'));
  const chat = await mgr.createChat({ workspaceName: 'demo', selection: { type: 'team', name: 'rt' }, title: 't' });
  await mgr.updateChat(chat.id, c => {
    c.discussion = { teamName: 'rt', status: 'running', startedAt: 1, };
    return c;
  });

  const mgr2 = new ChatManager(path.join(root, 'workspaces'));
  const reloaded = mgr2.getChat(chat.id);
  expect(reloaded?.discussion?.teamName).toBe('rt');
  expect(reloaded?.discussion?.status).toBe('running');
});
```

(If `ChatManager` lacks a generic `updateChat` mutator, use whichever existing helper persists chats — check `chats.ts` first; do NOT invent API.)

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=@codey/gateway -- chats.test
```

Expected: FAIL on `c.discussion = …` (property doesn't exist on `Chat`).

- [ ] **Step 3: Add `DiscussionMeta` to `chat.ts`**

In `packages/core/src/types/chat.ts`:

```ts
export type DiscussionStatus = 'running' | 'paused' | 'done' | 'terminated';
export type DiscussionTerminatedReason =
  | 'consensus'
  | 'drift'
  | 'timeout'
  | 'max_duration'
  | 'user_cancel'
  | 'manager_error';

export interface DiscussionMeta {
  teamName: string;
  status: DiscussionStatus;
  startedAt: number;
  terminatedReason?: DiscussionTerminatedReason;
}

export interface Chat {
  // …existing fields…
  discussion?: DiscussionMeta;
}
```

Re-export `DiscussionMeta`, `DiscussionStatus`, `DiscussionTerminatedReason` from `packages/core/src/index.ts`.

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/gateway -- chats.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/chat.ts packages/core/src/index.ts packages/gateway/src/chats.test.ts
git commit -m "feat(chat): add discussion metadata to Chat for parallel teams"
```

---

## Task 3: Discussion file layout helpers

**Files:**
- Create: `packages/core/src/discussion/files.ts`
- Create: `packages/core/src/discussion/files.test.ts`

Purpose: a single module that owns directory paths and create/destroy operations for `workspaces/<ws>/chats/<chatId>/discussion/`. No business logic — pure path + IO helpers.

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/src/discussion/files.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discussionDir,
  opinionPath,
  initDiscussionDir,
  destroyDiscussionDir,
  listOpinionFiles,
} from './files';

describe('discussion files', () => {
  it('returns expected directory paths', () => {
    expect(discussionDir('/ws', 'demo', 'c1')).toBe('/ws/demo/chats/c1/discussion');
    expect(opinionPath('/ws', 'demo', 'c1', 'architect')).toBe('/ws/demo/chats/c1/discussion/opinions/architect.md');
  });

  it('initDiscussionDir creates topic.md, control.md (running), summary.md, transcript.log, opinions/<w>.md', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
    await initDiscussionDir(root, 'demo', 'c1', 'Topic here', ['a', 'b']);
    const dir = discussionDir(root, 'demo', 'c1');
    expect(fs.readFileSync(path.join(dir, 'topic.md'), 'utf-8')).toContain('Topic here');
    expect(fs.readFileSync(path.join(dir, 'control.md'), 'utf-8')).toContain('status: running');
    expect(fs.existsSync(path.join(dir, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'transcript.log'))).toBe(true);
    expect(fs.existsSync(opinionPath(root, 'demo', 'c1', 'a'))).toBe(true);
    expect(fs.existsSync(opinionPath(root, 'demo', 'c1', 'b'))).toBe(true);
  });

  it('listOpinionFiles returns names without .md', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
    await initDiscussionDir(root, 'demo', 'c1', 't', ['a', 'b']);
    expect(await listOpinionFiles(root, 'demo', 'c1')).toEqual(['a', 'b']);
  });

  it('destroyDiscussionDir removes the entire directory tree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
    await initDiscussionDir(root, 'demo', 'c1', 't', ['a']);
    await destroyDiscussionDir(root, 'demo', 'c1');
    expect(fs.existsSync(discussionDir(root, 'demo', 'c1'))).toBe(false);
  });

  it('initDiscussionDir on an existing directory appends a Continuation header to topic.md and preserves opinions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
    await initDiscussionDir(root, 'demo', 'c1', 'first', ['a']);
    fs.writeFileSync(opinionPath(root, 'demo', 'c1', 'a'), 'prior opinion');
    await initDiscussionDir(root, 'demo', 'c1', 'second', ['a']);
    const topic = fs.readFileSync(path.join(discussionDir(root, 'demo', 'c1'), 'topic.md'), 'utf-8');
    expect(topic).toContain('first');
    expect(topic).toMatch(/## Continuation/);
    expect(topic).toContain('second');
    expect(fs.readFileSync(opinionPath(root, 'demo', 'c1', 'a'), 'utf-8')).toContain('prior opinion');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=@codey/core -- discussion/files.test
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `files.ts`**

```ts
// packages/core/src/discussion/files.ts
import * as fs from 'fs';
import * as path from 'path';

export function discussionDir(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(workspacesRoot, workspace, 'chats', chatId, 'discussion');
}

export function opinionsDir(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'opinions');
}

export function opinionPath(workspacesRoot: string, workspace: string, chatId: string, worker: string): string {
  return path.join(opinionsDir(workspacesRoot, workspace, chatId), `${worker}.md`);
}

export function controlPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'control.md');
}

export function summaryPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'summary.md');
}

export function topicPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'topic.md');
}

export function transcriptPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'transcript.log');
}

const INITIAL_CONTROL = `---
status: running
revision: 1
updated_at: __ISO__
---

## Directive
Start the discussion. Read the topic, share your initial perspective in your opinion file.
`;

export async function initDiscussionDir(
  workspacesRoot: string,
  workspace: string,
  chatId: string,
  topic: string,
  workers: string[],
): Promise<void> {
  const dir = discussionDir(workspacesRoot, workspace, chatId);
  const isResume = fs.existsSync(dir);

  await fs.promises.mkdir(opinionsDir(workspacesRoot, workspace, chatId), { recursive: true });

  const tPath = topicPath(workspacesRoot, workspace, chatId);
  if (isResume && fs.existsSync(tPath)) {
    const existing = await fs.promises.readFile(tPath, 'utf-8');
    const continuation = `\n\n## Continuation (${new Date().toISOString()})\n\n${topic}\n`;
    await fs.promises.writeFile(tPath, existing.replace(/\n+$/, '') + continuation, 'utf-8');
  } else {
    await fs.promises.writeFile(tPath, `# Topic\n\n${topic}\n`, 'utf-8');
  }

  await fs.promises.writeFile(
    controlPath(workspacesRoot, workspace, chatId),
    INITIAL_CONTROL.replace('__ISO__', new Date().toISOString()),
    'utf-8',
  );

  // summary.md: keep prior on resume so Manager has context; create empty on first run.
  if (!fs.existsSync(summaryPath(workspacesRoot, workspace, chatId))) {
    await fs.promises.writeFile(
      summaryPath(workspacesRoot, workspace, chatId),
      '# Summary\n\n(empty — discussion has not started)\n',
      'utf-8',
    );
  }

  const tlog = transcriptPath(workspacesRoot, workspace, chatId);
  if (!fs.existsSync(tlog)) await fs.promises.writeFile(tlog, '', 'utf-8');

  for (const w of workers) {
    const p = opinionPath(workspacesRoot, workspace, chatId, w);
    if (!fs.existsSync(p)) {
      await fs.promises.writeFile(p, `# ${w}'s opinion\n\n(not started)\n`, 'utf-8');
    }
  }
}

export async function destroyDiscussionDir(workspacesRoot: string, workspace: string, chatId: string): Promise<void> {
  const dir = discussionDir(workspacesRoot, workspace, chatId);
  if (fs.existsSync(dir)) await fs.promises.rm(dir, { recursive: true, force: true });
}

export async function listOpinionFiles(workspacesRoot: string, workspace: string, chatId: string): Promise<string[]> {
  const dir = opinionsDir(workspacesRoot, workspace, chatId);
  if (!fs.existsSync(dir)) return [];
  const entries = await fs.promises.readdir(dir);
  return entries
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .sort();
}

export async function appendTranscript(
  workspacesRoot: string,
  workspace: string,
  chatId: string,
  event: { actor: string; kind: string; note?: string },
): Promise<void> {
  const line = `${new Date().toISOString()} ${event.actor} ${event.kind}${event.note ? ` ${event.note.replace(/\n/g, ' ')}` : ''}\n`;
  await fs.promises.appendFile(transcriptPath(workspacesRoot, workspace, chatId), line, 'utf-8');
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/core -- discussion/files.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/discussion/files.ts packages/core/src/discussion/files.test.ts
git commit -m "feat(discussion): file layout helpers for parallel-mode workspaces"
```

---

## Task 4: Control file parser / writer with revision

**Files:**
- Create: `packages/core/src/discussion/control.ts`
- Create: `packages/core/src/discussion/control.test.ts`

Purpose: parse/serialize `control.md`, enforce monotonic `revision`, expose helpers for workers (`readControl`) and Manager (`writeControl`).

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/src/discussion/control.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseControl, serializeControl, readControl, writeControl, ControlFile } from './control';

describe('control file', () => {
  it('parses a running control file', () => {
    const text = `---\nstatus: running\nrevision: 3\nupdated_at: 2026-05-24T00:00:00.000Z\n---\n\n## Directive\nKeep going.\n`;
    const c = parseControl(text);
    expect(c.status).toBe('running');
    expect(c.revision).toBe(3);
    expect(c.directive).toBe('Keep going.');
    expect(c.userQuestion).toBeUndefined();
  });

  it('parses paused with User Question section', () => {
    const text = `---\nstatus: paused\nrevision: 5\nupdated_at: 2026-05-24T00:00:00.000Z\n---\n\n## Directive\nWait.\n\n## User Question\nDo we ship?\n`;
    const c = parseControl(text);
    expect(c.status).toBe('paused');
    expect(c.userQuestion).toBe('Do we ship?');
  });

  it('serialize → parse is a roundtrip', () => {
    const c: ControlFile = {
      status: 'paused',
      revision: 7,
      updatedAt: '2026-05-24T00:00:00.000Z',
      directive: 'Hold',
      userQuestion: 'Color?',
      userQuestionChoices: ['red', 'blue'],
      resumeNote: undefined,
    };
    expect(parseControl(serializeControl(c))).toEqual(c);
  });

  it('writeControl bumps revision and rejects stale writes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-'));
    const p = path.join(dir, 'control.md');
    fs.writeFileSync(p, serializeControl({ status: 'running', revision: 1, updatedAt: '', directive: '' }));

    const after = await writeControl(p, prev => ({ ...prev, directive: 'go' }));
    expect(after.revision).toBe(2);
    expect(after.directive).toBe('go');

    // Concurrent stale base: passing expectedRevision=1 when on-disk is now 2 must throw
    await expect(writeControl(p, prev => prev, { expectedRevision: 1 })).rejects.toThrow(/stale/);
  });

  it('readControl returns null when file missing', async () => {
    expect(await readControl('/no/such/file')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=@codey/core -- discussion/control.test
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `control.ts`**

```ts
// packages/core/src/discussion/control.ts
import * as fs from 'fs';

export type ControlStatus = 'running' | 'paused' | 'finalizing' | 'terminated';

export interface ControlFile {
  status: ControlStatus;
  revision: number;
  updatedAt: string;
  directive: string;
  userQuestion?: string;
  userQuestionChoices?: string[];
  resumeNote?: string;
}

const SECTION_RE = /^##\s+(.+?)\s*$/gm;

export function parseControl(text: string): ControlFile {
  const frontMatchEnd = text.indexOf('\n---', 3);
  if (!text.startsWith('---') || frontMatchEnd < 0) {
    throw new Error('control.md: missing frontmatter');
  }
  const front = text.slice(3, frontMatchEnd).trim();
  const body = text.slice(frontMatchEnd + 4).trim();

  const fm: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const status = fm.status as ControlStatus;
  if (!['running', 'paused', 'finalizing', 'terminated'].includes(status)) {
    throw new Error(`control.md: invalid status "${fm.status}"`);
  }
  const revision = parseInt(fm.revision, 10);
  if (!Number.isFinite(revision)) throw new Error('control.md: invalid revision');

  const sections: Record<string, string> = {};
  const headerMatches = [...body.matchAll(SECTION_RE)];
  for (let i = 0; i < headerMatches.length; i++) {
    const m = headerMatches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index! : body.length;
    sections[m[1].toLowerCase()] = body.slice(start, end).trim();
  }

  const result: ControlFile = {
    status,
    revision,
    updatedAt: fm.updated_at || '',
    directive: sections['directive'] || '',
  };
  if (sections['user question']) {
    const raw = sections['user question'];
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1 && lines.slice(1).every(l => l.startsWith('- '))) {
      result.userQuestion = lines[0];
      result.userQuestionChoices = lines.slice(1).map(l => l.slice(2));
    } else {
      result.userQuestion = raw;
    }
  }
  if (sections['resume note']) result.resumeNote = sections['resume note'];
  return result;
}

export function serializeControl(c: ControlFile): string {
  const front = `---\nstatus: ${c.status}\nrevision: ${c.revision}\nupdated_at: ${c.updatedAt}\n---\n`;
  let body = `\n## Directive\n${c.directive || ''}\n`;
  if (c.userQuestion !== undefined) {
    body += `\n## User Question\n${c.userQuestion}`;
    if (c.userQuestionChoices?.length) {
      body += '\n' + c.userQuestionChoices.map(o => `- ${o}`).join('\n');
    }
    body += '\n';
  }
  if (c.resumeNote !== undefined) {
    body += `\n## Resume Note\n${c.resumeNote}\n`;
  }
  return front + body;
}

export async function readControl(filePath: string): Promise<ControlFile | null> {
  try {
    const txt = await fs.promises.readFile(filePath, 'utf-8');
    return parseControl(txt);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface WriteControlOptions {
  /** If set, the write fails when the on-disk revision is not exactly this value. */
  expectedRevision?: number;
}

const mutexes = new Map<string, Promise<unknown>>();
function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = mutexes.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  mutexes.set(key, next.catch(() => undefined));
  return next;
}

export async function writeControl(
  filePath: string,
  update: (prev: ControlFile) => Omit<ControlFile, 'revision' | 'updatedAt'> & { revision?: number; updatedAt?: string },
  opts: WriteControlOptions = {},
): Promise<ControlFile> {
  return lock(filePath, async () => {
    const current = await readControl(filePath);
    if (!current) throw new Error(`control.md not found at ${filePath}`);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
      throw new Error(`stale control.md write (expected revision ${opts.expectedRevision}, found ${current.revision})`);
    }
    const next = update(current);
    const finalized: ControlFile = {
      status: next.status,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      directive: next.directive ?? '',
      userQuestion: next.userQuestion,
      userQuestionChoices: next.userQuestionChoices,
      resumeNote: next.resumeNote,
    };
    await fs.promises.writeFile(filePath, serializeControl(finalized), 'utf-8');
    return finalized;
  });
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/core -- discussion/control.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/discussion/control.ts packages/core/src/discussion/control.test.ts
git commit -m "feat(discussion): control.md parser/serializer with revision mutex"
```

---

## Task 5: Worker prompt for parallel mode

**Files:**
- Modify: `packages/core/src/workers.ts` (add new method)
- Modify: `packages/core/src/workers.test.ts` (or create if missing)

- [ ] **Step 1: Write failing test**

```ts
// in packages/core/src/workers.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerManager } from './workers';

let mgr: WorkerManager;
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  fs.mkdirSync(path.join(dir, 'arc'));
  fs.writeFileSync(path.join(dir, 'arc', 'personality.md'), '# w\n## Role\nArchitect.\n## Soul\nThoughtful.\n## Instructions\nPlan first.\n');
  fs.writeFileSync(path.join(dir, 'arc', 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'x', tools: [] }));
  mgr = new WorkerManager(dir);
  await mgr.loadWorkers();
});

describe('buildParallelWorkerPrompt', () => {
  it('includes file paths and the loop protocol', () => {
    const p = mgr.buildParallelWorkerPrompt('arc', {
      topic: 'Should we adopt RPC?',
      controlPath: '/d/control.md',
      summaryPath: '/d/summary.md',
      ownOpinionPath: '/d/opinions/arc.md',
      peerOpinions: [{ name: 'exe', path: '/d/opinions/exe.md' }],
    });
    expect(p).toContain('Architect.');
    expect(p).toContain('/d/control.md');
    expect(p).toContain('/d/opinions/arc.md');
    expect(p).toContain('/d/opinions/exe.md');
    expect(p).toContain('[ASK_MANAGER]');
    expect(p).toContain('Should we adopt RPC?');
    expect(p.toLowerCase()).toContain('read control.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=@codey/core -- workers.test
```

Expected: FAIL — `buildParallelWorkerPrompt` undefined.

- [ ] **Step 3: Add `buildParallelWorkerPrompt` to `WorkerManager`**

```ts
// in packages/core/src/workers.ts, near the other build* methods:
export interface ParallelPromptInputs {
  topic: string;
  controlPath: string;
  summaryPath: string;
  ownOpinionPath: string;
  peerOpinions: Array<{ name: string; path: string }>;
}

// inside WorkerManager:
buildParallelWorkerPrompt(name: string, inputs: ParallelPromptInputs): string {
  const worker = this.getWorker(name);
  if (!worker) return inputs.topic;
  const peerLines = inputs.peerOpinions.length > 0
    ? inputs.peerOpinions.map(p => `- ${p.name}: ${p.path}`).join('\n')
    : '(no peers on this discussion)';
  return [
    `# Worker: ${worker.name} (Parallel/Roundtable Mode)`,
    `## Role`,
    worker.personality.role,
    `## Personality`,
    worker.personality.soul,
    `## Instructions`,
    worker.personality.instructions,
    `## Topic`,
    inputs.topic,
    `## Files (use your Read/Write tools)`,
    `- Your opinion file (write here): ${inputs.ownOpinionPath}`,
    `- Manager summary (read-only): ${inputs.summaryPath}`,
    `- Manager control (read-only, check before each write): ${inputs.controlPath}`,
    `- Peer opinions (read-only):\n${peerLines}`,
    `## Loop Protocol`,
    [
      '1. Read control.md. If status is "terminated", exit immediately. If "finalizing", write one consolidating final entry to your opinion file then exit. If "paused", wait and re-read every ~5 seconds until status changes.',
      '2. Read summary.md and each peer opinion file.',
      '3. Update YOUR opinion file (append a timestamped section; do not overwrite past entries) with your current position, what you agree/disagree with, and any open question.',
      '4. If you need information you do not have, append a single line `[ASK_MANAGER]: <question>` at the end of your opinion file. The Manager will route or escalate.',
      '5. If you have nothing new to add after the most recent peer/summary update, write a short "no further input" note and exit.',
      '6. Otherwise sleep briefly (the agent may simply continue) and repeat from step 1.',
    ].join('\n'),
    `## Important`,
    '- Never write to files other than your own opinion file.',
    '- Keep individual updates concise; readers (peers, Manager) re-read the whole file each turn.',
    '- Honor the control.md status before every write.',
  ].join('\n\n');
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/core -- workers.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workers.ts packages/core/src/workers.test.ts
git commit -m "feat(workers): buildParallelWorkerPrompt for roundtable mode"
```

---

## Task 6: Parallel-mode Manager (advisor variant)

**Files:**
- Create: `packages/core/src/discussion/parallel-advisor.ts`
- Create: `packages/core/src/discussion/parallel-advisor.test.ts`

Purpose: build the Manager's prompt for parallel mode and parse its JSON output. Reuses `runAdvisor`'s `extractJsonObject`.

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/src/discussion/parallel-advisor.test.ts
import { describe, it, expect } from 'vitest';
import { buildParallelManagerPrompt, parseParallelManagerTurn } from './parallel-advisor';

describe('parallel manager', () => {
  it('prompt includes topic, all opinions, summary, transcript tail', () => {
    const p = buildParallelManagerPrompt({
      topic: 'Adopt RPC?',
      summary: 'Workers diverge on cost.',
      opinions: [{ name: 'a', text: 'I say yes' }, { name: 'b', text: 'I say no' }],
      pendingAsks: [{ worker: 'a', question: 'What is budget?' }],
      idleMs: 0,
      revision: 4,
    });
    expect(p).toContain('Adopt RPC?');
    expect(p).toContain('I say yes');
    expect(p).toContain('I say no');
    expect(p).toContain('What is budget?');
    expect(p).toMatch(/JSON/);
  });

  it('parses a continue action', () => {
    const t = parseParallelManagerTurn('{"action":"continue","summary_update":"new sum","directive":"focus on cost","reason":"continuing"}');
    expect(t).toEqual({ action: 'continue', summary_update: 'new sum', directive: 'focus on cost', reason: 'continuing' });
  });

  it('parses ask_user with choices', () => {
    const t = parseParallelManagerTurn('{"action":"ask_user","user_question":"Ship?","user_question_choices":["yes","no"],"reason":"pending_question"}');
    expect(t?.action).toBe('ask_user');
    expect(t?.user_question_choices).toEqual(['yes', 'no']);
  });

  it('parses finalize/terminate', () => {
    expect(parseParallelManagerTurn('{"action":"finalize","final_message":"done","reason":"consensus"}')?.action).toBe('finalize');
    expect(parseParallelManagerTurn('{"action":"terminate","final_message":"off-topic","reason":"drift"}')?.action).toBe('terminate');
  });

  it('returns null on malformed output', () => {
    expect(parseParallelManagerTurn('not json')).toBeNull();
    expect(parseParallelManagerTurn('{"action":"bogus"}')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=@codey/core -- discussion/parallel-advisor.test
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `parallel-advisor.ts`**

```ts
// packages/core/src/discussion/parallel-advisor.ts
import { extractJsonObject } from '../advisor';

export interface ParallelManagerInput {
  topic: string;
  summary: string;
  opinions: Array<{ name: string; text: string }>;
  pendingAsks: Array<{ worker: string; question: string }>;
  idleMs: number;
  revision: number;
  userAnswer?: { question: string; answer: string };
}

export type ParallelAction = 'continue' | 'ask_user' | 'finalize' | 'terminate';
export type ParallelReason = 'continuing' | 'pending_question' | 'consensus' | 'drift' | 'idle' | 'manager_error';

export interface ParallelManagerTurn {
  action: ParallelAction;
  summary_update?: string;
  directive?: string;
  route_to?: string;
  user_question?: string;
  user_question_choices?: string[];
  final_message?: string;
  reason: ParallelReason;
}

const ACTIONS: ReadonlySet<string> = new Set(['continue', 'ask_user', 'finalize', 'terminate']);
const REASONS: ReadonlySet<string> = new Set(['continuing', 'pending_question', 'consensus', 'drift', 'idle', 'manager_error']);

export function buildParallelManagerPrompt(input: ParallelManagerInput): string {
  const opinions = input.opinions.length === 0
    ? '(no opinions yet)'
    : input.opinions.map(o => `### ${o.name}\n${o.text || '(empty)'}`).join('\n\n');
  const asks = input.pendingAsks.length === 0
    ? '(none)'
    : input.pendingAsks.map(a => `- ${a.worker}: ${a.question}`).join('\n');

  return [
    '# Manager (Parallel Roundtable)',
    '## Role',
    'You moderate a parallel discussion. Workers update their opinion files concurrently. You maintain `summary.md`, decide whether to continue, ask the user, or terminate.',
    '## Topic',
    input.topic,
    '## Current Summary',
    input.summary || '(empty)',
    '## Opinions',
    opinions,
    '## Pending Worker Questions',
    asks,
    '## State',
    `idle_ms: ${input.idleMs}\ncontrol_revision: ${input.revision}`,
    ...(input.userAnswer ? ['## User Just Answered', `Q: ${input.userAnswer.question}\nA: ${input.userAnswer.answer}`] : []),
    '## Decide',
    [
      'Choose exactly one action and respond with a single JSON object (no prose, no fences).',
      '',
      'Schema:',
      '{',
      '  "action": "continue" | "ask_user" | "finalize" | "terminate",',
      '  "summary_update": string | undefined,    // new full text for summary.md when you want to update it',
      '  "directive": string | undefined,         // short note for workers via control.md',
      '  "route_to": string | undefined,          // when routing a pending question to a specific peer',
      '  "user_question": string | undefined,     // required when action="ask_user"',
      '  "user_question_choices": string[] | undefined, // optional small choice set when action="ask_user"',
      '  "final_message": string | undefined,     // required when action in {finalize, terminate}',
      '  "reason": "continuing" | "pending_question" | "consensus" | "drift" | "idle"',
      '}',
      '',
      'Guidelines:',
      '- "continue" when the discussion is productive and converging.',
      '- "ask_user" when a worker question genuinely needs human input AND no teammate can plausibly answer.',
      '- "finalize" when consensus or a clear conclusion is reached.',
      '- "terminate" when the discussion has drifted or is unproductive.',
    ].join('\n'),
  ].join('\n\n');
}

export function parseParallelManagerTurn(raw: string): ParallelManagerTurn | null {
  const obj = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!obj) return null;
  const action = obj.action;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  const reason = obj.reason;
  if (typeof reason !== 'string' || !REASONS.has(reason)) return null;

  const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined);
  const strArr = (k: string): string[] | undefined => {
    const v = obj[k];
    if (!Array.isArray(v)) return undefined;
    return v.every(x => typeof x === 'string') ? (v as string[]) : undefined;
  };

  const turn: ParallelManagerTurn = {
    action: action as ParallelAction,
    reason: reason as ParallelReason,
    summary_update: str('summary_update'),
    directive: str('directive'),
    route_to: str('route_to'),
    user_question: str('user_question'),
    user_question_choices: strArr('user_question_choices'),
    final_message: str('final_message'),
  };
  if (turn.action === 'ask_user' && !turn.user_question) return null;
  if ((turn.action === 'finalize' || turn.action === 'terminate') && !turn.final_message) return null;
  return turn;
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/core -- discussion/parallel-advisor.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/discussion/parallel-advisor.ts packages/core/src/discussion/parallel-advisor.test.ts
git commit -m "feat(discussion): parallel-mode manager prompt + parser"
```

---

## Task 7: Re-export new core symbols

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add exports**

```ts
// append to packages/core/src/index.ts:
export * from './discussion/files';
export * from './discussion/control';
export * from './discussion/parallel-advisor';
export type { ParallelSettings } from './workspace';
```

- [ ] **Step 2: Build to verify**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "chore(core): export parallel-mode public symbols"
```

---

## Task 8: ParallelTeamRunner — orchestrator skeleton

**Files:**
- Create: `packages/gateway/src/parallel-team.ts`
- Create: `packages/gateway/src/parallel-team.test.ts`

This task creates the runner class and its constructor/lifecycle wiring, but NOT the worker/manager loops yet (those land in Tasks 9 and 10). Tests assert the runner constructs, initializes files, and tears down cleanly when stopped immediately.

- [ ] **Step 1: Write failing tests**

```ts
// packages/gateway/src/parallel-team.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ParallelTeamRunner } from './parallel-team';

const stubRunner = vi.fn().mockResolvedValue({ success: true, output: '' });

function makeRunner(overrides: Partial<ConstructorParameters<typeof ParallelTeamRunner>[0]> = {}) {
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  fs.mkdirSync(path.join(workspacesRoot, 'demo', 'chats', 'c1'), { recursive: true });
  return new ParallelTeamRunner({
    workspacesRoot,
    workspace: 'demo',
    chatId: 'c1',
    teamName: 'rt',
    members: ['a', 'b'],
    topic: 'Decide X',
    settings: { maxDurationMs: 1000, idleTimeoutMs: 500, managerPollMs: 200 },
    workerRunner: stubRunner,
    managerRunner: vi.fn().mockResolvedValue({ success: true, output: '{"action":"terminate","final_message":"end","reason":"drift"}' }),
    buildWorkerPrompt: () => 'WORKER',
    onUserQuestion: vi.fn(),
    onFinal: vi.fn(),
    ...overrides,
  });
}

describe('ParallelTeamRunner', () => {
  it('initializes discussion files on start()', async () => {
    const r = makeRunner();
    await r.start();
    expect(fs.existsSync(path.join(r.discussionDir, 'topic.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.discussionDir, 'control.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.discussionDir, 'opinions', 'a.md'))).toBe(true);
    await r.stop('user_cancel');
  });

  it('emits onFinal with reason and final message after terminate', async () => {
    const onFinal = vi.fn();
    const r = makeRunner({ onFinal });
    await r.start();
    await r.waitDone();
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.any(String) }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement runner skeleton**

```ts
// packages/gateway/src/parallel-team.ts
import * as fs from 'fs';
import * as path from 'path';
import {
  initDiscussionDir,
  discussionDir,
  controlPath,
  summaryPath,
  topicPath,
  opinionPath,
  listOpinionFiles,
  appendTranscript,
  readControl,
  writeControl,
  buildParallelManagerPrompt,
  parseParallelManagerTurn,
  type ParallelManagerTurn,
  type ParallelSettings,
  type DiscussionTerminatedReason,
} from '@codey/core';
import type { AgentRequest, AgentResponse } from '@codey/core';

export type AgentRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface ParallelFinalEvent {
  reason: DiscussionTerminatedReason;
  message: string;
  summary: string;
  perWorker: Array<{ name: string; excerpt: string }>;
}

export interface ParallelUserQuestion {
  question: string;
  choices?: string[];
  /** Caller must invoke this once the user answers. */
  resume: (answer: string) => Promise<void>;
}

export interface ParallelTeamRunnerOptions {
  workspacesRoot: string;
  workspace: string;
  chatId: string;
  teamName: string;
  members: string[];
  topic: string;
  settings: ParallelSettings;
  workerRunner: AgentRunner;
  managerRunner: AgentRunner;
  buildWorkerPrompt: (worker: string) => string;
  onUserQuestion: (q: ParallelUserQuestion) => void;
  onFinal: (e: ParallelFinalEvent) => void;
}

export class ParallelTeamRunner {
  readonly discussionDir: string;
  private abort = new AbortController();
  private workerAborts: AbortController[] = [];
  private done = false;
  private donePromise: Promise<void>;
  private resolveDone!: () => void;
  private pendingResume: ((answer: string) => void) | null = null;
  private lastMtimeMs = 0;
  private startedAt = 0;
  private idleSince = 0;

  constructor(private opts: ParallelTeamRunnerOptions) {
    this.discussionDir = discussionDir(opts.workspacesRoot, opts.workspace, opts.chatId);
    this.donePromise = new Promise<void>(res => { this.resolveDone = res; });
  }

  async start(): Promise<void> {
    await initDiscussionDir(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, this.opts.topic, this.opts.members);
    this.startedAt = Date.now();
    this.idleSince = this.startedAt;
    await appendTranscript(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, { actor: 'system', kind: 'started' });
    void this.runManagerLoop();
    this.spawnWorkers();
    this.armSupervisors();
  }

  waitDone(): Promise<void> { return this.donePromise; }

  async stop(reason: DiscussionTerminatedReason, finalMessage = ''): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      await writeControl(controlPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId),
        prev => ({ ...prev, status: 'terminated', directive: 'discussion ended' })).catch(() => undefined);
    } finally {
      this.abort.abort();
      for (const a of this.workerAborts) a.abort();
      await this.emitFinal(reason, finalMessage);
      this.resolveDone();
    }
  }

  // Worker loops, manager loop, supervisors, emitFinal — added in subsequent tasks.
  private spawnWorkers(): void { /* Task 9 */ }
  private async runManagerLoop(): Promise<void> { /* Task 10 */ }
  private armSupervisors(): void { /* Task 11 */ }
  private async emitFinal(reason: DiscussionTerminatedReason, message: string): Promise<void> {
    const summary = safeRead(summaryPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId));
    const perWorker: Array<{ name: string; excerpt: string }> = [];
    for (const w of this.opts.members) {
      const text = safeRead(opinionPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, w));
      const firstLine = text.split('\n').find(l => l.trim().length > 0) || '';
      perWorker.push({ name: w, excerpt: firstLine.slice(0, 200) });
    }
    this.opts.onFinal({ reason, message, summary, perWorker });
  }
}

function safeRead(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}
```

For this skeleton task only, also implement a minimal placeholder so `waitDone()` resolves: at the end of `start()`, schedule a microtask that calls `this.stop('user_cancel')` ONLY when `managerRunner` is never going to be invoked (no — better: just have the skeleton tests call `stop()` explicitly; remove the second test or relax it). Adjust the second test in Step 1 to:

```ts
it('emits onFinal with reason after stop()', async () => {
  const onFinal = vi.fn();
  const r = makeRunner({ onFinal });
  await r.start();
  await r.stop('user_cancel', 'stopped');
  expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_cancel', message: 'stopped' }));
});
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/parallel-team.ts packages/gateway/src/parallel-team.test.ts
git commit -m "feat(parallel-team): runner skeleton with start/stop/onFinal"
```

---

## Task 9: Worker loop dispatch

**Files:**
- Modify: `packages/gateway/src/parallel-team.ts` (fill `spawnWorkers`)
- Modify: `packages/gateway/src/parallel-team.test.ts` (add test)

Workers are dispatched once each via `workerRunner`. Each worker session is long-lived; the runner does not re-invoke a worker. Workers self-terminate by observing `control.md`.

- [ ] **Step 1: Add failing test**

```ts
it('dispatches each member exactly once via workerRunner with its built prompt', async () => {
  const workerRunner = vi.fn().mockResolvedValue({ success: true, output: '' });
  const buildWorkerPrompt = vi.fn((w: string) => `PROMPT-${w}`);
  const r = makeRunner({ workerRunner, buildWorkerPrompt });
  await r.start();
  await r.stop('user_cancel');
  const calls = workerRunner.mock.calls.map(c => c[0].prompt);
  expect(calls.sort()).toEqual(['PROMPT-a', 'PROMPT-b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
```

Expected: FAIL — workerRunner not called.

- [ ] **Step 3: Implement `spawnWorkers`**

```ts
private spawnWorkers(): void {
  for (const w of this.opts.members) {
    const ac = new AbortController();
    this.workerAborts.push(ac);
    const req: AgentRequest = {
      prompt: this.opts.buildWorkerPrompt(w),
      signal: ac.signal,
    } as AgentRequest;
    void this.opts.workerRunner(req)
      .then(async res => {
        await appendTranscript(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, {
          actor: w, kind: res.success ? 'worker_done' : 'worker_failed', note: res.error,
        });
      })
      .catch(async err => {
        await appendTranscript(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, {
          actor: w, kind: 'worker_error', note: (err as Error).message,
        });
      });
  }
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/parallel-team.ts packages/gateway/src/parallel-team.test.ts
git commit -m "feat(parallel-team): dispatch workers via long-lived agent sessions"
```

---

## Task 10: Manager loop

**Files:**
- Modify: `packages/gateway/src/parallel-team.ts`
- Modify: `packages/gateway/src/parallel-team.test.ts`

The Manager loop runs every `managerPollMs` (default 30s) AND on every `fs.watch` event on the discussion dir (debounced 2s). On each tick it: gathers state, calls `managerRunner`, parses the response, applies side effects (write summary, write control, escalate to user, finalize, terminate).

- [ ] **Step 1: Add failing tests**

```ts
it('terminates when managerRunner returns action=terminate', async () => {
  const managerRunner = vi.fn().mockResolvedValue({
    success: true,
    output: '{"action":"terminate","final_message":"off topic","reason":"drift"}',
  });
  const onFinal = vi.fn();
  const r = makeRunner({ managerRunner, onFinal });
  await r.start();
  await r.waitDone();
  expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drift', message: 'off topic' }));
});

it('on ask_user, calls onUserQuestion with a resume function, and waitDone resolves after resume + terminate', async () => {
  const responses = [
    '{"action":"ask_user","user_question":"Color?","reason":"pending_question"}',
    '{"action":"terminate","final_message":"done","reason":"consensus"}',
  ];
  const managerRunner = vi.fn().mockImplementation(() => Promise.resolve({ success: true, output: responses.shift()! }));
  const onUserQuestion = vi.fn();
  const r = makeRunner({ managerRunner, onUserQuestion });
  await r.start();
  // Wait for the ask
  await new Promise(res => setTimeout(res, 300));
  expect(onUserQuestion).toHaveBeenCalled();
  const q = onUserQuestion.mock.calls[0][0];
  expect(q.question).toBe('Color?');
  await q.resume('blue');
  await r.waitDone();
});

it('writes summary_update to summary.md and directive to control.md on continue', async () => {
  let i = 0;
  const managerRunner = vi.fn().mockImplementation(() => {
    i++;
    if (i === 1) return Promise.resolve({ success: true, output: '{"action":"continue","summary_update":"new sum","directive":"focus","reason":"continuing"}' });
    return Promise.resolve({ success: true, output: '{"action":"terminate","final_message":"end","reason":"consensus"}' });
  });
  const r = makeRunner({ managerRunner });
  await r.start();
  await r.waitDone();
  expect(fs.readFileSync(path.join(r.discussionDir, 'summary.md'), 'utf-8')).toContain('new sum');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
```

Expected: FAIL on all three new tests.

- [ ] **Step 3: Implement `runManagerLoop`**

```ts
private async runManagerLoop(): Promise<void> {
  const dir = this.discussionDir;
  const wsRoot = this.opts.workspacesRoot;
  const ws = this.opts.workspace;
  const chat = this.opts.chatId;
  const ctrlPath = controlPath(wsRoot, ws, chat);
  const sumPath = summaryPath(wsRoot, ws, chat);
  const topPath = topicPath(wsRoot, ws, chat);

  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | null = null;
  const tickSignal = (() => {
    let resolveTick: (() => void) | null = null;
    return {
      wait: () => new Promise<void>(res => { resolveTick = res; }),
      poke: () => { if (resolveTick) { const r = resolveTick; resolveTick = null; r(); } },
    };
  })();

  try {
    watcher = fs.watch(dir, { recursive: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => tickSignal.poke(), 2000);
    });
  } catch { /* watch may fail on some FS; poll covers it */ }

  let pendingUserAnswer: { question: string; answer: string } | undefined;

  while (!this.done) {
    if (this.opts.settings.managerPollMs > 0) {
      const timer = setTimeout(() => tickSignal.poke(), this.opts.settings.managerPollMs);
      await Promise.race([tickSignal.wait(), new Promise<void>(res => setTimeout(res, this.opts.settings.managerPollMs))]);
      clearTimeout(timer);
    } else {
      await tickSignal.wait();
    }
    if (this.done) break;

    const topic = safeRead(topPath);
    const summary = safeRead(sumPath);
    const opinions = (await listOpinionFiles(wsRoot, ws, chat)).map(name => ({
      name,
      text: safeRead(opinionPath(wsRoot, ws, chat, name)),
    }));
    const pendingAsks = extractPendingAsks(opinions);
    const ctrl = await readControl(ctrlPath);
    const idleMs = Date.now() - this.idleSince;

    const prompt = buildParallelManagerPrompt({
      topic, summary, opinions, pendingAsks, idleMs,
      revision: ctrl?.revision ?? 0,
      userAnswer: pendingUserAnswer,
    });
    pendingUserAnswer = undefined;

    let resp: AgentResponse;
    try {
      resp = await this.opts.managerRunner({ prompt, signal: this.abort.signal } as AgentRequest);
    } catch (err) {
      await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'error', note: (err as Error).message });
      continue;
    }
    if (!resp.success) {
      await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'error', note: resp.error });
      continue;
    }
    const turn = parseParallelManagerTurn(resp.output);
    if (!turn) {
      await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'parse_error' });
      continue;
    }

    if (turn.summary_update) {
      await fs.promises.writeFile(sumPath, `# Summary\n\n${turn.summary_update}\n`, 'utf-8');
      this.idleSince = Date.now();
    }
    if (turn.directive) {
      await writeControl(ctrlPath, prev => ({ ...prev, status: prev.status, directive: turn.directive! }));
    }

    if (turn.action === 'continue') {
      await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'continue', note: turn.reason });
      continue;
    }
    if (turn.action === 'ask_user') {
      await writeControl(ctrlPath, prev => ({
        ...prev,
        status: 'paused',
        directive: prev.directive,
        userQuestion: turn.user_question,
        userQuestionChoices: turn.user_question_choices,
      }));
      const answerPromise = new Promise<string>(res => { this.pendingResume = res; });
      this.opts.onUserQuestion({
        question: turn.user_question!,
        choices: turn.user_question_choices,
        resume: async (answer: string) => {
          if (this.pendingResume) { this.pendingResume(answer); this.pendingResume = null; }
        },
      });
      const answer = await answerPromise;
      pendingUserAnswer = { question: turn.user_question!, answer };
      await writeControl(ctrlPath, prev => ({
        ...prev,
        status: 'running',
        directive: prev.directive,
        resumeNote: `User answered: ${answer}`,
        userQuestion: undefined,
        userQuestionChoices: undefined,
      }));
      this.idleSince = Date.now();
      continue;
    }
    if (turn.action === 'finalize' || turn.action === 'terminate') {
      const reason: DiscussionTerminatedReason = turn.action === 'finalize' ? 'consensus' : (turn.reason === 'drift' ? 'drift' : 'consensus');
      await this.stop(reason, turn.final_message || '');
      break;
    }
  }
  if (watcher) watcher.close();
  if (debounce) clearTimeout(debounce);
}

function extractPendingAsks(opinions: Array<{ name: string; text: string }>): Array<{ worker: string; question: string }> {
  const out: Array<{ worker: string; question: string }> = [];
  for (const o of opinions) {
    const lines = o.text.split('\n');
    for (const line of lines) {
      const m = /^\[ASK_MANAGER\]:\s*(.+)$/.exec(line.trim());
      if (m) out.push({ worker: o.name, question: m[1] });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/parallel-team.ts packages/gateway/src/parallel-team.test.ts
git commit -m "feat(parallel-team): manager loop with summary/control/ask_user/terminate"
```

---

## Task 11: Supervisors (max-duration + idle-timeout)

**Files:**
- Modify: `packages/gateway/src/parallel-team.ts`
- Modify: `packages/gateway/src/parallel-team.test.ts`

- [ ] **Step 1: Add failing tests**

First, extend `makeRunner` (defined in Task 8) so it accepts a partial `settings` override that is merged with the default. Then add:

```ts
it('terminates on max_duration when settings.maxDurationMs elapses', async () => {
  const managerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
  const workerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
  const onFinal = vi.fn();
  const r = makeRunner({
    managerRunner,
    workerRunner,
    onFinal,
    settings: { maxDurationMs: 200, idleTimeoutMs: 10_000, managerPollMs: 10_000 },
  });
  await r.start();
  await r.waitDone();
  expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'max_duration' }));
});

it('terminates on timeout when idleTimeoutMs elapses with no file mtime change', async () => {
  const managerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
  const workerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
  const onFinal = vi.fn();
  const r = makeRunner({
    managerRunner,
    workerRunner,
    onFinal,
    settings: { maxDurationMs: 10_000, idleTimeoutMs: 250, managerPollMs: 10_000 },
  });
  await r.start();
  await r.waitDone();
  expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'timeout' }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
```

Expected: FAIL.

- [ ] **Step 3: Implement `armSupervisors`**

```ts
private armSupervisors(): void {
  const start = Date.now();
  const checkMs = Math.min(500, Math.max(50, this.opts.settings.idleTimeoutMs / 4));
  const interval = setInterval(async () => {
    if (this.done) { clearInterval(interval); return; }
    if (Date.now() - start >= this.opts.settings.maxDurationMs) {
      clearInterval(interval);
      await this.stop('max_duration', 'discussion exceeded maximum duration');
      return;
    }
    // idle timeout: latest mtime across opinions + summary
    let latest = 0;
    try {
      const files = [summaryPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId)];
      const wnames = await listOpinionFiles(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId);
      for (const w of wnames) files.push(opinionPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, w));
      for (const f of files) {
        try { latest = Math.max(latest, (await fs.promises.stat(f)).mtimeMs); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    if (latest > this.lastMtimeMs) {
      this.lastMtimeMs = latest;
      this.idleSince = Date.now();
    } else if (Date.now() - this.idleSince >= this.opts.settings.idleTimeoutMs) {
      clearInterval(interval);
      await this.stop('timeout', 'no activity within idle window');
    }
  }, checkMs);
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/parallel-team.ts packages/gateway/src/parallel-team.test.ts
git commit -m "feat(parallel-team): supervisors for max-duration and idle-timeout"
```

---

## Task 12: Gateway dispatch — wire `parallel` to runner

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (the existing team-handler branch — find `team.dispatch === 'auto'` and add the `parallel` branch alongside it)
- Modify: any helper that already chooses dispatch path

This task wires up the runner from inside `Gateway`. Re-read the existing `auto` branch first: it gives the template for selection lookup, agent runner construction, and posting messages back into the chat.

- [ ] **Step 1: Locate existing team-dispatch site**

```bash
grep -n "dispatch === 'auto'\|TeamDispatchMode\|runAdvisor" packages/gateway/src/gateway.ts
```

Document the function name and line range you find in your task notes.

- [ ] **Step 2: Add failing integration test**

In `packages/gateway/src/parallel-team.test.ts` add a smoke test that constructs a real `Gateway` with stub channels and stub agents, fires a `/team rt some topic` user message, and asserts (a) discussion files are created, (b) `onFinal` posts an assistant message to the chat containing the final message.

(If wiring this end-to-end is heavy, you may instead split the test: a unit test on a new `dispatchParallelTeam` helper exported from `gateway.ts`.)

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test --workspace=@codey/gateway -- parallel-team.test
```

Expected: FAIL.

- [ ] **Step 4: Implement dispatch wiring**

In the existing function that handles `dispatch === 'auto'`, add a sibling branch:

```ts
if (team.dispatch === 'parallel') {
  if (!team.parallel) {
    // defensive — normalizer always populates this for parallel teams
    await postAssistant(chat, '⚠️ parallel team is missing settings');
    return;
  }
  const runner = new ParallelTeamRunner({
    workspacesRoot: this.workspacesRoot,
    workspace: chat.workspaceName,
    chatId: chat.id,
    teamName: team.name ?? selection.name!,
    members: team.members,
    topic: userInput,
    settings: team.parallel,
    workerRunner: req => this.runAgentForWorker(req, /* worker-specific agent/model lookup */),
    managerRunner: req => this.runAdvisorAgent(req),
    buildWorkerPrompt: workerName => this.workerManager.buildParallelWorkerPrompt(workerName, {
      topic: userInput,
      controlPath: controlPath(this.workspacesRoot, chat.workspaceName, chat.id),
      summaryPath: summaryPath(this.workspacesRoot, chat.workspaceName, chat.id),
      ownOpinionPath: opinionPath(this.workspacesRoot, chat.workspaceName, chat.id, workerName),
      peerOpinions: team.members
        .filter(m => m !== workerName)
        .map(m => ({ name: m, path: opinionPath(this.workspacesRoot, chat.workspaceName, chat.id, m) })),
    }),
    onUserQuestion: q => {
      // Set the chat's pendingTeam to a parallel-shaped pause so existing
      // ASK_USER UI surfaces. Save q.resume in a per-chat map keyed by chat.id.
      this.parallelResumes.set(chat.id, q.resume);
      void this.postAssistantAsk(chat, q.question, q.choices);
    },
    onFinal: ev => {
      this.parallelResumes.delete(chat.id);
      void this.chats.updateChat(chat.id, c => {
        c.discussion = { ...(c.discussion ?? { teamName: team.name!, startedAt: Date.now() }), status: 'done', terminatedReason: ev.reason };
        return c;
      });
      void postAssistant(chat, formatParallelFinal(ev, team.name!));
    },
  });
  await this.chats.updateChat(chat.id, c => {
    c.discussion = { teamName: team.name ?? selection.name!, status: 'running', startedAt: Date.now() };
    return c;
  });
  await runner.start();
  this.activeParallelRuns.set(chat.id, runner);
  return;
}
```

Add a small helper:

```ts
function formatParallelFinal(ev: ParallelFinalEvent, team: string): string {
  return [
    `🪑 Roundtable: ${team}`,
    `终止原因: ${ev.reason}`,
    '',
    '【Manager 总结】',
    ev.summary.trim() || '(empty)',
    '',
    '【各方观点】',
    ...ev.perWorker.map(p => `• ${p.name}: ${p.excerpt || '(empty)'}`),
    '',
    ev.message,
  ].join('\n');
}
```

Plumb new instance fields on `Gateway`:

```ts
private parallelResumes = new Map<string, (answer: string) => Promise<void>>();
private activeParallelRuns = new Map<string, ParallelTeamRunner>();
```

When a user message arrives in a chat with an active parallel run and `chat.discussion.status === 'paused'` (or `parallelResumes.has(chat.id)`), route the message into `parallelResumes.get(id)!(answer)` instead of starting a new turn.

- [ ] **Step 5: Run tests and build**

```bash
npm test --workspace=@codey/gateway
npm run build
```

Expected: PASS across all gateway tests, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/parallel-team.test.ts
git commit -m "feat(gateway): dispatch parallel teams via ParallelTeamRunner"
```

---

## Task 13: Resume detection — restart on new message into completed discussion

**Files:**
- Modify: `packages/gateway/src/chat-runner.ts` (or `gateway.ts` — wherever inbound user messages route to either selection)

- [ ] **Step 1: Identify the routing site**

```bash
grep -n "selection.type === 'team'\|dispatch ===" packages/gateway/src/chat-runner.ts packages/gateway/src/gateway.ts
```

- [ ] **Step 2: Add failing test**

In `packages/gateway/src/parallel-team.test.ts`:

```ts
it('resume: new message into done discussion preserves opinions and appends Continuation', async () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-resume-'));
  fs.mkdirSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions'), { recursive: true });
  // Seed a prior "done" discussion
  fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'topic.md'), '# Topic\n\nfirst round\n');
  fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'control.md'),
    `---\nstatus: terminated\nrevision: 9\nupdated_at: 2026-05-24T00:00:00.000Z\n---\n\n## Directive\nended\n`);
  fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'summary.md'), '# Summary\nprior\n');
  fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions', 'a.md'), 'prior a opinion');

  // Simulate resume invocation: gateway calls initDiscussionDir with the new topic
  await initDiscussionDir(wsRoot, 'demo', 'c1', 'second round', ['a', 'b']);

  const topic = fs.readFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'topic.md'), 'utf-8');
  expect(topic).toContain('first round');
  expect(topic).toMatch(/## Continuation/);
  expect(topic).toContain('second round');
  expect(fs.readFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions', 'a.md'), 'utf-8')).toContain('prior a opinion');
  // New worker b gets a fresh opinion file
  expect(fs.existsSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions', 'b.md'))).toBe(true);
  // Control reset to running with bumped revision
  const ctrl = await readControl(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'control.md'));
  expect(ctrl?.status).toBe('running');
});
```

This test exercises the file-layer contract directly. A higher-level test on `Gateway` is optional but recommended once the dispatch wiring from Task 12 is stable.

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test --workspace=@codey/gateway
```

Expected: FAIL (new message currently treated as a fresh team run).

- [ ] **Step 4: Implement resume logic**

Just before the new-run branch in Task 12, check:

```ts
if (chat.discussion && (chat.discussion.status === 'done' || chat.discussion.status === 'terminated')) {
  // Resume: reuse existing discussion dir; init helper appends Continuation header
  // and reuses opinion files. Mark chat back to running.
  await this.chats.updateChat(chat.id, c => {
    c.discussion!.status = 'running';
    c.discussion!.terminatedReason = undefined;
    c.discussion!.startedAt = Date.now();
    return c;
  });
  // fall through to the parallel-team branch — initDiscussionDir handles the resume.
}
```

- [ ] **Step 5: Run tests and build**

```bash
npm test --workspace=@codey/gateway
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/chat-runner.ts packages/gateway/src/parallel-team.test.ts
git commit -m "feat(gateway): resume parallel discussion on new user message"
```

---

## Task 14: Chat deletion cleans up discussion directory

**Files:**
- Modify: `packages/gateway/src/chats.ts` (the `deleteChat` method)
- Modify: `packages/gateway/src/chats.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it('deletes the discussion directory when the chat is deleted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-del-'));
  const wsRoot = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(wsRoot, 'demo'), { recursive: true });
  const mgr = new ChatManager(wsRoot);
  const chat = await mgr.createChat({ workspaceName: 'demo', title: 't' });
  const discDir = path.join(wsRoot, 'demo', 'chats', chat.id, 'discussion');
  fs.mkdirSync(discDir, { recursive: true });
  fs.writeFileSync(path.join(discDir, 'topic.md'), 'x');
  await mgr.deleteChat(chat.id);
  expect(fs.existsSync(discDir)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=@codey/gateway -- chats.test
```

Expected: FAIL.

- [ ] **Step 3: Update `deleteChat`**

In `chats.ts`, inside `deleteChat` after the chat JSON is removed:

```ts
const discussionDir = path.join(this.workspacesRoot, chat.workspaceName, 'chats', chatId, 'discussion');
if (fs.existsSync(discussionDir)) {
  await fs.promises.rm(discussionDir, { recursive: true, force: true });
}
const chatDir = path.join(this.workspacesRoot, chat.workspaceName, 'chats', chatId);
// rm the per-chat directory too if it is now empty
try {
  if (fs.existsSync(chatDir) && (await fs.promises.readdir(chatDir)).length === 0) {
    await fs.promises.rm(chatDir, { recursive: true });
  }
} catch { /* non-fatal */ }
```

- [ ] **Step 4: Run tests and build**

```bash
npm test --workspace=@codey/gateway -- chats.test
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chats.ts packages/gateway/src/chats.test.ts
git commit -m "feat(chats): remove discussion dir on chat delete"
```

---

## Task 15: User cancellation hook + end-to-end smoke

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (existing `/cancel` or team-pause path)
- Modify: `packages/gateway/src/parallel-team.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it('stops the runner with reason=user_cancel when cancel() is invoked', async () => {
  const managerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* hangs */}));
  const onFinal = vi.fn();
  const r = makeRunner({ managerRunner, onFinal });
  await r.start();
  await r.stop('user_cancel', 'user stopped the discussion');
  expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_cancel' }));
});
```

(This may already pass given Task 8's `stop()` implementation. If so, the test is a regression guard and you commit it as a test-only change.)

- [ ] **Step 2: Wire `/cancel` in gateway**

Find the existing cancellation entry point (search for `team-pause` and `cancel`). For chats with an active parallel run, route cancel to `runner.stop('user_cancel', ...)` and remove the runner from `activeParallelRuns`.

- [ ] **Step 3: Run tests and build**

```bash
npm test --workspace=@codey/gateway
npm run build
```

Expected: PASS, build clean.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/parallel-team.test.ts
git commit -m "feat(gateway): user /cancel stops active parallel discussion"
```

---

## Task 16: README / docs touch-up

**Files:**
- Modify: `README.md` (the existing teams section — search for `dispatch: 'auto'`)

- [ ] **Step 1: Add a parallel-mode subsection**

Document the config shape (`dispatch: 'parallel'` + `parallel: { maxDurationMs, idleTimeoutMs, managerPollMs }`) and link to the spec.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document parallel (roundtable) team dispatch mode"
```

---

## Final Verification

- [ ] Run the full test suite from repo root:

```bash
npm test --workspaces
npm run build
```

Expected: PASS, build clean.

- [ ] Manual smoke: launch the gateway, create a `parallel`-dispatch team in `workspace.json`, send `/team <name> Should we adopt RPC?` from any channel, observe:
  - Discussion dir created under `workspaces/<ws>/chats/<chatId>/discussion/`
  - All worker opinion files populated within ~30s
  - Final message posted to the chat with summary, per-worker excerpts, and terminated_reason
  - Deleting the chat from the Mac sidebar removes the discussion directory.
