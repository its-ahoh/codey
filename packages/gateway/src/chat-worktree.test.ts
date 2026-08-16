import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorktreeParent, discoverChatWorktree, normalizeWorktreeName, provisionChatWorktree, removeCleanChatWorktree, workspaceHasUncommittedChanges } from './chat-worktree';
import { ChatManager } from './chats';

const roots: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A one-commit repository on `main`, cleaned up after the test. */
function makeRepository(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const repositoryRoot = path.join(root, 'repo');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  git(repositoryRoot, ['init', '-b', 'main']);
  git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
  git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
  fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'hello\n');
  git(repositoryRoot, ['add', 'README.md']);
  git(repositoryRoot, ['commit', '-m', 'initial']);
  return repositoryRoot;
}

describe('provisionChatWorktree', () => {
  it('creates a same-named branch and preserves a workspace subdirectory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-worktree-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    const workspaceWorkingDir = path.join(repositoryRoot, 'packages', 'app');
    fs.mkdirSync(workspaceWorkingDir, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'hello\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);

    const result = await provisionChatWorktree({
      workspaceWorkingDir,
      worktreeName: 'feature-auth',
    });

    expect(result.workingDir).toBe(path.join(result.worktreePath, 'packages', 'app'));
    expect(result.name).toBe('feature-auth');
    expect(path.basename(result.worktreePath)).toBe('feature-auth');
    expect(result.worktreePath).toBe(path.join(fs.realpathSync(workspaceWorkingDir), '.worktrees', 'feature-auth'));
    expect(fs.readFileSync(path.join(fs.realpathSync(workspaceWorkingDir), '.worktrees', '.gitignore'), 'utf8')).toBe('*\n');
    expect(result.baseCommit).toBe(git(repositoryRoot, ['rev-parse', 'HEAD']));
    expect(git(result.worktreePath, ['branch', '--show-current'])).toBe('feature-auth');
    expect(fs.statSync(result.workingDir).isDirectory()).toBe(true);
  });

  it('checks out an existing local branch instead of creating one', async () => {
    const repositoryRoot = makeRepository('codey-chat-worktree-existing-');
    git(repositoryRoot, ['branch', 'feature-auth']);
    fs.writeFileSync(path.join(repositoryRoot, 'later.md'), 'later\n');
    git(repositoryRoot, ['add', 'later.md']);
    git(repositoryRoot, ['commit', '-m', 'second']);

    const result = await provisionChatWorktree({
      workspaceWorkingDir: repositoryRoot,
      existingBranch: 'feature-auth',
    });

    expect(result.name).toBe('feature-auth');
    expect(git(result.worktreePath, ['branch', '--show-current'])).toBe('feature-auth');
    // The base is the branch tip, not the source checkout's HEAD.
    expect(result.baseCommit).toBe(git(repositoryRoot, ['rev-parse', 'feature-auth']));
    expect(result.baseCommit).not.toBe(git(repositoryRoot, ['rev-parse', 'HEAD']));
  });

  it('names the worktree separately from the branch it checks out', async () => {
    const repositoryRoot = makeRepository('codey-chat-worktree-rename-');
    git(repositoryRoot, ['branch', 'feature/auth']);

    const result = await provisionChatWorktree({
      workspaceWorkingDir: repositoryRoot,
      worktreeName: 'auth-review',
      existingBranch: 'feature/auth',
    });

    expect(path.basename(result.worktreePath)).toBe('auth-review');
    expect(git(result.worktreePath, ['branch', '--show-current'])).toBe('feature/auth');
  });

  it('reuses the worktree that already holds the branch instead of making a second one', async () => {
    const repositoryRoot = makeRepository('codey-chat-worktree-busy-');
    const taken = path.join(chatWorktreeParent(repositoryRoot), 'taken');
    fs.mkdirSync(path.dirname(taken), { recursive: true });
    git(repositoryRoot, ['worktree', 'add', '-b', 'feature-busy', taken, 'HEAD']);

    const result = await provisionChatWorktree({
      workspaceWorkingDir: repositoryRoot,
      worktreeName: 'second-look',
      existingBranch: 'feature-busy',
    });

    expect(result.worktreePath).toBe(fs.realpathSync(taken));
    // The adopted checkout keeps its own name; the requested one is not created.
    expect(result.name).toBe('taken');
    expect(fs.existsSync(path.join(chatWorktreeParent(repositoryRoot), 'second-look'))).toBe(false);
  });

  it('refuses a branch held by another chat’s worktree', async () => {
    const repositoryRoot = makeRepository('codey-chat-worktree-claimed-');
    const taken = path.join(chatWorktreeParent(repositoryRoot), 'other-chat');
    fs.mkdirSync(path.dirname(taken), { recursive: true });
    git(repositoryRoot, ['worktree', 'add', '-b', 'feature-owned', taken, 'HEAD']);

    await expect(provisionChatWorktree({
      workspaceWorkingDir: repositoryRoot,
      existingBranch: 'feature-owned',
      claimedPaths: [taken],
    })).rejects.toThrow(/another chat/);
  });

  it('refuses the branch checked out in the workspace itself', async () => {
    const repositoryRoot = makeRepository('codey-chat-worktree-shared-');

    await expect(provisionChatWorktree({
      workspaceWorkingDir: repositoryRoot,
      existingBranch: 'main',
    })).rejects.toThrow(/current checkout/);
  });

  it('creates a tracking branch for a branch that only exists on a remote', async () => {
    const origin = makeRepository('codey-chat-worktree-origin-');
    git(origin, ['branch', 'feature-remote']);
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-worktree-clone-'));
    roots.push(repositoryRoot);
    git(repositoryRoot, ['clone', origin, '.']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);

    const result = await provisionChatWorktree({
      workspaceWorkingDir: repositoryRoot,
      existingBranch: 'origin/feature-remote',
    });

    expect(git(result.worktreePath, ['branch', '--show-current'])).toBe('feature-remote');
    expect(git(result.worktreePath, ['rev-parse', '--abbrev-ref', 'feature-remote@{upstream}'])).toBe('origin/feature-remote');
  });

  it('rejects a branch that does not exist', async () => {
    const repositoryRoot = makeRepository('codey-chat-worktree-missing-');

    await expect(provisionChatWorktree({
      workspaceWorkingDir: repositoryRoot,
      existingBranch: 'nope',
    })).rejects.toThrow(/was not found/);
  });

  it('rejects isolated mode for a non-Git workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-worktree-'));
    roots.push(root);
    await expect(provisionChatWorktree({
      workspaceWorkingDir: root,
      worktreeName: 'plain-work',
    })).rejects.toThrow(/Git workspace/);
  });
});

