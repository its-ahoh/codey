import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { Chat } from '@codey/core';

const execFileAsync = promisify(execFile);
export type ChatWorkspace = NonNullable<Chat['chatWorkspace']>;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return result.stdout.trim();
}

export function normalizeWorktreeName(name: string): string {
  const normalized = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('Enter a worktree name using letters, numbers, dots, dashes, or underscores');
  }
  return normalized;
}

/** Chat checkouts live beside the code they branch from, inside the workspace
 *  directory, so everything belonging to a project stays under that project. */
export const WORKTREE_CONTAINER = '.worktrees';

export function chatWorktreeParent(workspaceWorkingDir: string): string {
  return path.join(path.resolve(workspaceWorkingDir), WORKTREE_CONTAINER);
}

/** The container sits inside a checkout, so it must exclude itself from Git:
 *  without this, every chat worktree would surface as untracked noise in the
 *  workspace's own `git status`. Repos that already ignore `.worktrees/` are
 *  unaffected — a second, narrower ignore rule is harmless. */
export function ensureWorktreeContainer(workspaceWorkingDir: string): string {
  const container = path.join(path.resolve(workspaceWorkingDir), WORKTREE_CONTAINER);
  fs.mkdirSync(container, { recursive: true });
  const ignoreFile = path.join(container, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n');
  return container;
}

interface WorktreeRecord {
  worktreePath: string;
  head?: string;
  branch?: string;
}

export interface RegisteredWorktreeBinding {
  repositoryRoot: string;
  worktreePath: string;
  workingDir: string;
  branch?: string;
  isMain: boolean;
}

function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { worktreePath: line.slice('worktree '.length) };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current) records.push(current);
  return records;
}

/** Resolve a path selected from `git worktree list` back to the workspace's
 * configured subdirectory. Git is the source of truth: arbitrary directories,
 * stale registrations, and worktrees from another repository are rejected. */
export async function resolveRegisteredWorktreeBinding(input: {
  workspaceWorkingDir: string;
  worktreePath: string;
}): Promise<RegisteredWorktreeBinding> {
  const sourceDir = fs.realpathSync(path.resolve(input.workspaceWorkingDir));
  let repositoryRoot: string;
  try {
    repositoryRoot = fs.realpathSync(path.resolve(await git(sourceDir, ['rev-parse', '--show-toplevel'])));
  } catch {
    throw new Error('Worktree switching requires a Git workspace');
  }

  const relativeWorkingDir = path.relative(repositoryRoot, sourceDir);
  if (relativeWorkingDir.startsWith('..') || path.isAbsolute(relativeWorkingDir)) {
    throw new Error(`Workspace directory is outside its Git repository: ${sourceDir}`);
  }
  if (!fs.existsSync(input.worktreePath)) {
    throw new Error(`Worktree is no longer available: ${input.worktreePath}`);
  }

  const requested = fs.realpathSync(path.resolve(input.worktreePath));
  const records = parseWorktreeList(await git(repositoryRoot, ['worktree', 'list', '--porcelain']));
  const record = records.find(candidate =>
    fs.existsSync(candidate.worktreePath) && fs.realpathSync(candidate.worktreePath) === requested
  );
  if (!record) throw new Error(`Directory is not a registered worktree of this workspace: ${requested}`);

  const workingDir = path.join(requested, relativeWorkingDir);
  if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
    throw new Error(`Workspace subdirectory is missing from the selected worktree: ${relativeWorkingDir || '.'}`);
  }
  return {
    repositoryRoot,
    worktreePath: requested,
    workingDir,
    branch: record.branch,
    isMain: requested === repositoryRoot,
  };
}

/** Discover a worktree an agent created for this chat. The container is shared
 *  by every chat in the workspace and by the user's own worktrees, so ownership
 *  is established without a path marker: a candidate must be a direct child of
 *  the container, unclaimed by another chat, and newer than this chat. When two
 *  candidates qualify, none is adopted — leaving a chat in the shared checkout
 *  is recoverable, binding it to someone else's worktree is not. */
