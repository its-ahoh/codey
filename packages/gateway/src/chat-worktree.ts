import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ProvisionedChatWorktree {
  repositoryRoot: string;
  branch: string;
  worktreePath: string;
  workingDir: string;
}

export function chatWorktreeBranch(chatId: string): string {
  return `codey/chat-${chatId}`;
}

export function chatWorktreeDirectory(workspacesRoot: string, workspaceName: string, chatId: string): string {
  return path.join(workspacesRoot, workspaceName, 'worktrees', `chat-${chatId}`);
}

/** Describe an existing worktree binding without changing its branch. */
export async function inspectChatWorktree(workingDirInput: string): Promise<ProvisionedChatWorktree | null> {
  const workingDir = fs.realpathSync(path.resolve(workingDirInput));
  try {
    const worktreePath = fs.realpathSync(path.resolve(await git(workingDir, ['rev-parse', '--show-toplevel'])));
    const branch = await git(workingDir, ['branch', '--show-current']);
    if (!branch) return null;
    const porcelain = await git(workingDir, ['worktree', 'list', '--porcelain']);
    const firstWorktree = porcelain.split('\n').find(line => line.startsWith('worktree '));
    const repositoryRoot = firstWorktree
      ? fs.realpathSync(path.resolve(firstWorktree.slice('worktree '.length).trim()))
      : worktreePath;
    return { repositoryRoot, branch, worktreePath, workingDir };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return result.stdout.trim();
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or recover) the branch/worktree owned by one chat.
 * Returns null for a non-Git workspace; all other failures are actionable and
 * are allowed to reach the caller so it never silently falls back to sharing.
 */
export async function provisionChatWorktree(input: {
  workspaceWorkingDir: string;
  workspacesRoot: string;
  workspaceName: string;
  chatId: string;
  requireCleanSource?: boolean;
}): Promise<ProvisionedChatWorktree | null> {
  // macOS exposes /var as a symlink to /private/var. Normalize both sides so
  // path.relative does not misclassify a real repository subdirectory.
  const sourceDir = fs.realpathSync(path.resolve(input.workspaceWorkingDir));
  let repositoryRoot: string;
  try {
    repositoryRoot = fs.realpathSync(path.resolve(await git(sourceDir, ['rev-parse', '--show-toplevel'])));
  } catch {
    return null;
  }

  const relativeWorkingDir = path.relative(repositoryRoot, sourceDir);
  if (relativeWorkingDir.startsWith('..') || path.isAbsolute(relativeWorkingDir)) {
    throw new Error(`Workspace directory is outside its Git repository: ${sourceDir}`);
  }
  if (input.requireCleanSource) {
    const dirty = await git(sourceDir, ['status', '--porcelain']);
    if (dirty) {
      throw new Error('Cannot automatically isolate this existing chat while the shared workspace has local changes');
    }
  }

  const branch = chatWorktreeBranch(input.chatId);
  const requestedWorktreePath = chatWorktreeDirectory(input.workspacesRoot, input.workspaceName, input.chatId);
  fs.mkdirSync(path.dirname(requestedWorktreePath), { recursive: true });
  const worktreePath = path.join(fs.realpathSync(path.dirname(requestedWorktreePath)), path.basename(requestedWorktreePath));
  const workingDir = path.join(worktreePath, relativeWorkingDir);

  if (fs.existsSync(worktreePath)) {
    const existingRoot = await git(worktreePath, ['rev-parse', '--show-toplevel']).catch(() => '');
    const existingBranch = await git(worktreePath, ['branch', '--show-current']).catch(() => '');
    if (path.resolve(existingRoot) !== path.resolve(worktreePath) || existingBranch !== branch) {
      throw new Error(`Chat worktree path already exists but does not belong to ${branch}: ${worktreePath}`);
    }
    fs.mkdirSync(workingDir, { recursive: true });
    return { repositoryRoot, branch, worktreePath, workingDir };
  }

  // Remove stale registrations left behind if a worktree directory was
  // deleted outside Codey, then recover the existing branch when present.
  await git(repositoryRoot, ['worktree', 'prune']);
  const branchExists = await gitSucceeds(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', worktreePath, '-b', branch, 'HEAD'];
  await git(repositoryRoot, args);
  fs.mkdirSync(workingDir, { recursive: true });

  return { repositoryRoot, branch, worktreePath, workingDir };
}