describe('discoverChatWorktree', () => {
  it('adopts the one new direct-child worktree and keeps its semantic name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-agent-worktree-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    const workspaceWorkingDir = path.join(repositoryRoot, 'packages', 'app');
    fs.mkdirSync(workspaceWorkingDir, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'hello\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);

    const parent = chatWorktreeParent(workspaceWorkingDir);
    const worktreePath = path.join(parent, 'feature-search');
    fs.mkdirSync(parent, { recursive: true });
    git(repositoryRoot, ['worktree', 'add', '-b', 'feature-search', worktreePath, 'HEAD']);
    fs.mkdirSync(path.join(worktreePath, 'packages', 'app'), { recursive: true });

    const workspace = await discoverChatWorktree({
      workspaceWorkingDir, notBefore: 0, createdAt: 42,
    });

    expect(workspace).toMatchObject({
      name: 'feature-search',
      worktreePath: fs.realpathSync(worktreePath),
      workingDir: path.join(fs.realpathSync(worktreePath), 'packages', 'app'),
      createdAt: 42,
    });
  });

  it('does not adopt a worktree already bound to another chat', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-agent-owner-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    fs.mkdirSync(repositoryRoot, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'hello\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);
    const otherPath = path.join(chatWorktreeParent(repositoryRoot), 'feature-other');
    fs.mkdirSync(path.dirname(otherPath), { recursive: true });
    git(repositoryRoot, ['worktree', 'add', '-b', 'feature-other', otherPath, 'HEAD']);

    await expect(discoverChatWorktree({
      workspaceWorkingDir: repositoryRoot, notBefore: 0, claimedPaths: [otherPath],
    })).resolves.toBeUndefined();
  });

  it('does not adopt a worktree that predates the chat', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-agent-age-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    fs.mkdirSync(repositoryRoot, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'hello\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);
    const preexisting = path.join(chatWorktreeParent(repositoryRoot), 'hand-made');
    fs.mkdirSync(path.dirname(preexisting), { recursive: true });
    git(repositoryRoot, ['worktree', 'add', '-b', 'hand-made', preexisting, 'HEAD']);

    await expect(discoverChatWorktree({
      workspaceWorkingDir: repositoryRoot, notBefore: Date.now() + 60_000,
    })).resolves.toBeUndefined();
  });

  it('adopts nothing when two candidates qualify', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-agent-tie-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    fs.mkdirSync(repositoryRoot, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'hello\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);
    for (const name of ['first', 'second']) {
      const target = path.join(chatWorktreeParent(repositoryRoot), name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      git(repositoryRoot, ['worktree', 'add', '-b', name, target, 'HEAD']);
    }

    await expect(discoverChatWorktree({
      workspaceWorkingDir: repositoryRoot, notBefore: 0,
    })).resolves.toBeUndefined();
  });
});

describe('normalizeWorktreeName', () => {
  it('turns a user label into a safe semantic directory name', () => {
    expect(normalizeWorktreeName(' Feature / Auth ')).toBe('Feature-Auth');
  });

  it('rejects a name without usable characters', () => {
    expect(() => normalizeWorktreeName('///')).toThrow(/worktree name/i);
  });
});

describe('workspaceHasUncommittedChanges', () => {
  it('detects tracked and untracked changes that would not reach a new worktree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-dirty-'));
    roots.push(root);
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@codey.local']);
    git(root, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(root, 'README.md'), 'clean\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'initial']);

    await expect(workspaceHasUncommittedChanges(root)).resolves.toBe(false);
    fs.writeFileSync(path.join(root, 'new-file.txt'), 'not committed\n');
    await expect(workspaceHasUncommittedChanges(root)).resolves.toBe(true);
  });
});

