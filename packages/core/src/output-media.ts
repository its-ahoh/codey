import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { FileAttachment } from './types/chat';

/** Telegram's photo cap; Discord's default bot upload cap is the same. */
export const OUTPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

// ![alt](target "optional title") — target is either <anything but >> or a run without spaces.
const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
const FENCE_RE = /(```[\s\S]*?```)/g;

const realpathOrNull = (p: string): string | null => {
  try { return fs.realpathSync(p); } catch { return null; }
};

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Map over the parts of `text` that are outside fenced code blocks. */
const mapOutsideFences = (text: string, fn: (part: string) => string): string =>
  text.split(FENCE_RE).map((part, i) => (i % 2 === 1 ? part : fn(part))).join('');

const toLocalPath = (raw: string, workingDir: string): string | null => {
  const target = raw.startsWith('<') ? raw.slice(1, -1).trim() : raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return null; // http(s), data:, etc.
  let p: string;
  try {
    p = /^file:/i.test(target) ? fileURLToPath(target) : target;
  } catch {
    return null;
  }
  const resolved = path.resolve(workingDir, p);
  if (fs.existsSync(resolved)) return resolved;
  try {
    const decoded = path.resolve(workingDir, decodeURIComponent(p));
    return fs.existsSync(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

const ensureOutputsDir = (workingDir: string): string => {
  const uploads = path.join(workingDir, '.codey', 'uploads');
  const outputs = path.join(uploads, 'outputs');
  fs.mkdirSync(outputs, { recursive: true });
  const ignore = path.join(uploads, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return outputs;
};

export interface ExtractOptions {
  workingDir: string;
  now?: () => number;
}

/**
 * Snapshot every local image an agent referenced with `![alt](path)` into
 * `<workingDir>/.codey/uploads/outputs/` and point the Markdown at the copy.
 * Copies keep chat history stable when the agent later edits the file, and the
 * Mac app's codey-asset protocol only serves `.codey/uploads/`. Anything that
 * is not a readable image inside the working dir or the OS temp dir is left
 * exactly as written.
 */
export function extractOutputImages(
  text: string,
  opts: ExtractOptions,
): { text: string; images: FileAttachment[] } {
  const now = opts.now ?? Date.now;
  const workRoot = realpathOrNull(opts.workingDir);
  if (!workRoot || !text.includes('![')) return { text, images: [] };
  const roots = [workRoot, realpathOrNull(os.tmpdir())].filter((r): r is string => !!r);
  const images: FileAttachment[] = [];
  const bySource = new Map<string, FileAttachment>();
  let outputsReal: string | null = realpathOrNull(path.join(workRoot, '.codey', 'uploads', 'outputs'));

  const snapshot = (source: string): FileAttachment | null => {
    const real = realpathOrNull(source);
    if (!real || !roots.some(r => isInside(real, r))) return null;
    const ext = path.extname(real).slice(1).toLowerCase();
    const mimeType = IMAGE_MIME[ext];
    if (!mimeType) return null;
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > OUTPUT_IMAGE_MAX_BYTES) return null;
    const cached = bySource.get(real);
    if (cached) return cached;
    let dest = real;
    try {
      if (!(outputsReal && path.dirname(real) === outputsReal)) {
        const dir = ensureOutputsDir(workRoot);
        outputsReal = realpathOrNull(dir);
        dest = path.join(outputsReal ?? dir, `${now()}-${randomBytes(4).toString('hex')}-${path.basename(real)}`);
        fs.copyFileSync(real, dest);
      }
    } catch {
      return null;
    }
    const att: FileAttachment = { id: randomUUID(), name: path.basename(real), path: dest, mimeType, size: stat.size };
    bySource.set(real, att);
    images.push(att);
    return att;
  };

  const out = mapOutsideFences(text, part => part.replace(IMAGE_RE, (whole, alt: string, target: string) => {
    const local = toLocalPath(target, workRoot);
    const att = local ? snapshot(local) : null;
    return att ? `![${alt}](<${att.path}>)` : whole;
  }));
  return { text: out, images };
}

/** Channel text: attached images become `[Image: alt]`; they are sent as files. */
export function labelOutputImages(text: string, images: FileAttachment[]): string {
  if (images.length === 0) return text;
  const paths = new Set(images.map(i => i.path));
  return mapOutsideFences(text, part => part.replace(IMAGE_RE, (whole, alt: string, target: string) => {
    const p = target.startsWith('<') ? target.slice(1, -1).trim() : target;
    if (!paths.has(p)) return whole;
    return alt.trim() ? `[Image: ${alt.trim()}]` : '[Image]';
  }));
}
