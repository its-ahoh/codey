import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeTranscriptSlice,
  buildSliceDigest,
  renderSliceSection,
  sweepTranscriptSlices,
} from './transcript-slice';

describe('writeTranscriptSlice', () => {
  let dir: string;
  let source: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-slice-'));
    source = path.join(dir, 'chat.jsonl');
    const rows = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ id: `m${i + 1}`, role: i % 2 ? 'assistant' : 'user', text: `body ${i + 1}` }));
    fs.writeFileSync(source, rows.join('\n') + '\n');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function sliceLines(file: string): any[] {
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('extracts exactly the requested inclusive range', () => {
    const slice = writeTranscriptSlice(source, 10, 20)!;
    const rows = sliceLines(slice.path);
    expect(slice.lines).toBe(11);
    expect(rows).toHaveLength(11);
    expect(rows[0].text).toBe('body 10');
    expect(rows[10].text).toBe('body 20');
  });

  it('writes beside the source, not over it', () => {
    const slice = writeTranscriptSlice(source, 1, 5)!;
    expect(slice.path).toBe(path.join(dir, '.slices', 'chat.slice.jsonl'));
    expect(sliceLines(source)).toHaveLength(50);
  });

  it('supersedes the previous slice instead of accumulating files', () => {
    writeTranscriptSlice(source, 1, 5);
    const second = writeTranscriptSlice(source, 40, 50)!;
    expect(fs.readdirSync(path.join(dir, '.slices'))).toHaveLength(1);
    expect(sliceLines(second.path)[0].text).toBe('body 40');
  });

  it('returns undefined for an empty or inverted range', () => {
    expect(writeTranscriptSlice(source, 20, 10)).toBeUndefined();
    expect(writeTranscriptSlice(source, 0, 5)).toBeUndefined();
    expect(writeTranscriptSlice(source, 90, 99)).toBeUndefined();
  });

  it('returns undefined when the source is unreadable', () => {
    expect(writeTranscriptSlice(path.join(dir, 'missing.jsonl'), 1, 5)).toBeUndefined();
  });

  it('clamps a range that runs past the end of the source', () => {
    const slice = writeTranscriptSlice(source, 45, 200)!;
    expect(slice.lines).toBe(6);
  });
});

describe('buildSliceDigest', () => {
  function rows(count: number, body = 'hello'): string[] {
    return Array.from({ length: count }, (_, i) =>
      JSON.stringify({ role: i % 2 ? 'assistant' : 'user', text: `${body} ${i + 1}` }));
  }

  it('numbers entries from the slice start line, not from one', () => {
    const digest = buildSliceDigest(rows(3), 48);
    expect(digest.split('\n')[0].startsWith('48 [user]')).toBe(true);
  });

  it('drops the middle once there are too many entries', () => {
    const digest = buildSliceDigest(rows(40), 1);
    expect(digest).toContain('more turns omitted from this skeleton');
    expect(digest.split('\n').length).toBeLessThan(15);
  });

  it('truncates long bodies instead of reproducing them', () => {
    const digest = buildSliceDigest([JSON.stringify({ role: 'user', text: 'x'.repeat(5000) })], 1);
    expect(digest.length).toBeLessThan(200);
    expect(digest).toContain('…');
  });

  it('skips unparseable and empty rows rather than failing', () => {
    const digest = buildSliceDigest(['not json', JSON.stringify({ role: 'user', text: '' }), rows(1)[0]], 1);
    expect(digest.split('\n')).toHaveLength(1);
  });

  it('prefers a worker or agent label over the bare role', () => {
    const digest = buildSliceDigest([JSON.stringify({ role: 'assistant', agent: 'codex', text: 'hi' })], 1);
    expect(digest).toContain('[codex]');
  });
});

describe('renderSliceSection', () => {
  it('tells the agent to read the file and warns that it is temporary', () => {
    const section = renderSliceSection(
      { path: '/tmp/x.slice.jsonl', lines: 96, digest: '1 [user] hi' },
      { heading: 'Earlier conversation', closing: 'Context only.' },
    );
    expect(section).toContain('/tmp/x.slice.jsonl');
    expect(section).toContain('96 messages');
    expect(section).toContain('Read the whole file');
    expect(section).toContain('temporary');
    expect(section).toContain('Skeleton');
    expect(section.trimEnd().endsWith('Context only.')).toBe(true);
  });

  it('omits the skeleton block when there is no digest', () => {
    const section = renderSliceSection(
      { path: '/tmp/x.slice.jsonl', lines: 2, digest: '' },
      { heading: 'Earlier conversation', closing: 'Context only.' },
    );
    expect(section).not.toContain('Skeleton');
  });
});

describe('sweepTranscriptSlices', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-sweep-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes aged slices and keeps fresh ones', () => {
    fs.writeFileSync(path.join(dir, 'old.slice.jsonl'), 'x');
    fs.writeFileSync(path.join(dir, 'new.slice.jsonl'), 'x');
    const old = path.join(dir, 'old.slice.jsonl');
    const aged = Date.now() - 3 * 60 * 60 * 1000;
    fs.utimesSync(old, aged / 1000, aged / 1000);

    expect(sweepTranscriptSlices(dir)).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['new.slice.jsonl']);
  });

  it('is a no-op on a directory that does not exist', () => {
    expect(sweepTranscriptSlices(path.join(dir, 'nope'))).toBe(0);
  });
});
