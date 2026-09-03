import { describe, it, expect } from 'vitest';
import {
  ShellWriteTracker,
  parsePorcelainPaths,
  changedBetween,
  mentionedPaths,
  fileChangePaths,
  type GitRunner,
  type StatRunner,
  type Snapshot,
} from './shell-write-tracker';

describe('parsePorcelainPaths', () => {
  it('reads the common status codes', () => {
    const out = parsePorcelainPaths([
      ' M src/a.ts',
      '?? src/new.ts',
      'A  src/added.ts',
      ' D src/gone.ts',
    ].join('\n'));
    expect(out).toEqual(['src/a.ts', 'src/new.ts', 'src/added.ts', 'src/gone.ts']);
  });

  it('takes the destination of a rename', () => {
    expect(parsePorcelainPaths('R  src/old.ts -> src/new.ts')).toEqual(['src/new.ts']);
  });

  it('unquotes paths git escaped', () => {
    expect(parsePorcelainPaths('?? "src/my file.ts"')).toEqual(['src/my file.ts']);
    expect(parsePorcelainPaths('?? "src/tab\\there.ts"')).toEqual(['src/tab\there.ts']);
  });

  it('ignores blank and truncated lines', () => {
    expect(parsePorcelainPaths('\n M\n')).toEqual([]);
  });
});

describe('changedBetween', () => {
  const snap = (entries: Record<string, string>): Snapshot => new Map(Object.entries(entries));

  it('finds a file that became dirty', () => {
    expect(changedBetween(snap({}), snap({ 'a.ts': '10:1' }))).toEqual(['a.ts']);
  });

  it('finds a re-edit of an already-dirty file', () => {
    // Same porcelain status both times -- only the stamp reveals the second edit.
    expect(changedBetween(snap({ 'a.ts': '10:1' }), snap({ 'a.ts': '12:2' }))).toEqual(['a.ts']);
  });

  it('ignores a dirty file nobody touched', () => {
    expect(changedBetween(snap({ 'a.ts': '10:1' }), snap({ 'a.ts': '10:1' }))).toEqual([]);
  });

  it('finds a file reverted to its committed content', () => {
    expect(changedBetween(snap({ 'a.ts': '10:1' }), snap({}))).toEqual(['a.ts']);
  });
});

describe('mentionedPaths', () => {
  const root = '/repo';

  it('keeps a path named relative to the repo root', () => {
    expect(mentionedPaths('sed -i "" s/a/b/ src/a.ts', ['src/a.ts'], root, root)).toEqual(['src/a.ts']);
  });

  it('keeps a path named absolutely', () => {
    expect(mentionedPaths('python3 /repo/src/a.ts', ['src/a.ts'], root, root)).toEqual(['src/a.ts']);
  });

  it('keeps a bare basename', () => {
    expect(mentionedPaths('cd src && touch a.ts', ['src/a.ts'], root, root)).toEqual(['src/a.ts']);
  });

  it('keeps a path relative to a working dir below the repo root', () => {
    expect(mentionedPaths('touch components/a.ts', ['app/components/a.ts'], root, '/repo/app'))
      .toEqual(['app/components/a.ts']);
  });

  it('drops a concurrent chat\'s edit that this command never names', () => {
    const changed = ['src/mine.ts', 'voice/theirs.swift'];
    expect(mentionedPaths('python3 edit.py src/mine.ts', changed, root, root)).toEqual(['src/mine.ts']);
  });

  it('finds nothing for an empty command', () => {
    expect(mentionedPaths('', ['src/a.ts'], root, root)).toEqual([]);
  });
});

// ── Tracker ────────────────────────────────────────────────────────────────

type Tree = Record<string, { status: string; size: number; mtimeMs: number }>;

/** One tree per `git status` call, i.e. one per noteStart/noteEnd in order. */
const harness = (samples: Tree[]) => {
  let call = 0;
  let active: Tree = {};
  const git: GitRunner = async (args) => {
    if (args[0] === 'rev-parse') return '/repo\n';
    if (args[0] === 'status') {
      active = samples[Math.min(call, samples.length - 1)];
      call++;
      return Object.entries(active).map(([p, f]) => `${f.status} ${p}`).join('\n');
    }
    return '';
  };
  const stat: StatRunner = async (abs) => {
    const f = active[abs.replace('/repo/', '')];
    return f ? { size: f.size, mtimeMs: f.mtimeMs } : null;
  };
  return { git, stat };
};