export async function discoverChatWorktree(input: {
  workspaceWorkingDir: string;
  /** Only worktrees created after this moment can belong to the chat. */
  notBefore: number;
  /** Worktree paths already bound to a chat. */
  claimedPaths?: string[];
  createdAt?: number;
}): Promise<ChatWorkspace | undefined> {
  const sourceDir = fs.realpathSync(path.resolve(input.workspaceWorkingDir));
  let repositoryRoot: string;
  try {
    repositoryRoot = fs.realpathSync(path.resolve(await git(sourceDir, ['rev-parse', '--show-toplevel'])));
  } catch {
    return undefined;
  }
  const relativeWorkingDir = path.relative(repositoryRoot, sourceDir);
  if (relativeWorkingDir.startsWith('..') || path.isAbsolute(relativeWorkingDir)) return undefined;

  const parent = chatWorktreeParent(input.workspaceWorkingDir);
  if (!fs.existsSync(parent)) return undefined;
  const realParent = fs.realpathSync(parent);
  const claimed = new Set((input.claimedPaths ?? [])
    .filter(claimedPath => fs.existsSync(claimedPath))
    .map(claimedPath => fs.realpathSync(claimedPath)));
  const records = parseWorktreeList(await git(repositoryRoot, ['worktree', 'list', '--porcelain']));
  const owned = records.filter(record => {
    if (!fs.existsSync(record.worktreePath)) return false;
    const realPath = fs.realpathSync(record.worktreePath);
    if (path.dirname(realPath) !== realParent) return false;
    if (claimed.has(realPath)) return false;
    return fs.statSync(realPath).birthtimeMs >= input.notBefore;
  });
  if (owned.length !== 1) return undefined;

  const record = owned[0];
  const worktreePath = fs.realpathSync(record.worktreePath);
  const workingDir = path.join(worktreePath, relativeWorkingDir);
  if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) return undefined;
  return {
    name: path.basename(worktreePath),
    repositoryRoot,
    worktreePath,
    workingDir,
    baseCommit: record.head ?? await git(worktreePath, ['rev-parse', 'HEAD']),
    createdAt: input.createdAt ?? Date.now(),
  };
}

/** Whether a directory sits inside a Git repository, and can therefore have
 *  worktrees. A missing directory answers false rather than throwing: the
 *  callers use this to choose a mode, not to validate the workspace. */
export async function isGitWorkspace(workingDir: string): Promise<boolean> {
  try {
    await git(fs.realpathSync(path.resolve(workingDir)), ['rev-parse', '--show-toplevel']);
    return true;
  } catch {
    return false;
  }
}

/** A shared checkout cannot be promoted safely while it contains changes that
 *  are not represented by HEAD: a new worktree starts from a commit. */
export async function workspaceHasUncommittedChanges(workingDir: string): Promise<boolean> {
  return (await git(workingDir, ['status', '--porcelain'])).length > 0;
}

/** Remove a chat's checkout only when Git confirms it has no local changes.
 *  The branch is intentionally retained so committed work remains recoverable. */
export async function removeCleanChatWorktree(workspace: ChatWorkspace): Promise<void> {
  if (!fs.existsSync(workspace.worktreePath)) {
    if (fs.existsSync(workspace.repositoryRoot)) await git(workspace.repositoryRoot, ['worktree', 'prune']);
    return;
  }
  if (await workspaceHasUncommittedChanges(workspace.worktreePath)) {
    throw new Error(`Worktree "${workspace.name ?? path.basename(workspace.worktreePath)}" has uncommitted changes. Commit or stash them before deleting this chat.`);
  }
  await git(workspace.repositoryRoot, ['worktree', 'remove', workspace.worktreePath]);
}

