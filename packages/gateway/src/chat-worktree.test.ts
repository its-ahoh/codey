import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorktreeBranch, inspectChatWorktree, provisionChatWorktree } from './chat-worktree';

const roots: string[] = [];

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('provisionChatWorktree', () => {
  it('creates a dedicated branch/worktree and preserves a workspace subdirectory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-worktree-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    const workspaceWorkingDir = path.join(repositoryRoot, 'packages', 'app');
    const workspacesRoot = path.join(root, 'data', 'workspaces');
    fs.mkdirSync(workspaceWorkingDir, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'hello\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);

    const result = await provisionChatWorktree({
      workspaceWorkingDir,
      workspacesRoot,
      workspaceName: 'demo',
      chatId: 'abc-123',
    });

    expect(result).not.toBeNull();
    expect(result?.branch).toBe(chatWorktreeBranch('abc-123'));
    expect(result?.workingDir).toBe(path.join(result!.worktreePath, 'packages', 'app'));
    expect(fs.statSync(result!.workingDir).isDirectory()).toBe(true);
    expect(git(result!.worktreePath, ['branch', '--show-current'])).toBe(result?.branch);
    await expect(inspectChatWorktree(result!.workingDir)).resolves.toEqual(result);

    // Provisioning is idempotent and recovers the same environment.
    await expect(provisionChatWorktree({ workspaceWorkingDir, workspacesRoot, workspaceName: 'demo', chatId: 'abc-123' }))
      .resolves.toEqual(result);

    fs.writeFileSync(path.join(repositoryRoot, 'local-change.txt'), 'dirty\n');
    await expect(provisionChatWorktree({
      workspaceWorkingDir,
      workspacesRoot,
      workspaceName: 'demo',
      chatId: 'legacy-chat',
      requireCleanSource: true,
    })).rejects.toThrow(/local changes/i);
  });

  it('returns null outside a Git repository', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-worktree-'));
    roots.push(root);
    await expect(provisionChatWorktree({
      workspaceWorkingDir: root,
      workspacesRoot: path.join(root, 'workspaces'),
      workspaceName: 'plain',
      chatId: 'abc',
    })).resolves.toBeNull();
  });
});
