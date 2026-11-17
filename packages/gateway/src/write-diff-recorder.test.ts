import { describe, it, expect } from 'vitest';
import { WriteDiffRecorder, countPatchLines, priorBlobs, aggregateTurnFiles, mergeTurnFiles, MAX_PATCH_CHARS, EMPTY_BLOB } from './write-diff-recorder';
import type { GitRunner } from './shell-write-tracker';

const EMPTY = EMPTY_BLOB;

/** A git that keeps blobs in memory: enough of hash-object / diff / rev-parse
 *  to exercise the recorder without a repo. */
const fakeGit = (opts: {
  files: Record<string, string | undefined>;
  head?: Record<string, string>;
  pruned?: Set<string>;
  onDiff?: (a: string, b: string) => string;
}) => {
  const blobs = new Map<string, string>([[EMPTY, '']]);
  const idFor = (content: string) => `blob-${Buffer.from(content).toString('hex').slice(0, 20) || 'empty'}`;
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
    if (cmd === 'rev-parse' && args[1] === '--verify') {
      const rel = args[3].slice('HEAD:'.length);
      const content = opts.head?.[rel];
      if (content === undefined) throw new Error('not in HEAD');
      const id = idFor(content);
      blobs.set(id, content);
      return `${id}\n`;
    }
    if (cmd === 'hash-object') {
      const target = args[args.length - 1];
      if (target === '/dev/null') return `${EMPTY}\n`;
      const content = opts.files[target];
      if (content === undefined) throw new Error('no such file');
      const id = idFor(content);
      blobs.set(id, content);
      return `${id}\n`;
    }
    if (cmd === 'cat-file') {
      if (opts.pruned?.has(args[2]) || !blobs.has(args[2])) throw new Error('missing');
      return '';
    }
    if (cmd === 'diff') {
      const [a, b] = args.slice(-2);
      if (opts.onDiff) return opts.onDiff(a, b);
      const before = (blobs.get(a) ?? '').split('\n').filter(Boolean);
      const after = (blobs.get(b) ?? '').split('\n').filter(Boolean);
      const body = [...before.map(l => `-${l}`), ...after.map(l => `+${l}`)].join('\n');
      return `diff --git a/${a} b/${b}\nindex 000..111 100644\n--- a/${a}\n+++ b/${b}\n@@ -1,${before.length} +1,${after.length} @@\n${body}\n`;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls, idFor };
};

describe('countPatchLines', () => {
  it('counts +/- lines but not the file header', () => {
    expect(countPatchLines('--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n')).toEqual({ added: 2, removed: 1 });
  });
});

describe('priorBlobs', () => {
  it('keeps the newest blob per path', () => {
    const map = priorBlobs([
      { toolCalls: [{ writeDiffs: [{ path: '/a', added: 1, removed: 0, blob: 'old' }] }] },
      { toolCalls: [{ writeDiffs: [{ path: '/a', added: 1, removed: 0, blob: 'new' }, { path: '/b', added: 0, removed: 1, blob: 'b1' }] }] },
    ]);
    expect(map.get('/a')).toBe('new');
    expect(map.get('/b')).toBe('b1');
  });
});

describe('aggregateTurnFiles', () => {
  it('keeps the first before and the last after per path', () => {
    expect(aggregateTurnFiles([
      { path: '/a', added: 1, removed: 0, blob: 'a1', before: 'a0' },
      { path: '/a', added: 1, removed: 0, blob: 'a2', before: 'a1' },
      { path: '/b', added: 0, removed: 1, blob: 'b1', before: 'b0' },
    ])).toEqual([
      { path: '/a', before: 'a0', after: 'a2' },
      { path: '/b', before: 'b0', after: 'b1' },
    ]);
  });

  it('leaves before unset when the first write had no exact before', () => {
    // A later exact before must not stand in for the turn's starting state.
    expect(aggregateTurnFiles([
      { path: '/c', added: 1, removed: 0, blob: 'c1' },
      { path: '/c', added: 1, removed: 0, blob: 'c2', before: 'c1' },
    ])).toEqual([{ path: '/c', after: 'c2' }]);
  });
});

