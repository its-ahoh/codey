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

export function chatWorktreeParent(workspacesRoot: string, workspaceName: string, chatId: string): string {
  const safeWorkspace = workspaceName.replace(/[^a-zA-Z0-9._-]/g, '-');
  const safeChatId = chatId.replace(/[^a-zA-Z0-9._-]/g, '-');
  // The UUID is intentionally confined to this hidden ownership boundary. It
  // never becomes the user-facing worktree/branch name, but prevents two
  // concurrently running chats from adopting each other's new checkout.
  return path.join(path.dirname(workspacesRoot), 'chat-worktrees', safeWorkspace, `chat-${safeChatId}`);
}

export function chatWorktreeDirectory(workspacesRoot: string, workspaceName: string, chatId: string, worktreeName: string): string {
  const safeName = normalizeWorktreeName(worktreeName);
  // Keep code checkouts outside the workspace metadata directory. Deleting or
  // renaming a Workspace must not silently erase a chat's uncommitted files.
  return path.join(chatWorktreeParent(workspacesRoot, workspaceName, chatId), safeName);
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

/** Discover a worktree created by an agent inside this chat's private
 *  ownership directory. A direct-child rule keeps adoption deterministic. */
export async function discoverChatWorktree(input: {
  workspaceWorkingDir: string;
  workspacesRoot: string;
  workspaceName: string;
  chatId: string;
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

  const parent = chatWorktreeParent(input.workspacesRoot, input.workspaceName, input.chatId);
  if (!fs.existsSync(parent)) return undefined;
  const realParent = fs.realpathSync(parent);
  const records = parseWorktreeList(await git(repositoryRoot, ['worktree', 'list', '--porcelain']));
  const owned = records.filter(record => {
    if (!fs.existsSync(record.worktreePath)) return false;
    return path.dirname(fs.realpathSync(record.worktreePath)) === realParent;
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

/** Describe a worktree selected by the legacy workingDirOverride model. */
export async function describeLegacyChatWorktree(input: {
  workspaceWorkingDir: string;
  workingDirOverride: string;
  createdAt: number;
}): Promise<ChatWorkspace | undefined> {
  if (!fs.existsSync(input.workingDirOverride)) return undefined;
  const [workspaceDir, overrideDir] = [input.workspaceWorkingDir, input.workingDirOverride]
    .map(value => fs.realpathSync(path.resolve(value)));
  const [workspaceRoot, worktreeRoot] = await Promise.all([
    git(workspaceDir, ['rev-parse', '--show-toplevel']),
    git(overrideDir, ['rev-parse', '--show-toplevel']),
  ]).then(values => values.map(value => fs.realpathSync(path.resolve(value))));
  if (workspaceRoot === worktreeRoot) return undefined;

  const resolveCommonDir = async (cwd: string): Promise<string> => {
    const raw = await git(cwd, ['rev-parse', '--git-common-dir']);
    return fs.realpathSync(path.resolve(cwd, raw));
  };
  const [workspaceCommonDir, worktreeCommonDir] = await Promise.all([
    resolveCommonDir(workspaceDir), resolveCommonDir(overrideDir),
  ]);
  if (workspaceCommonDir !== worktreeCommonDir) return undefined;

  const relativeWorkingDir = path.relative(worktreeRoot, overrideDir);
  const [baseCommit, branch] = await Promise.all([
    git(overrideDir, ['rev-parse', 'HEAD']),
    git(overrideDir, ['branch', '--show-current']),
  ]);
  return {
    name: branch || path.basename(worktreeRoot),
    repositoryRoot: workspaceRoot,
    worktreePath: worktreeRoot,
    workingDir: path.join(worktreeRoot, relativeWorkingDir),
    baseCommit,
    createdAt: input.createdAt,
  };
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

/** Create a chat-owned worktree and a same-named branch from the source HEAD. */
export async function provisionChatWorktree(input: {
  workspaceWorkingDir: string;
  workspacesRoot: string;
  workspaceName: string;
  chatId: string;
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
  const requestedPath = chatWorktreeDirectory(input.workspacesRoot, input.workspaceName, input.chatId, name);
  fs.mkdirSync(path.dirname(requestedPath), { recursive: true });
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
