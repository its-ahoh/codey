# Branch Picker + Worktrees + Create PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat-header git badge an interactive branch/worktree picker (switch, create, fetch, stash-and-switch, create-in-worktree with per-chat binding) and add a status-panel "Create PR" button gated on task completion.

**Architecture:** New `git:*` IPC handlers in the Electron main process wrap `git`/`gh` via `execFile` (mirroring the existing `git:status` handler). Per-chat worktree binding stores a `workingDirOverride` on the core `Chat` model; the gateway's `resolveChatWorkingDir` honors it so the agent runs in the worktree. The renderer gets pure, unit-tested logic modules (`branchPickerModel.ts`, `createPrModel.ts`), a `useGitBranches` hook that live-updates via a `git:changed` event, a `BranchPicker.tsx` dropdown, and a `Create PR` button + modal in `StatusSidecar`.

**Tech Stack:** Electron (main/preload IPC), React + TypeScript renderer, Vitest (`environment: 'node'`), `git` CLI, `gh` CLI (2.88.1).

**⚠️ Node version:** The default shell node is v16 and CANNOT run vitest/tsc. Before any `npm`/`npx`/`tsc`/`vitest` command in this plan, run `nvm use 22.17.1` (or `source ~/.nvm/nvm.sh && nvm use 22.17.1`). All `Run:` commands below assume node 22 is active.

**Working directory:** `codey-mac/` for renderer/electron tasks; repo root for `packages/*` tasks. Paths below are relative to the repo root `/Users/jackou/Documents/projects/codey`.

---

## File Structure

**Electron main / preload (Phase 1 & 2 wiring):**
- Modify `codey-mac/electron/main.ts` — add `git:branches`, `git:checkout`, `git:stash`, `git:fetch`, `git:worktrees`, `git:worktreeAdd`, `git:createPr`, `git:watch` handlers + `chats:setWorkingDir`.
- Modify `codey-mac/electron/preload.ts` — expose the new `git.*` methods, the `git:changed` subscription, and `chats.setWorkingDir`.
- Modify `codey-mac/src/codey-api.d.ts` — type the new surface.

**Core / gateway (Phase 2 binding):**
- Modify `packages/core/src/types/chat.ts` — add `workingDirOverride?: string`.
- Modify `packages/gateway/src/chats.ts` — add `setWorkingDirOverride`.
- Modify `packages/gateway/src/gateway.ts` — honor override in `resolveChatWorkingDir`.
- Test `packages/gateway/src/chats.test.ts` (or existing chats spec) — cover the setter.

**Renderer logic (Phase 3, TDD):**
- Create `codey-mac/src/components/branchPickerModel.ts` + `branchPickerModel.test.ts`.
- Create `codey-mac/src/components/createPrModel.ts` + `createPrModel.test.ts`.

**Renderer UI (Phases 4-6):**
- Create `codey-mac/src/hooks/useGitBranches.ts`.
- Create `codey-mac/src/components/BranchPicker.tsx`.
- Create `codey-mac/src/components/CreatePrModal.tsx`.
- Modify `codey-mac/src/components/StatusSidecar.tsx` — gated Create PR button.
- Modify `codey-mac/src/components/ChatTab.tsx` — mount BranchPicker, thread `workingDirOverride`, pass PR props to StatusSidecar.
- Modify `codey-mac/src/services/api.ts` — `chats.setWorkingDir` + git helpers if needed.

---

## Phase 1 — Git IPC backend

> These handlers run in the Electron main process and are verified by build + manual smoke test (no vitest for `main.ts`). Each wraps `execFile` like the existing `git:status` at `codey-mac/electron/main.ts:1360`.

### Task 1: `git:branches` handler

**Files:**
- Modify: `codey-mac/electron/main.ts` (insert after the `git:status` handler, ~line 1382)

- [ ] **Step 1: Add the handler**

Insert immediately after the closing `)` of the `git:status` handler (after line 1382):

```ts
  ipcMain.handle('git:branches', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir || typeof workingDir !== 'string') return { current: '', local: [], remote: [] }
      const { execFile } = await import('child_process')
      const run = (args: string[]) => new Promise<string>((resolve, reject) => {
        execFile('git', args, { cwd: workingDir, timeout: 2000 }, (err, stdout) => {
          if (err) reject(err); else resolve(stdout)
        })
      })
      try {
        const [curOut, localOut, remoteOut] = await Promise.all([
          run(['rev-parse', '--abbrev-ref', 'HEAD']),
          run(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
          run(['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
        ])
        const current = curOut.trim() || 'HEAD'
        const local = localOut.split('\n').map(l => l.trim()).filter(Boolean)
        const remote = remoteOut.split('\n').map(l => l.trim())
          .filter(l => l && !l.endsWith('/HEAD'))
        return { current, local, remote }
      } catch {
        return { current: '', local: [], remote: [] }
      }
    })
  )
```

- [ ] **Step 2: Build to typecheck**

Run: `nvm use 22.17.1 && cd codey-mac && npx tsc -p tsconfig.electron.json --noEmit` (if no electron tsconfig, use `npm run build`)
Expected: no type errors. (If the project builds main via `npm run build`, run that and expect success.)

- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:branches IPC handler"
```

### Task 2: `git:checkout` handler (with `reason: 'dirty'`)

**Files:**
- Modify: `codey-mac/electron/main.ts` (after `git:branches`)

- [ ] **Step 1: Add the handler**

```ts
  ipcMain.handle('git:checkout', async (_e, workingDir: string, name: string, opts?: { create?: boolean; track?: boolean }) =>
    wrap(async () => {
      if (!workingDir || !name) return { ok: false, error: 'missing args' }
      const { execFile } = await import('child_process')
      const run = (args: string[]) => new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        execFile('git', args, { cwd: workingDir, timeout: 5000 }, (err, _out, stderr) => {
          resolve({ ok: !err, stderr: stderr || (err ? String(err) : '') })
        })
      })
      const args = opts?.create ? ['checkout', '-b', name]
        : opts?.track ? ['checkout', '--track', name]
        : ['checkout', name]
      const r = await run(args)
      if (r.ok) return { ok: true }
      const dirty = /would be overwritten|Your local changes|commit your changes or stash/i.test(r.stderr)
      return { ok: false, error: r.stderr.trim(), reason: dirty ? 'dirty' as const : undefined }
    })
  )
