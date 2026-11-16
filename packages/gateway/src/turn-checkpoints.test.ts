import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureCheckpoint,
  countChangedFiles,
  currentHead,
  deleteChatRefs,
  restoreCheckpoint,
  turnRef,
  undoRef,
} from './turn-checkpoints';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));

let repo: string;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ckpt-')));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'a.txt', 'one\n');
  write(repo, 'keep/b.txt', 'bee\n');
  write(repo, '.gitignore', 'ignored/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('captureCheckpoint', () => {
  it('pins a snapshot without touching HEAD, branch, or the staged index', async () => {
    write(repo, 'a.txt', 'staged\n');
    git(repo, 'add', 'a.txt');
    write(repo, 'a.txt', 'staged then edited\n');
    write(repo, 'new.txt', 'untracked\n');
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const statusBefore = git(repo, 'status', '--porcelain');

    const ref = turnRef('chat-1', 'msg-1', 'before');
    const snap = await captureCheckpoint(repo, ref);

    expect(snap).not.toBeNull();
    expect(snap!.head).toBe(headBefore);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(repo, 'show', 'HEAD:a.txt')).toBe('one');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('a.txt');
    expect(git(repo, 'rev-parse', ref)).toBe(snap!.commit);
    expect(git(repo, 'show', `${ref}:a.txt`)).toBe('staged then edited');
    expect(git(repo, 'show', `${ref}:new.txt`)).toBe('untracked');
    expect(git(repo, 'log', '--oneline', 'main').split('\n')).toHaveLength(1);
  });

  it('works in a repo with no commit yet', async () => {
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ckpt-fresh-')));
    try {
      git(fresh, 'init', '-q');
      write(fresh, 'x.txt', 'x\n');
      const snap = await captureCheckpoint(fresh, turnRef('c', 'm', 'before'));
      expect(snap).not.toBeNull();
      expect(snap!.head).toBe('');
      expect(git(fresh, 'show', `${snap!.commit}:x.txt`)).toBe('x');
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('returns null outside a git repo', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ckpt-plain-'));
    try {
      expect(await captureCheckpoint(plain, turnRef('c', 'm', 'before'))).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns null when the snapshot runs past its budget', async () => {
    // A git that never answers: the capture must give up on its own.
    const slowGit = () => new Promise<string>(() => undefined);
    expect(await captureCheckpoint(repo, turnRef('c', 'm', 'before'), { git: slowGit, budgetMs: 10 })).toBeNull();
  });
});

describe('restoreCheckpoint', () => {
  it('puts modified, deleted and added files back; ignored files stay', async () => {
    write(repo, 'ignored/cache.bin', 'cache v1\n');
    const before = await captureCheckpoint(repo, turnRef('c', 'm', 'before'));

    // The "agent turn".
    write(repo, 'a.txt', 'changed\n');
    fs.rmSync(path.join(repo, 'keep/b.txt'));
    write(repo, 'deep/new/file.txt', 'added\n');
    write(repo, 'ignored/cache.bin', 'cache v2\n');

    expect(await countChangedFiles(repo, before!.commit)).toBe(3);
    const result = await restoreCheckpoint(repo, before!.commit, undoRef('c', 1));

    expect(read(repo, 'a.txt')).toBe('one\n');
    expect(read(repo, 'keep/b.txt')).toBe('bee\n');
    expect(exists(repo, 'deep/new/file.txt')).toBe(false);
    expect(exists(repo, 'deep')).toBe(false);
    expect(read(repo, 'ignored/cache.bin')).toBe('cache v2\n');
    expect(result.changed).toEqual(['a.txt', 'deep/new/file.txt', 'keep/b.txt']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('can be redone from its safety snapshot', async () => {
    const before = await captureCheckpoint(repo, turnRef('c', 'm', 'before'));
    write(repo, 'a.txt', 'agent work\n');
    write(repo, 'made.txt', 'made\n');

    const undo = await restoreCheckpoint(repo, before!.commit, undoRef('c', 1));
    expect(read(repo, 'a.txt')).toBe('one\n');

    await restoreCheckpoint(repo, undo.safetyCommit, undoRef('c', 2));
    expect(read(repo, 'a.txt')).toBe('agent work\n');
    expect(read(repo, 'made.txt')).toBe('made\n');
  });

  it('keeps hand edits made before the turn started', async () => {
    write(repo, 'a.txt', 'user edit between turns\n');
    const before = await captureCheckpoint(repo, turnRef('c', 'm2', 'before'));
    write(repo, 'a.txt', 'agent\n');
    await restoreCheckpoint(repo, before!.commit, undoRef('c', 1));
    expect(read(repo, 'a.txt')).toBe('user edit between turns\n');
  });

  it('only restores inside the working folder when it is a subdirectory', async () => {
    const sub = path.join(repo, 'keep');
    const before = await captureCheckpoint(sub, turnRef('c', 'm', 'before'));
    write(repo, 'keep/b.txt', 'agent\n');
    write(repo, 'a.txt', 'outside\n');
    await restoreCheckpoint(sub, before!.commit, undoRef('c', 1));
    expect(read(repo, 'keep/b.txt')).toBe('bee\n');
    expect(read(repo, 'a.txt')).toBe('outside\n');
  });

  it('reports HEAD so callers can see a commit made during the turn', async () => {
    const before = await captureCheckpoint(repo, turnRef('c', 'm', 'before'));
    write(repo, 'a.txt', 'committed\n');
    git(repo, 'commit', '-qam', 'agent commit');
    expect(await currentHead(repo)).not.toBe(before!.head);
  });
});

describe('deleteChatRefs', () => {
  it('drops one chat\'s refs and leaves other chats alone', async () => {
    await captureCheckpoint(repo, turnRef('c1', 'm1', 'before'));
    await captureCheckpoint(repo, turnRef('c1', 'm2', 'before'));
    await captureCheckpoint(repo, turnRef('c2', 'm1', 'before'));

    expect(await deleteChatRefs(repo, 'c1', { keepMessageIds: ['m2'] })).toBe(1);
    const left = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/codey/').split('\n');
    expect(left).toEqual([turnRef('c1', 'm2', 'before'), turnRef('c2', 'm1', 'before')]);

    expect(await deleteChatRefs(repo, 'c1')).toBe(1);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/codey/')).toBe(turnRef('c2', 'm1', 'before'));
  });
});
