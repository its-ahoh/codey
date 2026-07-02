# Branch picker + Create PR button — Design

**Date:** 2026-06-21
**Surface:** `codey-mac` (Electron + React)

## Problem

Two gaps in the chat surface of the Mac app:

1. The git branch badge in the chat header (`ChatTab.tsx`) is read-only and only
   refreshes on window focus. The user wants to (a) click it to switch to a
   different branch, and (b) see branch changes made elsewhere (e.g. a terminal)
   reflected live without manually refreshing.
2. There's no way to choose **where** a feature is developed. The user wants to
   pick, when starting a branch, whether it runs in an isolated **git worktree**
   (the default) or on the current checkout in place — and have the chat's agent
   work in that worktree.
3. The floating status panel (`StatusSidecar`) has no way to act on a finished
   task. The user wants a **Create PR** button that appears once the agent/worker
   has fulfilled the requirements — i.e. when the task is awaiting their
   confirmation or done — so they can open a PR directly without telling the
   agent "I confirmed."

## Part 1 — Branch picker (chat header)

The branch badge (`ChatTab.tsx:914`, `styles.gitBadge`) becomes an interactive
dropdown.

### Header styling (unified git control)

The standalone branch badge is replaced by a single cohesive **git control** pill
that reads well alongside the existing `workspaceTag`, rather than two competing
badges:

```
⎇ feature-x  +2   🌳 worktree   ▾
└ branch     └dirty └ only when bound to a non-main worktree
```

- One pill-shaped button (reuses `gitBadge`/`workspaceTag` pill styling): `⎇` +
  branch name, a faint `+N` dirty count, and — when the chat is bound to a
  non-main worktree — a small `🌳` chip with the worktree label, then a `▾`
  caret. Clicking opens the unified dropdown (branches · worktrees · new).
- When unbound (workspace dir) the `🌳` chip is omitted so the common case stays
  compact.

### Behavior

- **Click the badge** → dropdown anchored under it, containing:
  - A filter/search input at the top.
  - The list of **local branches**, current one marked (✓) and disabled.
  - Remote-only branches (e.g. `origin/feature-x`) listed under a divider once
    fetched; selecting one checks it out as a tracking branch.
  - A **Worktrees** section listing existing worktrees (branch + short path);
    selecting one binds this chat to that worktree (see _Part 1b_).
  - Footer actions: **"+ New branch…"** and **"Fetch remote branches"**.
