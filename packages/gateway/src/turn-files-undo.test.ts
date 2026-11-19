import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyFileRestore, combineTurnFiles, pinTurnFiles, planBlocker, planFileRestore, turnFilesRef, unpinTurnFiles,
} from './turn-files-undo';
import { EMPTY_BLOB } from './write-diff-recorder';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (rel: string, content: string) => fs.writeFileSync(path.join(repo, rel), content);
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const blob = (rel: string) => git('hash-object', '-w', rel);
const abs = (rel: string) => path.join(repo, rel);

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tfu-')));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  write('a.txt', 'a0\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('hash-object', '-w', '/dev/null');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('combineTurnFiles', () => {
  it('keeps the oldest before and the newest after per path', () => {
    expect(combineTurnFiles([
      [{ path: '/a', before: 'a0', after: 'a1' }],
      [{ path: '/a', before: 'a1', after: 'a2' }, { path: '/b', before: 'b0', after: 'b1' }],
    ])).toEqual([
      { path: '/a', before: 'a0', after: 'a2' },
      { path: '/b', before: 'b0', after: 'b1' },
    ]);
  });
});

describe('file restore', () => {
  it('undoes an edit and a created file, then redoes both', async () => {
    const a0 = blob('a.txt');
    write('a.txt', 'a1\n');
    write('new.txt', 'n1\n');
    const files = [
      { path: abs('a.txt'), before: a0, after: blob('a.txt') },
      { path: abs('new.txt'), before: EMPTY_BLOB, after: blob('new.txt') },
    ];
    const undo = await planFileRestore(repo, files, 'undo');
    expect(planBlocker(undo, repo, 'undo')).toBeNull();
    await applyFileRestore(repo, files, 'undo');
    expect(read('a.txt')).toBe('a0\n');
    expect(fs.existsSync(abs('new.txt'))).toBe(false);

    const redo = await planFileRestore(repo, files, 'redo');
    expect(planBlocker(redo, repo, 'redo')).toBeNull();
    await applyFileRestore(repo, files, 'redo');
    expect(read('a.txt')).toBe('a1\n');
    expect(read('new.txt')).toBe('n1\n');
  });

  it('brings back a file the turn deleted, creating its folder', async () => {
    fs.mkdirSync(abs('dir'));
    write('dir/x.txt', 'x0\n');
    const x0 = blob('dir/x.txt');
    fs.rmSync(abs('dir'), { recursive: true });
    const files = [{ path: abs('dir/x.txt'), before: x0, after: EMPTY_BLOB }];
    expect(planBlocker(await planFileRestore(repo, files, 'undo'), repo, 'undo')).toBeNull();
    await applyFileRestore(repo, files, 'undo');
    expect(read('dir/x.txt')).toBe('x0\n');
  });

  it('refuses when a file changed after the turn, and names it', async () => {
    const a0 = blob('a.txt');
    write('a.txt', 'a1\n');
    const files = [{ path: abs('a.txt'), before: a0, after: blob('a.txt') }];
    write('a.txt', 'a1 plus a hand edit\n');
    const plan = await planFileRestore(repo, files, 'undo');
    expect(plan.conflicts).toEqual([abs('a.txt')]);
    expect(planBlocker(plan, repo, 'undo')).toContain('a.txt');
    expect(read('a.txt')).toBe('a1 plus a hand edit\n');
  });

  it('refuses a path whose pre-turn content is unknown', async () => {
    write('a.txt', 'a1\n');
    const plan = await planFileRestore(repo, [{ path: abs('a.txt'), after: blob('a.txt') }], 'undo');
    expect(plan.unknown).toEqual([abs('a.txt')]);
    expect(planBlocker(plan, repo, 'undo')).toMatch(/does not know/);
  });

  it('refuses a redo when the file changed after the undo', async () => {
    const a0 = blob('a.txt');
    write('a.txt', 'a1\n');
    const files = [{ path: abs('a.txt'), before: a0, after: blob('a.txt') }];
    await applyFileRestore(repo, files, 'undo');
    write('a.txt', 'someone else\n');
    expect(planBlocker(await planFileRestore(repo, files, 'redo'), repo, 'redo')).toMatch(/after the undo/);
  });
});

describe('pinTurnFiles', () => {
  it('keeps loose ledger blobs through gc --prune=now, until unpinned', async () => {
    write('a.txt', 'only in the ledger\n');
    const loose = blob('a.txt');
    write('a.txt', 'a0\n');
    const ref = turnFilesRef('chat/1', 'msg 1');
    expect(ref).toBe('refs/codey/chats/chat_1/files/msg_1');
    expect(await pinTurnFiles(repo, ref, [{ path: abs('a.txt'), before: loose, after: blob('a.txt') }])).toBe(true);
    git('gc', '-q', '--prune=now');
    expect(git('cat-file', '-t', loose)).toBe('blob');

    await unpinTurnFiles(repo, [ref]);
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    expect(() => git('cat-file', '-e', loose)).toThrow();
  });
});