describe('ShellWriteTracker', () => {
  it('reports a file an interpreter wrote, which command parsing cannot see', async () => {
    const { git, stat } = harness([
      {},
      { 'src/a.ts': { status: ' M', size: 20, mtimeMs: 2 } },
    ]);
    const tracker = new ShellWriteTracker('/repo', git, stat);
    const command = "python3 - <<'PY'\np='src/a.ts'\nopen(p,'w').write(s)\nPY";
    await tracker.noteStart(command);
    expect(await tracker.noteEnd()).toEqual(['/repo/src/a.ts']);
  });

  it('drops a change this command never named', async () => {
    const { git, stat } = harness([
      {},
      {
        'src/mine.ts': { status: ' M', size: 20, mtimeMs: 2 },
        'voice/theirs.swift': { status: ' M', size: 30, mtimeMs: 2 },
      },
    ]);
    const tracker = new ShellWriteTracker('/repo', git, stat);
    await tracker.noteStart('python3 edit.py src/mine.ts');
    expect(await tracker.noteEnd()).toEqual(['/repo/src/mine.ts']);
  });

  it('reports nothing for a read-only command', async () => {
    const { git, stat } = harness([
      { 'src/a.ts': { status: ' M', size: 20, mtimeMs: 2 } },
      { 'src/a.ts': { status: ' M', size: 20, mtimeMs: 2 } },
    ]);
    const tracker = new ShellWriteTracker('/repo', git, stat);
    await tracker.noteStart('grep -rn foo src/a.ts');
    expect(await tracker.noteEnd()).toEqual([]);
  });

  it('disables itself outside a git repo and stops calling git', async () => {
    let calls = 0;
    const git: GitRunner = async () => { calls++; throw new Error('not a git repository'); };
    const stat: StatRunner = async () => null;
    const tracker = new ShellWriteTracker('/tmp/plain', git, stat);
    await tracker.noteStart('touch a.ts');
    expect(await tracker.noteEnd()).toEqual([]);
    const afterFirst = calls;
    await tracker.noteStart('touch b.ts');
    expect(await tracker.noteEnd()).toEqual([]);
    expect(calls).toBe(afterFirst);
  });

  it('gives up when the working tree is unusably dirty', async () => {
    const huge: Tree = {};
    for (let i = 0; i < 500; i++) huge[`f${i}.ts`] = { status: ' M', size: 1, mtimeMs: 1 };
    const { git, stat } = harness([huge, huge]);
    const tracker = new ShellWriteTracker('/repo', git, stat);
    await tracker.noteStart('touch f0.ts');
    expect(await tracker.noteEnd()).toEqual([]);
  });

  it('compares each command against the tree the previous one left', async () => {
    const a = { 'a.ts': { status: ' M', size: 10, mtimeMs: 1 } };
    const ab = { ...a, 'b.ts': { status: ' M', size: 5, mtimeMs: 3 } };
    const { git, stat } = harness([{}, a, a, ab]);
    const tracker = new ShellWriteTracker('/repo', git, stat);
    await tracker.noteStart('touch a.ts');
    expect(await tracker.noteEnd()).toEqual(['/repo/a.ts']);
    // Second command must not re-report a.ts, which it did not touch.
    await tracker.noteStart('touch b.ts');
    expect(await tracker.noteEnd()).toEqual(['/repo/b.ts']);
  });
});

describe('fileChangePaths', () => {
  it('reads the array the codex adapter emits and the string the tracker stores', () => {
    const list = [{ path: '/repo/a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }];
    expect(fileChangePaths(list, '/repo')).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(fileChangePaths(JSON.stringify(list), '/repo/')).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });

  it('returns nothing for junk', () => {
    expect(fileChangePaths('nope', '/repo')).toEqual([]);
    expect(fileChangePaths(undefined, '/repo')).toEqual([]);
    expect(fileChangePaths([null, 3, {}], '/repo')).toEqual([]);
  });
});