```

- [ ] **Step 2: Build to typecheck** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:checkout IPC with dirty-tree detection"
```

### Task 3: `git:stash` handler

**Files:**
- Modify: `codey-mac/electron/main.ts` (after `git:checkout`)

- [ ] **Step 1: Add the handler**

```ts
  ipcMain.handle('git:stash', async (_e, workingDir: string, message?: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: false, error: 'missing workingDir' }
      const { execFile } = await import('child_process')
      const args = ['stash', 'push', '-u']
      if (message) args.push('-m', message)
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        execFile('git', args, { cwd: workingDir, timeout: 5000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, error: (stderr || String(err)).trim() })
          else resolve({ ok: true })
        })
      })
    })
  )
```

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:stash IPC handler"
```

### Task 4: `git:fetch` handler

**Files:**
- Modify: `codey-mac/electron/main.ts` (after `git:stash`)

- [ ] **Step 1: Add the handler**

```ts
  ipcMain.handle('git:fetch', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: false, error: 'missing workingDir' }
      const { execFile } = await import('child_process')
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        execFile('git', ['fetch', '--prune'], { cwd: workingDir, timeout: 30000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, error: (stderr || String(err)).trim() })
          else resolve({ ok: true })
        })
      })
    })
  )
```

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:fetch IPC handler"
```

### Task 5: `git:worktrees` handler

**Files:**
- Modify: `codey-mac/electron/main.ts` (after `git:fetch`)

- [ ] **Step 1: Add the handler**

Parses `git worktree list --porcelain`. The first listed worktree is the main one.

```ts
  ipcMain.handle('git:worktrees', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { list: [] }
      const { execFile } = await import('child_process')
      const out = await new Promise<string>((resolve) => {
        execFile('git', ['worktree', 'list', '--porcelain'], { cwd: workingDir, timeout: 3000 }, (err, stdout) => {
          resolve(err ? '' : stdout)
        })
      })
      const list: { branch: string; path: string; isMain: boolean }[] = []
      let cur: { path?: string; branch?: string } = {}
      for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) cur = { path: line.slice('worktree '.length).trim() }
        else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
        else if (line.trim() === '' && cur.path) {
          list.push({ path: cur.path, branch: cur.branch || '(detached)', isMain: list.length === 0 })
          cur = {}
        }
      }
      if (cur.path) list.push({ path: cur.path, branch: cur.branch || '(detached)', isMain: list.length === 0 })
      return { list }
    })
  )
```

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:worktrees IPC handler"
```

### Task 6: `git:worktreeAdd` handler

**Files:**
- Modify: `codey-mac/electron/main.ts` (after `git:worktrees`)

- [ ] **Step 1: Add the handler**

```ts
  ipcMain.handle('git:worktreeAdd', async (_e, workingDir: string, args2: { name: string; path: string }) =>
    wrap(async () => {
      if (!workingDir || !args2?.name || !args2?.path) return { ok: false, error: 'missing args' }
      const { execFile } = await import('child_process')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const target = pathMod.resolve(args2.path)
      fsMod.mkdirSync(pathMod.dirname(target), { recursive: true })
      return await new Promise<{ ok: boolean; path?: string; error?: string }>((resolve) => {
        execFile('git', ['worktree', 'add', target, '-b', args2.name], { cwd: workingDir, timeout: 20000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, error: (stderr || String(err)).trim() })
          else resolve({ ok: true, path: target })
        })
      })
    })
  )
```

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:worktreeAdd IPC handler"
```

### Task 7: `git:createPr` handler

**Files:**
- Modify: `codey-mac/electron/main.ts` (after `git:worktreeAdd`)

- [ ] **Step 1: Add the handler**

Pushes the branch (sets upstream if missing), then runs `gh pr create`, returning the PR URL parsed from stdout.

```ts
  ipcMain.handle('git:createPr', async (_e, workingDir: string, input: { title: string; body: string }) =>
    wrap(async () => {
      if (!workingDir || !input?.title) return { ok: false, error: 'missing args' }
      const { execFile } = await import('child_process')
      const run = (cmd: string, args: string[], timeout: number) => new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
        execFile(cmd, args, { cwd: workingDir, timeout }, (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err ? String(err) : '') })
        })
      })
      // Resolve current branch
      const br = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 3000)
      const branch = br.stdout.trim()
      if (!branch || branch === 'HEAD') return { ok: false, error: 'Not on a branch' }
      // Push with upstream (no-op if already pushed; -u is safe to repeat)
      const push = await run('git', ['push', '-u', 'origin', branch], 60000)
      if (!push.ok) return { ok: false, error: (push.stderr || 'git push failed').trim() }
      // Create PR
      const pr = await run('gh', ['pr', 'create', '--title', input.title, '--body', input.body || '', '--head', branch], 60000)
      if (!pr.ok) return { ok: false, error: (pr.stderr || 'gh pr create failed').trim() }
      const url = (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || pr.stdout.trim()
      return { ok: true, url }
    })
  )
```

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:createPr IPC (push + gh pr create)"
```

### Task 8: `git:watch` handler + `git:changed` event

**Files:**
- Modify: `codey-mac/electron/main.ts` (after `git:createPr`)

- [ ] **Step 1: Add a module-level watcher registry near the other top-level handler state**

Find where other `ipcMain.handle` registrations live (inside the same setup function as `git:status`). At the top of that function body add a watcher map (place it just before the `git:status` handler):

```ts
  // Live git branch watching: one fs.watch per workingDir, ref-counted by renderer subscriptions.
  const gitWatchers = new Map<string, { watcher: import('fs').FSWatcher; count: number; timer: NodeJS.Timeout | null }>()