describe('mergeTurnFiles', () => {
  it('keeps the earlier before and the later after', () => {
    expect(mergeTurnFiles(
      [{ path: '/a', before: 'a0', after: 'a1' }, { path: '/b', after: 'b1' }],
      [{ path: '/a', before: 'a1', after: 'a2' }, { path: '/c', before: 'c0', after: 'c1' }],
    )).toEqual([
      { path: '/a', before: 'a0', after: 'a2' },
      { path: '/b', after: 'b1' },
      { path: '/c', before: 'c0', after: 'c1' },
    ]);
  });
});

describe('WriteDiffRecorder', () => {
  it('diffs a tracked file against its committed copy on the first write', async () => {
    const { git, idFor } = fakeGit({ files: { '/repo/src/a.ts': 'one\ntwo\n' }, head: { 'src/a.ts': 'one\n' } });
    const rec = new WriteDiffRecorder('/repo', git);
    const out = await rec.record(['/repo/src/a.ts'], { cleanAtStart: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: '/repo/src/a.ts', added: 2, removed: 1, before: idFor('one\n'), blob: idFor('one\ntwo\n') });
    expect(out[0].patch).toContain('--- a/src/a.ts');
    expect(out[0].patch).toContain('+++ b/src/a.ts');
    expect(out[0].patch).toContain('+two');
  });

  it('primes on-disk content before the write so dirty files keep their real before', async () => {
    const files: Record<string, string | undefined> = { '/repo/a.ts': 'dirty\n' };
    const { git, idFor } = fakeGit({ files, head: { 'a.ts': 'committed\n' } });
    const rec = new WriteDiffRecorder('/repo', git);
    await rec.primeBefore(['/repo/a.ts']);
    files['/repo/a.ts'] = 'dirty\nafter\n';
    const out = await rec.record(['/repo/a.ts']);
    expect(out[0].before).toBe(idFor('dirty\n'));
    expect(out[0].blob).toBe(idFor('dirty\nafter\n'));
    expect(out[0].patch).toContain('+after');
    expect(out[0].patch).not.toContain('committed');
  });

  it('charges a second primed write in the same turn only its own change', async () => {
    const files: Record<string, string | undefined> = { '/repo/a.ts': 'one\n' };
    const { git, idFor } = fakeGit({ files, head: { 'a.ts': 'one\n' } });
    const rec = new WriteDiffRecorder('/repo', git);
    await rec.primeBefore(['/repo/a.ts']);
    files['/repo/a.ts'] = 'one\ntwo\n';
    const first = await rec.record(['/repo/a.ts']);
    await rec.primeBefore(['/repo/a.ts']);
    files['/repo/a.ts'] = 'one\ntwo\nthree\n';
    const second = await rec.record(['/repo/a.ts']);
    expect(second[0].before).toBe(idFor('one\ntwo\n'));
    expect(second[0].patch).toContain('+three');
    expect(aggregateTurnFiles([...first, ...second])).toEqual([
      { path: '/repo/a.ts', before: idFor('one\n'), after: idFor('one\ntwo\nthree\n') },
    ]);
  });

  it('uses HEAD, not a stale earlier write, for a path clean at the start', async () => {
    // An earlier turn left "old"; the user since reset the file to HEAD.
    const files: Record<string, string | undefined> = { '/repo/a.ts': 'old\n' };
    const { git, idFor } = fakeGit({ files, head: { 'a.ts': 'committed\n' } });
    await git(['hash-object', '-w', '--', '/repo/a.ts'], '/repo');
    files['/repo/a.ts'] = 'new\n';
    const stale = () => new Map([['/repo/a.ts', idFor('old\n')]]);
    const guess = await new WriteDiffRecorder('/repo', git, stale()).record(['/repo/a.ts']);
    expect(guess[0].before).toBeUndefined();
    const exact = await new WriteDiffRecorder('/repo', git, stale()).record(['/repo/a.ts'], { cleanAtStart: true });
    expect(exact[0].before).toBe(idFor('committed\n'));
  });

  it('matches a path to the repo root through a symlink', async () => {
    // git reports the resolved root; the agent may name the file by the link.
    const { git } = fakeGit({ files: { '/link/src/a.ts': 'one\ntwo\n' }, head: { 'src/a.ts': 'one\n' } });
    const realpath = async (p: string) => p.replace(/^\/link/, '/repo');
    const out = await new WriteDiffRecorder('/link', git, new Map(), realpath).record(['/link/src/a.ts']);
    expect(out[0]).toMatchObject({ added: 2, removed: 1 });
    expect(out[0].patch).toContain('--- a/src/a.ts');
  });

  it('diffs a new file against nothing', async () => {
    const { git } = fakeGit({ files: { '/repo/new.ts': 'x\ny\n' } });
    const out = await new WriteDiffRecorder('/repo', git).record(['/repo/new.ts']);
    expect(out[0]).toMatchObject({ added: 2, removed: 0 });
  });

  it('charges the second write only its own change', async () => {
    const files: Record<string, string | undefined> = { '/repo/a.ts': 'one\n' };
    const { git } = fakeGit({ files });
    const rec = new WriteDiffRecorder('/repo', git);
    await rec.record(['/repo/a.ts']);
    files['/repo/a.ts'] = 'one\ntwo\n';
    const out = await rec.record(['/repo/a.ts']);
    expect(out[0]).toMatchObject({ added: 2, removed: 1 });
    expect(out[0].patch).not.toContain('+one\n-');
  });

  it('starts from the blob a previous turn recorded', async () => {
    const files = { '/repo/a.ts': 'one\ntwo\n' };
    const { git, idFor } = fakeGit({ files, head: { 'a.ts': '' } });
    // Prime the blob store the way a prior turn would have.
    await git(['hash-object', '-w', '--', '/repo/a.ts'], '/repo');
    const prior = new Map([['/repo/a.ts', idFor('one\ntwo\n')]]);
    const out = await new WriteDiffRecorder('/repo', git, prior).record(['/repo/a.ts']);
    expect(out).toEqual([]); // unchanged since that turn
  });

  it('falls back to HEAD when the remembered blob was pruned', async () => {
    const { git } = fakeGit({ files: { '/repo/a.ts': 'one\ntwo\n' }, head: { 'a.ts': 'one\n' }, pruned: new Set(['gone']) });
    const prior = new Map([['/repo/a.ts', 'gone']]);
    const out = await new WriteDiffRecorder('/repo', git, prior).record(['/repo/a.ts']);
    expect(out[0]).toMatchObject({ added: 2, removed: 1 });
  });

  it('records a deleted file as all lines removed', async () => {
    const { git } = fakeGit({ files: {}, head: { 'a.ts': 'one\ntwo\n' } });
    const out = await new WriteDiffRecorder('/repo', git).record(['/repo/a.ts']);
    expect(out[0]).toMatchObject({ added: 0, removed: 2, blob: EMPTY });
  });

  it('keeps counts but drops the patch when it is too large', async () => {
    const big = 'x'.repeat(MAX_PATCH_CHARS + 10);
    const { git } = fakeGit({ files: { '/repo/a.ts': big }, onDiff: (a, b) => `diff --git a/${a} b/${b}\n--- a/${a}\n+++ b/${b}\n@@ -0,0 +1 @@\n+${big}\n` });
    const out = await new WriteDiffRecorder('/repo', git).record(['/repo/a.ts']);
    expect(out[0]).toMatchObject({ added: 1, removed: 0, truncated: true });
    expect(out[0].patch).toBeUndefined();
  });

  it('marks binary files by counts only', async () => {
    const { git } = fakeGit({ files: { '/repo/i.png': 'PNG' }, onDiff: (a, b) => `diff --git a/${a} b/${b}\nBinary files a/${a} and b/${b} differ\n` });
    const out = await new WriteDiffRecorder('/repo', git).record(['/repo/i.png']);
    expect(out[0]).toMatchObject({ added: 0, removed: 0 });
    expect(out[0].patch).toBeUndefined();
  });

  it('disables itself outside a repo and returns nothing', async () => {
    const git: GitRunner = async () => { throw new Error('not a git repository'); };
    const rec = new WriteDiffRecorder('/nowhere', git);
    expect(await rec.record(['/nowhere/a'])).toEqual([]);
    expect(await rec.record(['/nowhere/a'])).toEqual([]);
  });
});