- **Switch** — selecting a local branch runs `git checkout <name>`.
  - If the checkout fails because local changes would be overwritten (git
    reports a `dirty`/conflict error), the dropdown does **not** just show the
    raw error. It shows an inline prompt: _"Switching would overwrite local
    changes"_ with two actions — **"Stash & switch"** and **"Cancel"**.
  - **Stash & switch** runs `git stash push -u -m "codey-mac: switch to <name>"`
    (the `-u` includes untracked files), then retries `git checkout <name>`. The
    stash is **not** auto-popped on the target branch — re-applying it could
    reintroduce the same conflict elsewhere. Instead, on success the dropdown
    shows a one-line note: _"Local changes stashed — restore with `git stash
    pop`"_. This guarantees no work is lost and no surprise merge conflicts on
    the new branch.
  - Any other checkout failure surfaces the git stderr inline. No force.
- **Create** — "+ New branch…" swaps the filter row for a name input plus a
  segmented **"In a new worktree" / "On current checkout"** toggle. **"In a new
  worktree" is the default selection.** "On current checkout" runs
  `git checkout -b <name>` (branched from current HEAD); "In a new worktree"
  follows _Part 1b — Git worktrees_ below.
- **Fetch remote** — runs `git fetch`, then re-lists branches including
  remote-only ones, which check out via `git checkout --track <remote>/<name>`.
- The dropdown closes on outside-click / Escape / successful checkout.

### Live updates (no manual refresh)

- Main process watches the chat's `workingDir` `.git/HEAD` (and `.git/refs/heads`)
  with `fs.watch`, debounced ~200ms, and emits a `git:changed` event to the
  renderer. The renderer re-pulls `git:status` on that event.
- A ~5s polling fallback covers filesystems where `fs.watch` is unreliable.
- This supplements the existing window-focus refresh in `useGitStatus`.

### IPC additions

All wrap `execFile('git', …, { cwd: workingDir, timeout })` like the existing
`git:status` handler (`electron/main.ts:1360`). Added to `main.ts`,
`preload.ts`, and `codey-api.d.ts`:

- `git:branches(workingDir)` → `{ current: string; local: string[]; remote: string[] }`
- `git:checkout(workingDir, name, opts?: { create?: boolean; track?: boolean })` →
  `{ ok: boolean; error?: string; reason?: 'dirty' }` — when checkout fails
  because local changes would be overwritten, `reason: 'dirty'` is set so the UI
  can offer **Stash & switch** instead of showing a raw error. Detected by
  inspecting git's stderr ("would be overwritten by checkout" / "Your local
  changes").
- `git:stash(workingDir, message?: string)` → `{ ok: boolean; error?: string }` —
  runs `git stash push -u -m <message>`. Used by the Stash & switch flow (stash,
  then re-call `git:checkout`).
- `git:fetch(workingDir)` → `{ ok: boolean; error?: string }`
- `git:watch(workingDir)` to start a watcher (idempotent per dir) + `git:changed`
  subscription channel; watcher torn down when no renderer is subscribed.

`useGitStatus` is extended (or a sibling `useGitBranches` hook is added) to expose
`branches`, `checkout`, `createBranch`, `fetchRemote`, and to subscribe to
`git:changed`.

### New component

`BranchPicker.tsx` — the badge + dropdown. Pure-ish view fed by the hook; the
list/filter/error state logic that's worth unit-testing lives in a
`branchPickerModel.ts` companion (mirrors the existing `*Model.ts` +
`*.test.ts` pattern in `src/components`).

## Part 1b — Git worktrees

A chat can develop a feature in an **isolated worktree** instead of switching the
shared checkout in place. This is the **default** when creating a new branch.

### Behavior

- **Create in a new worktree** (default of the "+ New branch…" toggle):
  - Runs `git worktree add <path> -b <name>` from the chat's current
    `workingDir` repo.
  - Default `<path>`: `<repo>/.codey/worktrees/<name>` — in-repo and predictable.
    The worktree-add backend drops a `.gitignore` (`*`) in the `worktrees/`
    container so the checkouts never show up in the main repo's `git status`. The
    resolved path is shown in the create row before confirming.
  - On success the chat is **bound** to the new worktree (see below) so the agent
    immediately works there.
- **Select an existing worktree** from the dropdown's Worktrees section → binds
  this chat to it (no new branch created).
- The repo's **main worktree** is always listed; selecting it clears the binding
  (reverts to the workspace dir).

### Per-chat binding

- A `workingDirOverride` (string | undefined) is stored on the `Chat`. When set,
  `ChatTab` uses it instead of `getWorkspaceInfo().workingDir` for the git badge,
  git status, watcher, and — critically — message sends pass it through as the
  gateway run's `workingDir` (the gateway already honors a per-run
  `workingDir`: `gateway.ts:162`, `context: { workingDir: opts.workingDir ?? this.workingDir }`).
- Binding is **per chat**: other chats and the workspace default are unaffected.
- Clearing the binding ("Use workspace dir" / selecting the main worktree) removes
  the override.
- Persisted with the chat so the binding survives reload.

### IPC additions

- `git:worktrees(workingDir)` →
  `{ list: { branch: string; path: string; isMain: boolean }[] }` — parses
  `git worktree list --porcelain`.
- `git:worktreeAdd(workingDir, { name: string; path: string })` →
  `{ ok: boolean; path?: string; error?: string }` — runs
  `git worktree add <path> -b <name>`; returns the resolved absolute path to bind
  to. Surfaces git stderr on failure (e.g. path exists, branch exists).

Worktree **removal** is out of scope for v1 — manage stale worktrees via terminal
(`git worktree remove`).

## Part 2 — Create PR button (StatusSidecar)

A **Create PR** button rendered inside `StatusSidecar.tsx`.

### Gating

- Visible only when `view.status === 'waiting' || view.status === 'done'` (the
  status enum is `working | waiting | blocked | done`, from
  `taskHudView.ts`). This is the "agent fulfilled the requirements" state — the
  user does not have to confirm back to the agent first.
- Within that, the button is **enabled** only when the current branch is ahead of
  / differs from the default branch (something to PR). Otherwise it renders
  disabled with a tooltip ("No commits to PR"). The ahead/branch info comes from
  the git status already plumbed into the panel's host (`ChatTab`), passed down
  as props — `StatusSidecar` stays presentational.

### Action — inline `gh pr create`

1. Click opens a small modal pre-filled with:
   - **Title** — default: last commit subject, falling back to the branch name.
   - **Body** — empty (optional).
2. On confirm, the main process:
   - Pushes the branch if it has no upstream: `git push -u origin <branch>`.
   - Runs `gh pr create --title <t> --body <b> --head <branch>`.
3. On success, the modal shows the returned PR URL with an **Open** link
   (`shell.openExternal`). On failure (gh not installed/authed, no remote) the
   stderr is surfaced in the modal.

### IPC addition

- `git:createPr(workingDir, { title: string; body: string })` →
  `{ ok: boolean; url?: string; error?: string }` — wraps the push + `gh pr create`,
  parses the PR URL from stdout. `gh` resolved from PATH (installed: gh 2.88.1).

### Component changes

- `StatusSidecar.tsx` gains the gated button + a small `CreatePrModal` (or an
  inline expandable form). Submit/title-default/error-display logic that merits a
  test goes in a `createPrModel.ts` companion.
- `ChatTab.tsx` passes `workingDir`, branch-ahead info, and a `createPr` handler
  into `StatusSidecar`.

## Error handling

- All git/gh failures return `{ ok: false, error }` and render inline (dropdown or
  modal) — never a thrown/uncaught rejection. Existing handlers already use the
  `wrap()` helper and return `null` on failure; new ones return structured errors
  so the UI can show the cause.
- Watcher failures (e.g. `.git` missing) degrade silently to the polling +
  focus-refresh path.

## Testing

- `branchPickerModel.test.ts` — filtering, local/remote partition, create-mode
  toggle (worktree-default selection), worktree list partition (main vs others),
  default worktree path derivation, error surfacing, and the dirty → Stash &
  switch prompt state (`reason: 'dirty'` triggers the prompt; "Cancel" restores
  the list).
- `createPrModel.test.ts` — title defaulting (commit subject → branch fallback),
  gating predicate (`waiting`/`done` × branch-ahead), error display.
- Manual: switch/create/fetch a branch from the picker; change branch in a
  terminal and confirm the badge updates without focus change; finish a task and
  confirm the PR button appears and opens a PR.

## Out of scope

- Force checkout.
- Worktree **removal** from the UI (manage via terminal).
- Configurable worktree location (fixed `<repo>/.codey/worktrees/` default in v1).
- Editing PR base branch, reviewers, labels in the modal (gh defaults only).
- Non-GitHub remotes (gh handles only GitHub).
