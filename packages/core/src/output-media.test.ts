import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractOutputImages, labelOutputImages, OUTPUT_IMAGE_MAX_BYTES } from './output-media';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
let work: string;
let outside: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'media-work-'));
  outside = fs.mkdtempSync(path.join(os.homedir(), '.media-outside-'));
});
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const outputsDir = () => path.join(work, '.codey', 'uploads', 'outputs');

describe('extractOutputImages', () => {
  it('snapshots a relative image and rewrites the path', () => {
    fs.writeFileSync(path.join(work, 'chart.png'), PNG);
    const r = extractOutputImages('Here:\n![Sales chart](chart.png)\nDone', { workingDir: work });
    expect(r.images).toHaveLength(1);
    const img = r.images[0];
    expect(img.name).toBe('chart.png');
    expect(img.mimeType).toBe('image/png');
    expect(img.size).toBe(PNG.length);
    expect(path.dirname(img.path)).toBe(fs.realpathSync(outputsDir()));
    expect(fs.readFileSync(img.path)).toEqual(PNG);
    expect(r.text).toBe(`Here:\n![Sales chart](<${img.path}>)\nDone`);
  });

  it('accepts absolute paths, file:// URLs and angle-bracket paths with spaces', () => {
    fs.writeFileSync(path.join(work, 'a b.png'), PNG);
    const abs = path.join(work, 'a b.png');
    const text = `![x](<${abs}>) ![y](file://${encodeURI(abs)})`;
    const r = extractOutputImages(text, { workingDir: work });
    expect(r.images).toHaveLength(1); // same source twice → one snapshot
    expect(r.text).toBe(`![x](<${r.images[0].path}>) ![y](<${r.images[0].path}>)`);
  });

  it('accepts files in the OS temp dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-tmp-'));
    try {
      const tmpFile = path.join(tmpDir, 'plot.svg');
      fs.writeFileSync(tmpFile, '<svg/>');
      const r = extractOutputImages(`![p](${tmpFile})`, { workingDir: work });
      expect(r.images[0].mimeType).toBe('image/svg+xml');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('accepts files under /tmp', () => {
    const tmpDir = fs.mkdtempSync('/tmp/media-');
    try {
      const tmpFile = path.join(tmpDir, 'plot.png');
      fs.writeFileSync(tmpFile, PNG);
      const r = extractOutputImages(`![p](${tmpFile})`, { workingDir: work });
      expect(r.images).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses to copy into an outputs dir that is a symlink out of the project', () => {
    fs.writeFileSync(path.join(work, 'chart.png'), PNG);
    fs.mkdirSync(path.join(work, '.codey', 'uploads'), { recursive: true });
    fs.symlinkSync(outside, outputsDir());
    const text = '![c](chart.png)';
    const r = extractOutputImages(text, { workingDir: work });
    expect(r.images).toEqual([]);
    expect(r.text).toBe(text);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('does not reuse a file in a symlinked outputs dir outside the project', () => {
    fs.mkdirSync(path.join(work, '.codey', 'uploads'), { recursive: true });
    fs.symlinkSync(outside, outputsDir());
    fs.writeFileSync(path.join(outside, 'x.png'), PNG);
    const text = `![c](${path.join(outputsDir(), 'x.png')})`;
    const r = extractOutputImages(text, { workingDir: work });
    expect(r.images).toEqual([]);
  });

  it('ignores image syntax inside inline code spans', () => {
    fs.writeFileSync(path.join(work, 'chart.png'), PNG);
    const text = 'use `![x](chart.png)` here';
    expect(extractOutputImages(text, { workingDir: work })).toEqual({ text, images: [] });
  });

  it('leaves remote, missing, non-image, oversize and out-of-tree targets untouched', () => {
    fs.writeFileSync(path.join(work, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(work, 'big.png'), Buffer.alloc(OUTPUT_IMAGE_MAX_BYTES + 1));
    fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
    const text = [
      '![r](https://example.com/a.png)',
      '![m](missing.png)',
      '![t](notes.txt)',
      '![b](big.png)',
      `![o](${path.join(outside, 'secret.png')})`,
    ].join('\n');
    const r = extractOutputImages(text, { workingDir: work });
    expect(r.images).toEqual([]);
    expect(r.text).toBe(text);
  });

  it('rejects a symlink inside the project that points outside it', () => {
    fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(work, 'link.png'));
    const r = extractOutputImages('![l](link.png)', { workingDir: work });
    expect(r.images).toEqual([]);
  });

  it('ignores image syntax inside fenced code blocks', () => {
    fs.writeFileSync(path.join(work, 'chart.png'), PNG);
    const text = '```md\n![c](chart.png)\n```';
    expect(extractOutputImages(text, { workingDir: work })).toEqual({ text, images: [] });
  });

  it('reuses an existing snapshot instead of copying it again', () => {
    fs.writeFileSync(path.join(work, 'chart.png'), PNG);
    const first = extractOutputImages('![c](chart.png)', { workingDir: work });
    const second = extractOutputImages(first.text, { workingDir: work });
    expect(second.images[0].path).toBe(first.images[0].path);
    expect(fs.readdirSync(outputsDir()).filter(f => f.endsWith('.png'))).toHaveLength(1);
  });

  it('shares snapshots across calls through a cache', () => {
    fs.writeFileSync(path.join(work, 'chart.png'), PNG);
    const cache = new Map();
    const a = extractOutputImages('![a](chart.png)', { workingDir: work, cache });
    const b = extractOutputImages('again ![b](chart.png) ![c](chart.png)', { workingDir: work, cache });
    expect(a.images).toHaveLength(1);
    expect(b.images).toHaveLength(1);
    expect(b.images[0].path).toBe(a.images[0].path);
    expect(b.text).toBe(`again ![b](<${a.images[0].path}>) ![c](<${a.images[0].path}>)`);
    expect(fs.readdirSync(outputsDir())).toHaveLength(1);
  });

  it('keeps uploads out of git', () => {
    fs.writeFileSync(path.join(work, 'chart.png'), PNG);
    extractOutputImages('![c](chart.png)', { workingDir: work });
    expect(fs.readFileSync(path.join(work, '.codey', 'uploads', '.gitignore'), 'utf8')).toBe('*\n');
  });
});

describe('labelOutputImages', () => {
  it('replaces attached images with a text label and leaves others alone', () => {
    const p = '/w/.codey/uploads/outputs/1-a-chart.png';
    const text = `See ![Sales](<${p}>) and ![](<${p}>) and ![r](https://e.com/x.png)`;
    const out = labelOutputImages(text, [{ id: '1', name: 'chart.png', path: p, mimeType: 'image/png', size: 1 }]);
    expect(out).toBe('See [Image: Sales] and [Image] and ![r](https://e.com/x.png)');
  });

  it('leaves image syntax inside inline code spans alone', () => {
    const p = '/w/.codey/uploads/outputs/1-a-chart.png';
    const text = `use \`![x](<${p}>)\` here`;
    const out = labelOutputImages(text, [{ id: '1', name: 'chart.png', path: p, mimeType: 'image/png', size: 1 }]);
    expect(out).toBe(text);
  });
});
