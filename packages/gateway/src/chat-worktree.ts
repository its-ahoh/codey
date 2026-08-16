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

export function chatWorktreeDirectory(workspaceWorkingDir: string, worktreeName: string): string {
  const safeName = normalizeWorktreeName(worktreeName);
  return path.join(chatWorktreeParent(workspaceWorkingDir), safeName);
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

async function refExists(repositoryRoot: string, ref: string): Promise<boolean> {
  return git(repositoryRoot, ['show-ref', '--verify', '--quiet', ref]).then(() => true).catch(() => false);
}

interface BranchTarget {
  /** Branch to check out in the new worktree. */
  localBranch: string;
  /** Remote-tracking ref to branch from when the local branch does not exist yet. */
  startPoint?: string;
}

/** Map a branch as the user picked it — local name, `origin/name`, or a bare
 *  name that only exists on a remote — onto the checkout Git needs. */
async function resolveBranchTarget(repositoryRoot: string, requested: string): Promise<BranchTarget> {
  const branch = requested.trim().replace(/^refs\/heads\//, '');
  if (!branch) throw new Error('Select a branch to check out in the worktree');
  if (await refExists(repositoryRoot, `refs/heads/${branch}`)) return { localBranch: branch };

  // `origin/feature` — the remote name is part of what the picker showed.
  if (await refExists(repositoryRoot, `refs/remotes/${branch}`)) {
    const localBranch = branch.slice(branch.indexOf('/') + 1);
    if (await refExists(repositoryRoot, `refs/heads/${localBranch}`)) return { localBranch };
    return { localBranch, startPoint: branch };
  }

  // A bare name that only exists on remotes: adopt it when exactly one remote has it.
  const remotes = (await git(repositoryRoot, ['remote'])).split(/\r?\n/).filter(Boolean);
  const matches: string[] = [];
  for (const remote of remotes) {
    if (await refExists(repositoryRoot, `refs/remotes/${remote}/${branch}`)) matches.push(`${remote}/${branch}`);
  }
  if (matches.length === 1) return { localBranch: branch, startPoint: matches[0] };
  if (matches.length > 1) throw new Error(`Branch "${branch}" exists on several remotes — pick one such as "${matches[0]}"`);
  throw new Error(`Branch "${branch}" was not found in this repository`);
}

/** Create a chat-owned worktree. By default this also creates a same-named
 *  branch from the source HEAD; with `existingBranch` the worktree is attached
 *  to a branch that already exists (checking out a remote branch locally when
 *  needed). A branch Git already holds in another worktree is not duplicated:
 *  that checkout is adopted instead, unless it belongs to someone else. */
export async function provisionChatWorktree(input: {
  workspaceWorkingDir: string;
  /** Defaults to the branch name when attaching to an existing branch. */
  worktreeName?: string;
  existingBranch?: string;
  /** Worktree paths already bound to a chat; never adopted for a second chat. */
  claimedPaths?: string[];
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

  const sourceCommit = await git(sourceDir, ['rev-parse', 'HEAD']);
  const name = normalizeWorktreeName(input.worktreeName?.trim() || input.existingBranch || '');
  // `name` is already normalized here; join it directly so creation does not
  // run the same normalization a second time through chatWorktreeDirectory().
  const requestedPath = path.join(chatWorktreeParent(sourceDir), name);
  ensureWorktreeContainer(sourceDir);
  const worktreePath = path.join(fs.realpathSync(path.dirname(requestedPath)), path.basename(requestedPath));

  // Stale registrations make Git report a branch as checked out long after its
  // directory is gone, so clear them before any branch check runs.
  await git(repositoryRoot, ['worktree', 'prune']);

  const finish = (checkout: string, base: string): ChatWorkspace => {
    const dir = path.join(checkout, relativeWorkingDir);
    // Git does not track empty directories. Recreate the configured workspace
    // subdirectory when the source path exists but the checkout omitted it.
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(`Workspace subdirectory is not a directory in the isolated checkout: ${relativeWorkingDir}`);
    }
    return {
      name: path.basename(checkout), repositoryRoot, worktreePath: checkout,
      workingDir: dir, baseCommit: base, createdAt: Date.now(),
    };
  };

  const target = input.existingBranch ? await resolveBranchTarget(repositoryRoot, input.existingBranch) : undefined;

  if (target) {
    // The main working tree is first in Git's listing. It is the shared
    // checkout every chat starts in, so it is never a chat's own worktree.
    const [mainWorktree, ...linked] = parseWorktreeList(await git(repositoryRoot, ['worktree', 'list', '--porcelain']));
    if (mainWorktree?.branch === target.localBranch) {
      throw new Error(`Branch "${target.localBranch}" is checked out in the workspace itself — switch this chat to the current checkout instead`);
    }
    const holder = linked.find(record => record.branch === target.localBranch && fs.existsSync(record.worktreePath));
    if (holder) {
      // Git allows one worktree per branch, so reuse the existing checkout
      // rather than refusing the branch outright.
      const existing = fs.realpathSync(holder.worktreePath);
      const claimed = (input.claimedPaths ?? [])
        .filter(claimedPath => fs.existsSync(claimedPath))
        .map(claimedPath => fs.realpathSync(claimedPath));
      if (claimed.includes(existing)) {
        throw new Error(`Branch "${target.localBranch}" belongs to another chat's worktree at ${existing}`);
      }
      return finish(existing, await git(existing, ['rev-parse', 'HEAD']));
    }
  }

  if (fs.existsSync(worktreePath)) {
    throw new Error(`A worktree named "${name}" already exists in this workspace`);
  }

  if (target) {
    const args = target.startPoint
      ? ['worktree', 'add', '--track', '-b', target.localBranch, worktreePath, target.startPoint]
      : ['worktree', 'add', worktreePath, target.localBranch];
    await git(repositoryRoot, args);
    return finish(worktreePath, await git(worktreePath, ['rev-parse', 'HEAD']));
  }

  const branchExists = await refExists(repositoryRoot, `refs/heads/${name}`);
  if (branchExists) throw new Error(`A branch named "${name}" already exists`);
  await git(repositoryRoot, ['worktree', 'add', '-b', name, worktreePath, sourceCommit]);
  return finish(worktreePath, sourceCommit);
}