```

- [ ] **Step 2: Add the `git:watch` / `git:unwatch` handlers** (after `git:createPr`)

```ts
  ipcMain.handle('git:watch', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: false }
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const gitDir = pathMod.join(workingDir, '.git')
      const headPath = pathMod.join(gitDir, 'HEAD')
      const existing = gitWatchers.get(workingDir)
      if (existing) { existing.count++; return { ok: true } }
      try {
        const emit = () => {
          const entry = gitWatchers.get(workingDir)
          if (!entry) return
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = setTimeout(() => sendToRenderer('git:changed', { workingDir }), 200)
        }
        // Watch the .git dir non-recursively; HEAD + refs changes bubble as rename/change events.
        const watcher = fsMod.watch(gitDir, { persistent: false }, () => emit())
        gitWatchers.set(workingDir, { watcher, count: 1, timer: null })
        // Fire once so the renderer pulls fresh status immediately.
        void headPath
        return { ok: true }
      } catch {
        return { ok: false }
      }
    })
  )

  ipcMain.handle('git:unwatch', async (_e, workingDir: string) =>
    wrap(async () => {
      const entry = gitWatchers.get(workingDir)
      if (!entry) return { ok: true }
      entry.count--
      if (entry.count <= 0) {
        if (entry.timer) clearTimeout(entry.timer)
        try { entry.watcher.close() } catch { /* ignore */ }
        gitWatchers.delete(workingDir)
      }
      return { ok: true }
    })
  )
```

> Note: `sendToRenderer` is already used throughout `main.ts` (e.g. line 2176). Confirm its in-scope name; if it differs, match the existing call sites.

- [ ] **Step 3: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): git:watch fs.watch + git:changed event"
```

### Task 9: Preload + type surface for all git IPC

**Files:**
- Modify: `codey-mac/electron/preload.ts:153-155` (the `git:` block)
- Modify: `codey-mac/src/codey-api.d.ts:150-152` (the `git:` block)

- [ ] **Step 1: Replace the preload `git` block**

Replace:

```ts
  git: {
    status: (workingDir: string) => ipcRenderer.invoke('git:status', workingDir),
  },
```

with:

```ts
  git: {
    status: (workingDir: string) => ipcRenderer.invoke('git:status', workingDir),
    branches: (workingDir: string) => ipcRenderer.invoke('git:branches', workingDir),
    checkout: (workingDir: string, name: string, opts?: { create?: boolean; track?: boolean }) =>
      ipcRenderer.invoke('git:checkout', workingDir, name, opts),
    stash: (workingDir: string, message?: string) => ipcRenderer.invoke('git:stash', workingDir, message),
    fetch: (workingDir: string) => ipcRenderer.invoke('git:fetch', workingDir),
    worktrees: (workingDir: string) => ipcRenderer.invoke('git:worktrees', workingDir),
    worktreeAdd: (workingDir: string, args: { name: string; path: string }) =>
      ipcRenderer.invoke('git:worktreeAdd', workingDir, args),
    createPr: (workingDir: string, input: { title: string; body: string }) =>
      ipcRenderer.invoke('git:createPr', workingDir, input),
    watch: (workingDir: string) => ipcRenderer.invoke('git:watch', workingDir),
    unwatch: (workingDir: string) => ipcRenderer.invoke('git:unwatch', workingDir),
    onChanged: (handler: (ev: { workingDir: string }) => void) => {
      const listener = (_e: unknown, ev: { workingDir: string }) => handler(ev)
      ipcRenderer.on('git:changed', listener)
      return () => ipcRenderer.removeListener('git:changed', listener)
    },
  },
```

- [ ] **Step 2: Replace the `git` block in `codey-api.d.ts`**

```ts
      git: {
        status: (workingDir: string) => Promise<IpcResult<{ branch: string; dirty: number } | null>>
        branches: (workingDir: string) => Promise<IpcResult<{ current: string; local: string[]; remote: string[] }>>
        checkout: (workingDir: string, name: string, opts?: { create?: boolean; track?: boolean }) => Promise<IpcResult<{ ok: boolean; error?: string; reason?: 'dirty' }>>
        stash: (workingDir: string, message?: string) => Promise<IpcResult<{ ok: boolean; error?: string }>>
        fetch: (workingDir: string) => Promise<IpcResult<{ ok: boolean; error?: string }>>
        worktrees: (workingDir: string) => Promise<IpcResult<{ list: { branch: string; path: string; isMain: boolean }[] }>>
        worktreeAdd: (workingDir: string, args: { name: string; path: string }) => Promise<IpcResult<{ ok: boolean; path?: string; error?: string }>>
        createPr: (workingDir: string, input: { title: string; body: string }) => Promise<IpcResult<{ ok: boolean; url?: string; error?: string }>>
        watch: (workingDir: string) => Promise<IpcResult<{ ok: boolean }>>
        unwatch: (workingDir: string) => Promise<IpcResult<{ ok: boolean }>>
        onChanged: (handler: (ev: { workingDir: string }) => void) => () => void
      }
```

- [ ] **Step 3: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): expose git branch/worktree/PR IPC in preload + types"
```

---

## Phase 2 — Per-chat worktree binding (core + gateway)

### Task 10: Add `workingDirOverride` to the core Chat type

**Files:**
- Modify: `packages/core/src/types/chat.ts:92+` (the `Chat` interface)

- [ ] **Step 1: Add the field**

After the `model?: string;` field (or any existing optional field) in the `Chat` interface, add:

```ts
  /** Per-chat working-directory override (absolute path). When set, the agent
   *  runs here instead of the workspace's workingDir — used to bind a chat to a
   *  git worktree. Cleared (deleted) to fall back to the workspace dir. */
  workingDirOverride?: string;
```

- [ ] **Step 2: Build core** — Run: `nvm use 22.17.1 && npm run build -w @codey/core` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/chat.ts
git commit -m "feat(core): Chat.workingDirOverride for worktree binding"
```

### Task 11: `setWorkingDirOverride` on ChatManager (TDD)

**Files:**
- Modify: `packages/gateway/src/chats.ts` (after `setSoloAdvisor`, ~line 229)
- Test: `packages/gateway/src/chats.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

If `packages/gateway/src/chats.test.ts` does not exist, create it with the standard header; otherwise add this `describe`. Mirror existing ChatManager test setup (a temp workspaces root). Minimal standalone test:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

describe('ChatManager.setWorkingDirOverride', () => {
  let root: string;
  let mgr: ChatManager;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  it('sets and clears the override', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    const set = mgr.setWorkingDirOverride(chat.id, '/tmp/wt');
    expect(set.workingDirOverride).toBe('/tmp/wt');
    const cleared = mgr.setWorkingDirOverride(chat.id, null);
    expect(cleared.workingDirOverride).toBeUndefined();
  });
});
```