/** What happened to a disposable checkout when its run ended. */
export type DisposableWorktreeOutcome =
  /** Checkout and branch both gone — the run left nothing behind. */
  | 'removed'
  /** Checkout gone, branch retained because commits were made on it. */
  | 'branch-kept'
  /** Nothing removed: uncommitted changes are never discarded. */
  | 'kept';

/** Tear down a throwaway checkout at the end of a run. Nothing is ever
 *  discarded: a dirty worktree is left untouched for the user to inspect, and
 *  the branch survives whenever the run committed to it. Only the boring case
 *  — clean tree, still sitting on `baseCommit` — disappears completely, which
 *  is what keeps a daily automation from accreting one dead branch per run. */
export async function discardDisposableWorktree(workspace: ChatWorkspace): Promise<DisposableWorktreeOutcome> {
  if (!fs.existsSync(workspace.worktreePath)) {
    if (fs.existsSync(workspace.repositoryRoot)) await git(workspace.repositoryRoot, ['worktree', 'prune']);
    return 'removed';
  }
  if (await workspaceHasUncommittedChanges(workspace.worktreePath)) return 'kept';
  const head = await git(workspace.worktreePath, ['rev-parse', 'HEAD']);
  const branch = await git(workspace.worktreePath, ['branch', '--show-current']);
  await git(workspace.repositoryRoot, ['worktree', 'remove', workspace.worktreePath]);
  if (!branch || head !== workspace.baseCommit) return branch ? 'branch-kept' : 'removed';
  // -d would refuse an unmerged branch; -D is safe here precisely because the
  // commit check above proved the branch never moved off its base.
  await git(workspace.repositoryRoot, ['branch', '-D', branch]);
  return 'removed';
}

/** Create a chat-owned worktree and a same-named branch from the source HEAD. */
export async function provisionChatWorktree(input: {
  workspaceWorkingDir: string;
  worktreeName: string;
}): Promise<ChatWorkspace> {
  const sourceDir = fs.realpathSync(path.resolve(input.workspaceWorkingDir));
  let repositoryRoot: string;
  try {
    repositoryRoot = fs.realpathSync(path.resolve(await git(sourceDir, ['rev-parse', '--show-toplevel'])));
  } catch {
    throw new Error('Isolated worktrees require a Git workspace');
  }

  const relativeWorkingDir = path.relative(repositoryRoot, sourceDir);
  if (relativeWorkingDir.startsWith('..') || path.isAbsolute(relativeWorkingDir)) {
    throw new Error(`Workspace directory is outside its Git repository: ${sourceDir}`);
  }

  const baseCommit = await git(sourceDir, ['rev-parse', 'HEAD']);
  const name = normalizeWorktreeName(input.worktreeName);
  const requestedPath = path.join(chatWorktreeParent(sourceDir), name);
  ensureWorktreeContainer(sourceDir);
  const worktreePath = path.join(fs.realpathSync(path.dirname(requestedPath)), path.basename(requestedPath));
  const workingDir = path.join(worktreePath, relativeWorkingDir);

  if (fs.existsSync(worktreePath)) {
    throw new Error(`A worktree named "${name}" already exists in this workspace`);
  } else {
    await git(repositoryRoot, ['worktree', 'prune']);
    const branchExists = await git(repositoryRoot, ['show-ref', '--verify', `refs/heads/${name}`])
      .then(() => true)
      .catch(() => false);
    if (branchExists) throw new Error(`A branch named "${name}" already exists`);
    await git(repositoryRoot, ['worktree', 'add', '-b', name, worktreePath, baseCommit]);
  }

  // Git does not track empty directories. Recreate the configured workspace
  // subdirectory when the source path exists but the checkout omitted it.
  if (!fs.existsSync(workingDir)) fs.mkdirSync(workingDir, { recursive: true });
  if (!fs.statSync(workingDir).isDirectory()) {
    throw new Error(`Workspace subdirectory is not a directory in the isolated checkout: ${relativeWorkingDir}`);
  }
  return { name, repositoryRoot, worktreePath, workingDir, baseCommit, createdAt: Date.now() };
}