describe('worktree cleanup', () => {
  it('removes a clean worktree while retaining its branch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-legacy-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    const worktreePath = path.join(root, 'feature-clean');
    fs.mkdirSync(repositoryRoot, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'clean\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);
    git(repositoryRoot, ['worktree', 'add', '-b', 'feature-clean', worktreePath, 'HEAD']);

    const realRepositoryRoot = fs.realpathSync(repositoryRoot);
    const realWorktreePath = fs.realpathSync(worktreePath);
    await removeCleanChatWorktree({
      name: 'feature-clean', repositoryRoot: realRepositoryRoot, worktreePath: realWorktreePath,
      workingDir: realWorktreePath, baseCommit: git(realWorktreePath, ['rev-parse', 'HEAD']), createdAt: 123,
    });
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(repositoryRoot, ['show-ref', '--verify', 'refs/heads/feature-clean'])).toBeTruthy();
  });

  it('refuses to remove a worktree with uncommitted changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-cleanup-'));
    roots.push(root);
    const repositoryRoot = path.join(root, 'repo');
    const worktreePath = path.join(root, 'feature');
    fs.mkdirSync(repositoryRoot, { recursive: true });
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.email', 'test@codey.local']);
    git(repositoryRoot, ['config', 'user.name', 'Codey Test']);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'clean\n');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['commit', '-m', 'initial']);
    git(repositoryRoot, ['worktree', 'add', '-b', 'feature', worktreePath, 'HEAD']);
    fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'keep me\n');

    await expect(removeCleanChatWorktree({
      name: 'feature', repositoryRoot, worktreePath, workingDir: worktreePath,
      baseCommit: git(worktreePath, ['rev-parse', 'HEAD']), createdAt: 1,
    })).rejects.toThrow(/uncommitted changes/i);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });
});

describe('ChatManager isolated workspace binding', () => {
  it('persists the execution mode and effective working directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-workspace-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
    const manager = new ChatManager(root);
    const chat = manager.create({ workspaceName: 'demo', executionMode: 'isolated-worktree' });
    manager.setSessionAnchor(chat.id, { agent: 'codex', model: 'model-a', sessionId: 'old-session' });
    const workspace = {
      repositoryRoot: '/repo', worktreePath: '/worktrees/chat-1', workingDir: '/worktrees/chat-1/packages/app',
      baseCommit: 'abc123', createdAt: 1,
    };

    const updated = manager.setChatWorkspace(chat.id, workspace);

    expect(updated.executionMode).toBe('isolated-worktree');
    expect(updated.chatWorkspace).toEqual(workspace);
    expect(updated.workingDirOverride).toBe(workspace.workingDir);
    expect(updated.sessionAnchor).toBeUndefined();
    expect(updated.sessionAnchors).toBeUndefined();
  });

  it('switches checkout mode without deleting the chat worktree binding', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-mode-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
    const manager = new ChatManager(root);
    const chat = manager.create({ workspaceName: 'demo', executionMode: 'isolated-worktree' });
    const workspace = {
      repositoryRoot: '/repo', worktreePath: '/worktrees/chat-1', workingDir: '/worktrees/chat-1',
      baseCommit: 'abc123', createdAt: 1,
    };
    manager.setChatWorkspace(chat.id, workspace);
    manager.setSessionAnchor(chat.id, { agent: 'codex', model: 'model-a', sessionId: 'isolated-session' });

    const shared = manager.setExecutionMode(chat.id, 'shared-checkout');
    expect(shared.workingDirOverride).toBeUndefined();
    expect(shared.chatWorkspace).toEqual(workspace);
    expect(shared.sessionAnchors).toBeUndefined();

    manager.setSessionAnchor(chat.id, { agent: 'codex', model: 'model-a', sessionId: 'shared-session' });
    const isolated = manager.setExecutionMode(chat.id, 'isolated-worktree');
    expect(isolated.workingDirOverride).toBe(workspace.workingDir);
    expect(isolated.sessionAnchors).toBeUndefined();
  });

  it('persists pull request state without changing conversation activity time', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-delivery-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
    const manager = new ChatManager(root);
    const chat = manager.create({ workspaceName: 'demo' });
    const updatedAt = chat.updatedAt;
    const pullRequest = {
      url: 'https://github.com/example/repo/pull/12', number: 12,
      state: 'merged' as const, baseBranch: 'main', lastCheckedAt: 2,
    };

    const updated = manager.setPullRequest(chat.id, pullRequest);

    expect(updated.pullRequest).toEqual(pullRequest);
    expect(updated.updatedAt).toBe(updatedAt);
  });
});