> Verify `new ChatManager(root)` matches the real constructor signature in `chats.ts:26`; adjust the setup to match existing tests in the gateway package if the constructor differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 22.17.1 && npm test -w @codey/gateway -- chats.test`
Expected: FAIL — `setWorkingDirOverride is not a function`.

- [ ] **Step 3: Implement the method**

In `packages/gateway/src/chats.ts`, after `setSoloAdvisor` (line ~229):

```ts
  /** Set or clear the per-chat working-directory override (worktree binding).
   *  Pass null/undefined/'' to clear and fall back to the workspace dir. */
  setWorkingDirOverride(chatId: string, dir: string | null): Chat {
    const chat = this.requireChat(chatId);
    if (dir === null || dir === undefined || dir === '') delete chat.workingDirOverride;
    else chat.workingDirOverride = dir;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 22.17.1 && npm test -w @codey/gateway -- chats.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chats.ts packages/gateway/src/chats.test.ts
git commit -m "feat(gateway): ChatManager.setWorkingDirOverride + test"
```

### Task 12: Honor the override in `resolveChatWorkingDir`

**Files:**
- Modify: `packages/gateway/src/gateway.ts:836-846`

- [ ] **Step 1: Edit the method**

Change the start of `resolveChatWorkingDir` (line 836) to short-circuit on the override:

```ts
  private resolveChatWorkingDir(chat: Chat): string {
    if (chat.workingDirOverride && fs.existsSync(chat.workingDirOverride)) {
      return chat.workingDirOverride;
    }
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, chat.workspaceName, 'workspace.json');
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
        if (wsConfig.workingDir) return wsConfig.workingDir;
      } catch { /* fall through */ }
    }
    return this.workingDir;
  }
```

- [ ] **Step 2: Build gateway** — Run: `nvm use 22.17.1 && npm run build -w @codey/gateway` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): resolveChatWorkingDir honors chat.workingDirOverride"
```

### Task 13: `chats:setWorkingDir` IPC chain

**Files:**
- Modify: `codey-mac/electron/main.ts` (near `chats:setSoloAdvisor`, ~line 2263)
- Modify: `codey-mac/electron/preload.ts` (near `setSoloAdvisor`, ~line 120)
- Modify: `codey-mac/src/codey-api.d.ts:129` (chats block)
- Modify: `codey-mac/src/services/api.ts:197` (chats setters)

- [ ] **Step 1: main.ts handler**

```ts
  ipcMain.handle('chats:setWorkingDir', async (_e, id: string, dir: string | null) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().setWorkingDirOverride(id, dir)
    })
  )
```

- [ ] **Step 2: preload.ts** (in the `chats` block)

```ts
    setWorkingDir: (id: string, dir: string | null) =>
      ipcRenderer.invoke('chats:setWorkingDir', id, dir),
```

- [ ] **Step 3: codey-api.d.ts** (in the `chats` block, near `setSoloAdvisor`)

```ts
        setWorkingDir: (id: string, dir: string | null) => Promise<IpcResult<Chat>>
```

- [ ] **Step 4: api.ts** (in the `chats` object, near `setSoloAdvisor`)

```ts
    setWorkingDir: async (id: string, dir: string | null): Promise<Chat> =>
      unwrap(await window.codey.chats.setWorkingDir(id, dir)),
```

- [ ] **Step 5: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 6: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts codey-mac/src/services/api.ts
git commit -m "feat(mac): chats:setWorkingDir IPC chain"
```

---

## Phase 3 — Renderer logic modules (TDD)

### Task 14: `branchPickerModel.ts` (pure logic) + test

**Files:**
- Create: `codey-mac/src/components/branchPickerModel.ts`
- Test: `codey-mac/src/components/branchPickerModel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { filterBranches, defaultWorktreePath, partitionWorktrees } from './branchPickerModel';

describe('filterBranches', () => {
  it('returns all when query empty', () => {
    expect(filterBranches(['main', 'dev'], '')).toEqual(['main', 'dev']);
  });
  it('is case-insensitive substring match', () => {
    expect(filterBranches(['Main', 'feature/x', 'dev'], 'fe')).toEqual(['feature/x']);
  });
});

describe('defaultWorktreePath', () => {
  it('builds an in-repo .codey/worktrees path with sanitized branch', () => {
    expect(defaultWorktreePath('/home/u/repo', 'feat/cool thing'))
      .toBe('/home/u/repo/.codey/worktrees/feat-cool-thing');
  });
});

