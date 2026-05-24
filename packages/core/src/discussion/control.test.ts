import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseControl,
  serializeControl,
  readControl,
  writeControl,
  ControlFile,
} from './control';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-'));
}

describe('parseControl', () => {
  it('parses a running control file', () => {
    const text = `---
status: running
revision: 3
updated_at: 2026-01-01T00:00:00.000Z
---

## Directive

Investigate the bug.
`;
    const c = parseControl(text);
    expect(c.status).toBe('running');
    expect(c.revision).toBe(3);
    expect(c.directive).toBe('Investigate the bug.');
    expect(c.userQuestion).toBeUndefined();
  });

  it('parses paused + free-text User Question', () => {
    const text = `---
status: paused
revision: 5
updated_at: 2026-01-01T00:00:00.000Z
---

## Directive

Pick an approach.

## User Question

Which database should we use for this workload?
`;
    const c = parseControl(text);
    expect(c.status).toBe('paused');
    expect(c.userQuestion).toBe('Which database should we use for this workload?');
    expect(c.userQuestionChoices).toBeUndefined();
  });

  it('parses User Question with bulleted choices', () => {
    const text = `---
status: paused
revision: 7
updated_at: 2026-01-01T00:00:00.000Z
---

## Directive

Pick one.

## User Question

Which database?
- Postgres
- SQLite
- MySQL
`;
    const c = parseControl(text);
    expect(c.userQuestion).toBe('Which database?');
    expect(c.userQuestionChoices).toEqual(['Postgres', 'SQLite', 'MySQL']);
  });
});

describe('roundtrip', () => {
  it('parseControl(serializeControl(c)) deep-equals c', () => {
    const c: ControlFile = {
      status: 'paused',
      revision: 42,
      updatedAt: '2026-05-24T12:34:56.000Z',
      directive: 'Do the thing.\n\nWith care.',
      userQuestion: 'Which one?',
      userQuestionChoices: ['A', 'B'],
      resumeNote: 'Resuming after user picked A.',
    };
    const round = parseControl(serializeControl(c));
    expect(round).toEqual(c);
  });
});

describe('writeControl', () => {
  it('bumps revision on success', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'control.md');
    const initial: ControlFile = {
      status: 'running',
      revision: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      directive: 'Initial directive.',
    };
    fs.writeFileSync(file, serializeControl(initial), 'utf8');
    const after = await writeControl(file, (prev) => ({
      status: prev.status,
      directive: 'Updated directive.',
    }));
    expect(after.revision).toBe(2);
    expect(after.directive).toBe('Updated directive.');
    const disk = await readControl(file);
    expect(disk?.revision).toBe(2);
  });

  it('throws stale error when expectedRevision does not match', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'control.md');
    const initial: ControlFile = {
      status: 'running',
      revision: 5,
      updatedAt: '2026-01-01T00:00:00.000Z',
      directive: 'X',
    };
    fs.writeFileSync(file, serializeControl(initial), 'utf8');
    await expect(
      writeControl(
        file,
        (prev) => ({ status: prev.status, directive: prev.directive }),
        { expectedRevision: 1 },
      ),
    ).rejects.toThrow(/stale/);
  });

  it('readControl returns null when file is missing', async () => {
    const dir = tmpDir();
    const result = await readControl(path.join(dir, 'nope.md'));
    expect(result).toBeNull();
  });

  it('serializes concurrent writes — revisions strictly monotonic', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'control.md');
    const initial: ControlFile = {
      status: 'running',
      revision: 10,
      updatedAt: '2026-01-01T00:00:00.000Z',
      directive: 'Start.',
    };
    fs.writeFileSync(file, serializeControl(initial), 'utf8');
    const [a, b] = await Promise.all([
      writeControl(file, (prev) => ({ status: prev.status, directive: prev.directive + ' A' })),
      writeControl(file, (prev) => ({ status: prev.status, directive: prev.directive + ' B' })),
    ]);
    const revs = [a.revision, b.revision].sort((x, y) => x - y);
    expect(revs).toEqual([11, 12]);
    const disk = await readControl(file);
    expect(disk?.revision).toBe(12);
  });
});