describe('partitionWorktrees', () => {
  it('splits main from the rest', () => {
    const { main, others } = partitionWorktrees([
      { branch: 'main', path: '/r', isMain: true },
      { branch: 'feat', path: '/r2', isMain: false },
    ]);
    expect(main?.branch).toBe('main');
    expect(others.map(w => w.branch)).toEqual(['feat']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 22.17.1 && cd codey-mac && npx vitest run src/components/branchPickerModel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
import * as path from 'path';

export interface Worktree { branch: string; path: string; isMain: boolean }
export interface BranchData { current: string; local: string[]; remote: string[] }

/** Case-insensitive substring filter; empty query returns the list unchanged. */
export function filterBranches(list: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(b => b.toLowerCase().includes(q));
}

/** Default worktree location: `<repo>/.codey/worktrees/<branch>` (in-repo, gitignored). */
export function defaultWorktreePath(repoPath: string, branchName: string): string {
  const root = repoPath.replace(/\/+$/, '');
  const safe = branchName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${root}/.codey/worktrees/${safe}`;
}

/** Separate the main worktree from the rest for display. */
export function partitionWorktrees(list: Worktree[]): { main?: Worktree; others: Worktree[] } {
  const main = list.find(w => w.isMain);
  const others = list.filter(w => !w.isMain);
  return { main, others };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 22.17.1 && cd codey-mac && npx vitest run src/components/branchPickerModel.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/branchPickerModel.ts codey-mac/src/components/branchPickerModel.test.ts
git commit -m "feat(mac): branchPickerModel pure logic + tests"
```

### Task 15: `createPrModel.ts` (gating + title) + test

**Files:**
- Create: `codey-mac/src/components/createPrModel.ts`
- Test: `codey-mac/src/components/createPrModel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createPrButtonState, defaultPrTitle } from './createPrModel';

describe('createPrButtonState', () => {
  it('hidden while working/blocked', () => {
    expect(createPrButtonState('working', true).show).toBe(false);
    expect(createPrButtonState('blocked', true).show).toBe(false);
  });
  it('shown when waiting or done', () => {
    expect(createPrButtonState('waiting', true).show).toBe(true);
    expect(createPrButtonState('done', false).show).toBe(true);
  });
  it('enabled only when branch is ahead', () => {
    expect(createPrButtonState('done', true).enabled).toBe(true);
    expect(createPrButtonState('done', false).enabled).toBe(false);
  });
});

describe('defaultPrTitle', () => {
  it('prefers the commit subject', () => {
    expect(defaultPrTitle('  Add cool thing ', 'feat/x')).toBe('Add cool thing');
  });
  it('falls back to the branch name', () => {
    expect(defaultPrTitle('', 'feat/x')).toBe('feat/x');
    expect(defaultPrTitle(undefined, 'feat/x')).toBe('feat/x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 22.17.1 && cd codey-mac && npx vitest run src/components/createPrModel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
import type { TaskBrief } from '../types';

type Status = TaskBrief['state']['status'];

/** Button visibility/enablement: visible when the agent has fulfilled the task
 *  (waiting on the user, or done); enabled only when there are commits to PR. */
export function createPrButtonState(status: Status, branchAhead: boolean): { show: boolean; enabled: boolean } {
  const show = status === 'waiting' || status === 'done';
  return { show, enabled: show && branchAhead };
}

/** Default PR title: trimmed commit subject, falling back to the branch name. */
export function defaultPrTitle(commitSubject: string | undefined, branch: string): string {
  const s = (commitSubject ?? '').trim();
  return s || branch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 22.17.1 && cd codey-mac && npx vitest run src/components/createPrModel.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/createPrModel.ts codey-mac/src/components/createPrModel.test.ts
git commit -m "feat(mac): createPrModel gating + title logic + tests"
```

---

## Phase 4 — `useGitBranches` hook

### Task 16: Live-updating branch/worktree hook

**Files:**
- Create: `codey-mac/src/hooks/useGitBranches.ts`

- [ ] **Step 1: Implement the hook**

Extends the `useGitStatus` pattern: pulls status + branches + worktrees, subscribes to `git:changed`, registers/tears down the watcher, and exposes mutating actions.

```ts
import { useState, useEffect, useCallback } from 'react'
import type { Worktree } from '../components/branchPickerModel'

export interface BranchState {
  branch: string
  dirty: number
  local: string[]
  remote: string[]
  worktrees: Worktree[]
}

export function useGitBranches(workingDir: string | undefined) {
  const [state, setState] = useState<BranchState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workingDir) { setState(null); return }
    try {
      const [s, b, w] = await Promise.all([
        window.codey.git.status(workingDir),
        window.codey.git.branches(workingDir),
        window.codey.git.worktrees(workingDir),
      ])
      if (!s.ok || !s.data) { setState(null); return }
      const br = b.ok ? b.data : { current: s.data.branch, local: [], remote: [] }
      const wl = w.ok ? w.data.list : []
      setState({ branch: s.data.branch, dirty: s.data.dirty, local: br.local, remote: br.remote, worktrees: wl })
    } catch { setState(null) }
  }, [workingDir])

  useEffect(() => { void refresh() }, [refresh])

  // Live updates: watch .git and re-pull on change. Polling fallback every 5s.
  useEffect(() => {
    if (!workingDir) return
    void window.codey.git.watch(workingDir)
    const off = window.codey.git.onChanged(ev => { if (ev.workingDir === workingDir) void refresh() })
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const poll = setInterval(() => void refresh(), 5000)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      clearInterval(poll)
      void window.codey.git.unwatch(workingDir)
    }
  }, [workingDir, refresh])

  const checkout = useCallback(async (name: string, opts?: { create?: boolean; track?: boolean }) => {
    if (!workingDir) return { ok: false, error: 'no dir' }
    setError(null)
    const r = await window.codey.git.checkout(workingDir, name, opts)
    if (r.ok) await refresh()
    else if (r.data?.reason !== 'dirty') setError(r.data?.error || r.error || 'checkout failed')
    return r.ok ? { ok: true } : { ok: false, error: r.data?.error, reason: r.data?.reason }
  }, [workingDir, refresh])

  const stashAndSwitch = useCallback(async (name: string) => {
    if (!workingDir) return { ok: false }
    const st = await window.codey.git.stash(workingDir, `codey-mac: switch to ${name}`)
    if (!st.ok || !st.data?.ok) { setError(st.data?.error || 'stash failed'); return { ok: false } }
    const co = await window.codey.git.checkout(workingDir, name)
    if (co.ok && co.data?.ok) { await refresh(); return { ok: true } }
    setError(co.data?.error || 'checkout failed'); return { ok: false }
  }, [workingDir, refresh])

  const createBranch = useCallback(async (name: string) => checkout(name, { create: true }), [checkout])

  const fetchRemote = useCallback(async () => {
    if (!workingDir) return
    const r = await window.codey.git.fetch(workingDir)
    if (r.ok && r.data?.ok) await refresh()
    else setError(r.data?.error || 'fetch failed')
  }, [workingDir, refresh])

  const addWorktree = useCallback(async (name: string, path: string) => {
    if (!workingDir) return { ok: false }
    const r = await window.codey.git.worktreeAdd(workingDir, { name, path })
    if (r.ok && r.data?.ok) { await refresh(); return { ok: true, path: r.data.path } }
    setError(r.data?.error || 'worktree add failed'); return { ok: false }
  }, [workingDir, refresh])

  return { state, error, setError, refresh, checkout, stashAndSwitch, createBranch, fetchRemote, addWorktree }
}
```

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/hooks/useGitBranches.ts
git commit -m "feat(mac): useGitBranches hook with live git:changed updates"
```

---

## Phase 5 — Components

### Task 17: `BranchPicker.tsx` dropdown + header pill

**Files:**
- Create: `codey-mac/src/components/BranchPicker.tsx`

- [ ] **Step 1: Implement the component**

A pill button that opens a dropdown (filter, local branches, remote, worktrees, create row with the worktree-default toggle, dirty prompt). Consumes `useGitBranches` and the pure models. Calls `onBindWorktree(path | null)` to update the chat binding.

```tsx
import React, { useMemo, useRef, useState, useEffect } from 'react'
import { C } from '../theme'
import { useGitBranches } from '../hooks/useGitBranches'
import { filterBranches, defaultWorktreePath, partitionWorktrees } from './branchPickerModel'

interface Props {
  workingDir: string | undefined
  repoRoot: string | undefined           // for default worktree path; falls back to workingDir
  boundWorktreePath?: string             // chat.workingDirOverride
  onBindWorktree: (path: string | null) => void
}

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'dirty'; target: string }

export const BranchPicker: React.FC<Props> = ({ workingDir, repoRoot, boundWorktreePath, onBindWorktree }) => {
  const git = useGitBranches(workingDir)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [newName, setNewName] = useState('')
  const [useWorktree, setUseWorktree] = useState(true)   // worktree is the DEFAULT
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const s = git.state
  const { main, others } = useMemo(() => partitionWorktrees(s?.worktrees ?? []), [s])
  const localFiltered = useMemo(() => filterBranches(s?.local ?? [], query), [s, query])
  const remoteFiltered = useMemo(() => filterBranches(s?.remote ?? [], query), [s, query])
  const repo = repoRoot || workingDir || ''
  const previewPath = useWorktree && newName ? defaultWorktreePath(repo, newName) : ''
  const boundLabel = others.find(w => w.path === boundWorktreePath)?.branch

  const doSwitch = async (name: string) => {
    const r = await git.checkout(name)
    if (r.ok) { setOpen(false); return }
    if (r.reason === 'dirty') setMode({ kind: 'dirty', target: name })
  }

  const doCreate = async () => {
    if (!newName.trim()) return
    if (useWorktree) {
      const r = await git.addWorktree(newName.trim(), defaultWorktreePath(repo, newName.trim()))
      if (r.ok && r.path) { onBindWorktree(r.path); setOpen(false) }
    } else {
      const r = await git.createBranch(newName.trim())
      if (r.ok) { setOpen(false) }
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={styles.pill} onClick={() => setOpen(o => !o)} title="Branch & worktree">
        <span>⎇ {s?.branch ?? '—'}</span>
        {s && s.dirty > 0 && <span style={styles.dirty}>+{s.dirty}</span>}
        {boundLabel && <span style={styles.wt}>🌳 {boundLabel}</span>}
        <span style={styles.caret}>▾</span>
      </button>

      {open && (
        <div style={styles.menu}>
          {mode.kind === 'dirty' ? (
            <div style={styles.section}>
              <div style={styles.warn}>Switching would overwrite local changes.</div>
              <div style={styles.row}>
                <button style={styles.primary} onClick={async () => {
                  const r = await git.stashAndSwitch(mode.target)
                  if (r.ok) { setNote('Local changes stashed — restore with `git stash pop`'); setMode({ kind: 'list' }); setOpen(false) }
                }}>Stash & switch</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
          ) : mode.kind === 'create' ? (
            <div style={styles.section}>
              <input autoFocus placeholder="new-branch-name" value={newName}
                onChange={e => setNewName(e.target.value)} style={styles.input} />
              <div style={styles.toggle}>
                <button style={useWorktree ? styles.segOn : styles.seg} onClick={() => setUseWorktree(true)}>In a new worktree</button>
                <button style={!useWorktree ? styles.segOn : styles.seg} onClick={() => setUseWorktree(false)}>On current checkout</button>
              </div>
              {previewPath && <div style={styles.preview}>{previewPath}</div>}
              <div style={styles.row}>
                <button style={styles.primary} onClick={doCreate}>Create</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <input placeholder="Filter branches…" value={query}
                onChange={e => setQuery(e.target.value)} style={styles.input} />
              <div style={styles.scroll}>
                {localFiltered.map(b => (
                  <button key={b} style={styles.item} disabled={b === s?.branch} onClick={() => doSwitch(b)}>
                    {b === s?.branch ? '✓ ' : ''}{b}
                  </button>
                ))}
                {remoteFiltered.length > 0 && <div style={styles.divider}>Remote</div>}
                {remoteFiltered.map(b => (
                  <button key={b} style={styles.item} onClick={() => git.checkout(b.replace(/^[^/]+\//, ''), { track: true }).then(() => setOpen(false))}>
                    {b}
                  </button>
                ))}
                {others.length > 0 && <div style={styles.divider}>Worktrees</div>}
                {main && (
                  <button style={styles.item} onClick={() => { onBindWorktree(null); setOpen(false) }}>
                    {!boundWorktreePath ? '✓ ' : ''}{main.branch} (main)
                  </button>
                )}
                {others.map(w => (
                  <button key={w.path} style={styles.item} onClick={() => { onBindWorktree(w.path); setOpen(false) }}>
                    {w.path === boundWorktreePath ? '✓ ' : ''}🌳 {w.branch}
                  </button>
                ))}
              </div>
              {git.error && <div style={styles.err}>{git.error}</div>}
              {note && <div style={styles.noteBox}>{note}</div>}
              <div style={styles.footer}>
                <button style={styles.ghost} onClick={() => { setNewName(''); setUseWorktree(true); setMode({ kind: 'create' }) }}>+ New branch…</button>
                <button style={styles.ghost} onClick={() => git.fetchRemote()}>Fetch remote</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  pill: { display: 'inline-flex', alignItems: 'center', gap: 6, color: C.fg2, fontSize: 11,
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '2px 6px',
    fontFamily: 'SF Mono, Menlo, monospace', cursor: 'pointer', flexShrink: 0, maxWidth: 260,
    overflow: 'hidden', whiteSpace: 'nowrap' },
  dirty: { color: C.yellow, opacity: 0.85 },
  wt: { color: C.green },
  caret: { color: C.fg3 },
  menu: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20, width: 280,
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  scroll: { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  item: { textAlign: 'left', background: 'transparent', border: 'none', color: C.fg, fontSize: 12,
    padding: '6px 8px', borderRadius: 6, cursor: 'pointer' },
  divider: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: C.fg3, padding: '8px 8px 2px' },
  input: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg,
    fontSize: 12, padding: '5px 8px', outline: 'none' },
  toggle: { display: 'flex', gap: 4 },
  seg: { flex: 1, background: C.surface3, border: `1px solid ${C.border2}`, color: C.fg2, fontSize: 11,
    padding: '5px 6px', borderRadius: 6, cursor: 'pointer' },
  segOn: { flex: 1, background: C.accent, border: `1px solid ${C.accent}`, color: '#fff', fontSize: 11,
    padding: '5px 6px', borderRadius: 6, cursor: 'pointer' },
  preview: { fontSize: 10, color: C.fg3, fontFamily: 'SF Mono, Menlo, monospace', wordBreak: 'break-all' },
  row: { display: 'flex', gap: 6 },
  primary: { background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  ghost: { background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  footer: { display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.border}`, paddingTop: 6 },
  warn: { fontSize: 12, color: C.yellow },
  err: { fontSize: 11, color: C.red, padding: '2px 4px' },
  noteBox: { fontSize: 11, color: C.fg3, padding: '2px 4px' },
}
```

> Verify theme tokens `C.yellow`, `C.green`, `C.red`, `C.accent`, `C.surface2/3`, `C.border/border2`, `C.fg/fg2/fg3` exist in `src/theme.ts` (they're used in StatusSidecar). Adjust names if any differ.

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/BranchPicker.tsx
git commit -m "feat(mac): BranchPicker dropdown (switch/create/fetch/worktree/stash)"
```

### Task 18: Mount BranchPicker in the chat header + thread the binding

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx:442-449` (workingDir derivation) and `:912-918` (header badge)

- [ ] **Step 1: Derive the effective working dir from the chat override**

Replace the `workingDir` effect (lines 442-448) so the chat's `workingDirOverride` wins:

```tsx
  const [workspaceDir, setWorkspaceDir] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!chat?.workspaceName) return
    apiService.getWorkspaceInfo(chat.workspaceName)
      .then(info => setWorkspaceDir(info.workingDir))
      .catch(() => setWorkspaceDir(undefined))
  }, [chat?.workspaceName])
  const workingDir = chat?.workingDirOverride || workspaceDir
```

> Remove the now-unused `useGitStatus` import/usage if the new picker replaces the badge; keep `gitStatus` only if other code references it. If `gitStatus` is still referenced (e.g. for the PR button's dirty count), keep `const { status: gitStatus, refresh: refreshGit } = useGitStatus(workingDir)`.

- [ ] **Step 2: Replace the badge with BranchPicker**

Replace lines 914-918 (the `{gitStatus && (<span style={styles.gitBadge} …>)}` block) with:

```tsx
        <BranchPicker
          workingDir={workingDir}
          repoRoot={workspaceDir}
          boundWorktreePath={chat?.workingDirOverride}
          onBindWorktree={async (path) => {
            if (!chat) return
            await apiService.chats.setWorkingDir(chat.id, path)
            await refreshChat(chat.id)   // re-fetch so workingDirOverride updates locally
          }}
        />
```

> Wire `refreshChat` from the chats hook in scope (the same mechanism used after `setSoloAdvisor`/`updateAgentModel`). If ChatTab already exposes a chat-refresh callback prop, use it; otherwise call the `useChats` refresh for this chat id.

- [ ] **Step 3: Add the import** near the other component imports (top of ChatTab.tsx):

```tsx
import { BranchPicker } from './BranchPicker'
```

- [ ] **Step 4: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): mount BranchPicker in chat header + worktree binding"
```

### Task 19: `CreatePrModal.tsx`

**Files:**
- Create: `codey-mac/src/components/CreatePrModal.tsx`

- [ ] **Step 1: Implement the modal**

```tsx
import React, { useState } from 'react'
import { C } from '../theme'

interface Props {
  defaultTitle: string
  onCancel: () => void
  onCreate: (input: { title: string; body: string }) => Promise<{ ok: boolean; url?: string; error?: string }>
}

export const CreatePrModal: React.FC<Props> = ({ defaultTitle, onCancel, onCreate }) => {
  const [title, setTitle] = useState(defaultTitle)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true); setError(null)
    const r = await onCreate({ title: title.trim(), body })
    setBusy(false)
    if (r.ok && r.url) setUrl(r.url)
    else setError(r.error || 'Failed to create PR')
  }

  return (
    <div style={styles.backdrop} onClick={onCancel}>
      <div style={styles.card} onClick={e => e.stopPropagation()}>
        <div style={styles.head}>Create Pull Request</div>
        {url ? (
          <>
            <div style={styles.success}>PR created.</div>
            <button style={styles.primary} onClick={() => window.codey.openExternal?.(url) ?? window.open(url)}>Open PR</button>
            <button style={styles.ghost} onClick={onCancel}>Close</button>
          </>
        ) : (
          <>
            <label style={styles.label}>Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} style={styles.input} />
            <label style={styles.label}>Description</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} style={styles.textarea} rows={5} />
            {error && <div style={styles.err}>{error}</div>}
            <div style={styles.row}>
              <button style={styles.primary} disabled={busy || !title.trim()} onClick={submit}>{busy ? 'Creating…' : 'Create PR'}</button>
              <button style={styles.ghost} onClick={onCancel}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { width: 420, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  head: { fontSize: 14, fontWeight: 600, color: C.fg },
  label: { fontSize: 11, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg, fontSize: 13, padding: '6px 8px', outline: 'none' },
  textarea: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg, fontSize: 13, padding: '6px 8px', outline: 'none', resize: 'vertical' },
  row: { display: 'flex', gap: 8, marginTop: 4 },
  primary: { background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  ghost: { background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  success: { fontSize: 13, color: C.green },
  err: { fontSize: 12, color: C.red },
}
```

> Check how the app opens external URLs elsewhere (e.g. `shell.openExternal` via an existing `openExternal` IPC). If there's no `window.codey.openExternal`, add a tiny `shell:openExternal` IPC mirroring the createPr pattern, or use an `<a target="_blank">`. Match the existing convention used by `UpdateButton.tsx`/notification links.

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/CreatePrModal.tsx
git commit -m "feat(mac): CreatePrModal"
```

### Task 20: Create PR button in StatusSidecar

**Files:**
- Modify: `codey-mac/src/components/StatusSidecar.tsx`

- [ ] **Step 1: Extend Props and render the gated button**

Add to the `Props` interface:

```tsx
  /** Branch is ahead of the default branch (has commits to PR). */
  branchAhead?: boolean
  /** Open the Create PR flow. Only invoked when the button is enabled. */
  onCreatePr?: () => void
```

Add the import at the top:

```tsx
import { createPrButtonState } from './createPrModel'
```

Inside the component body (before `return`), compute state:

```tsx
  const prState = createPrButtonState(view.status, !!branchAhead)
```

Render the button inside the expanded branch, right after the `nextBox` block (after line ~86), and also in the collapsed `statusRow` is not needed — keep it in the expanded view:

```tsx
          {prState.show && (
            <button
              style={{ ...styles.prBtn, opacity: prState.enabled ? 1 : 0.5, cursor: prState.enabled ? 'pointer' : 'not-allowed' }}
              disabled={!prState.enabled}
              title={prState.enabled ? 'Create a pull request' : 'No commits to PR'}
              onClick={(e) => { e.stopPropagation(); if (prState.enabled) onCreatePr?.() }}
            >
              Create PR →
            </button>
          )}
```

Add the style to the `styles` object:

```tsx
  prBtn: { marginTop: 4, width: '100%', background: C.green, color: '#0b0b0b', border: 'none',
    borderRadius: 8, padding: '8px 10px', fontSize: 12, fontWeight: 600 },
```

> `onClick` calls `e.stopPropagation()` because the whole card has an `onOpen` click handler (line 35) — the button must not also open the panel.

- [ ] **Step 2: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/StatusSidecar.tsx
git commit -m "feat(mac): gated Create PR button in StatusSidecar"
```

### Task 21: Wire StatusSidecar PR props + modal in ChatTab

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx` (the StatusSidecar render ~line 1505, plus modal state)

- [ ] **Step 1: Add PR modal state + branch-ahead derivation**

Near the other `useState` declarations in ChatTab:

```tsx
  const [showPrModal, setShowPrModal] = useState(false)
  const [branchAhead, setBranchAhead] = useState(false)
  useEffect(() => {
    if (!workingDir) { setBranchAhead(false); return }
    // Ahead of upstream OR has commits vs default: a dirty tree or any local-ahead counts as "something to PR".
    window.codey.git.status(workingDir).then(r => {
      setBranchAhead(!!r.ok && !!r.data && (r.data.dirty > 0 || r.data.branch !== 'main'))
    }).catch(() => setBranchAhead(false))
  }, [workingDir, gitStatus])
```

> This is a heuristic (non-main branch or dirty tree ⇒ likely something to PR). A precise `git rev-list --count main..HEAD` could replace it later; out of scope for v1.

- [ ] **Step 2: Pass props to StatusSidecar** (in the render block ~line 1505):

```tsx
          <StatusSidecar
            view={extractSidecarBrief(chat.taskBrief)}
            loading={taskBriefLoading}
            width={SIDECAR_W}
            onOpen={() => { setContextPanelOpen(chat.id, true); setPanelTab('task') }}
            branchAhead={branchAhead}
            onCreatePr={() => setShowPrModal(true)}
          />
```

- [ ] **Step 3: Render the modal** (near the end of ChatTab's returned JSX, alongside other overlays):

```tsx
      {showPrModal && (
        <CreatePrModal
          defaultTitle={chat?.taskBrief?.goal || gitStatus?.branch || ''}
          onCancel={() => setShowPrModal(false)}
          onCreate={async (input) => {
            if (!workingDir) return { ok: false, error: 'No working dir' }
            const r = await window.codey.git.createPr(workingDir, input)
            return r.ok && r.data ? r.data : { ok: false, error: r.error || 'Failed' }
          }}
        />
      )}
```

- [ ] **Step 4: Add imports**

```tsx
import { CreatePrModal } from './CreatePrModal'
```

- [ ] **Step 5: Build** — Run: `nvm use 22.17.1 && cd codey-mac && npm run build` — Expected: success.
- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): wire Create PR modal + branch-ahead into ChatTab"
```

---

## Phase 6 — Full verification

### Task 22: Run the whole suite + manual smoke test

- [ ] **Step 1: Run all unit tests**

Run: `nvm use 22.17.1 && cd codey-mac && npm test`
Expected: PASS, including `branchPickerModel.test.ts` and `createPrModel.test.ts`.

- [ ] **Step 2: Run gateway tests** — Run: `nvm use 22.17.1 && npm test -w @codey/gateway` — Expected: PASS including the new `setWorkingDirOverride` test.

- [ ] **Step 3: Lint** — Run: `nvm use 22.17.1 && npm run lint` — Expected: no non-English-character violations in new files.

- [ ] **Step 4: Manual smoke test** (launch the Mac app: `nvm use 22.17.1 && cd codey-mac && npm run dev` or the project's run command)

Verify each:
- [ ] Click the branch pill → dropdown lists local branches with the current one checked.
- [ ] Switch to a clean branch → pill updates.
- [ ] Switch with uncommitted changes → "Stash & switch" prompt appears; confirming stashes + switches and shows the stash note.
- [ ] "+ New branch…" → toggle defaults to **In a new worktree**; the preview path shows `.codey/worktrees/...`; Create makes the worktree and binds the chat (🌳 chip appears).
- [ ] Selecting the main worktree clears the binding (🌳 chip disappears).
- [ ] Change branch in an external terminal → pill updates within ~5s (or instantly via watcher) without focusing the window.
- [ ] Drive a chat to `waiting`/`done` → Create PR button appears; with commits it's enabled; clicking opens the modal; creating runs push + `gh pr create` and shows the PR URL.

- [ ] **Step 5: Final commit (if any lint/test fixups were needed)**

```bash
git add -A
git commit -m "chore(mac): branch picker + worktree + PR verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** Part 1 (switch/create/fetch/stash) → Tasks 1-4, 14, 17-18. Part 1b worktrees → Tasks 5-6, 10-13, 17-18. Live updates → Tasks 8-9, 16. Part 2 Create PR → Tasks 7, 15, 19-21. Header styling → Task 17 (`styles.pill` unifying branch + worktree). Testing section → Tasks 11, 14-15, 22.
- **Type consistency:** `{ current, local, remote }`, `Worktree { branch, path, isMain }`, `createPrButtonState`, `defaultPrTitle`, `defaultWorktreePath`, `partitionWorktrees`, `filterBranches`, `setWorkingDirOverride`, `workingDirOverride` are used identically across tasks.
- **Known soft spots to verify during execution (flagged inline):** exact in-scope name of `sendToRenderer` (Task 8); `ChatManager` constructor signature (Task 11); chat-refresh callback name in ChatTab (Task 18); external-URL open mechanism (Task 19); theme token names (Task 17). These are existing-codebase wiring details to confirm, not new design decisions.
