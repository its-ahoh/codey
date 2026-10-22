# Agent Media Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agent replies carry images (via `![alt](path)`) to the Mac app and to Telegram/Discord/iMessage, render ` ```mermaid ` in the Mac app, and add a mermaid.live preview link when mermaid reaches a channel.

**Architecture:** A pure core module snapshots local images referenced in a finished reply into `<workingDir>/.codey/uploads/outputs/` and rewrites the paths. The gateway attaches those snapshots to the persisted message and to `GatewayResponse`; a small delivery helper sends text first, then images, then mermaid preview links through each channel handler's new `sendImages`. A per-turn prompt block tells agents how to emit images, and to prefer PNG over mermaid when the chat reaches a channel. The Mac `Markdown` component renders snapshot images through the existing `codey-asset://` protocol and lazy-loads `mermaid`.

**Tech Stack:** TypeScript (CommonJS, strict), Node `fs`/`zlib`/`child_process`, Vitest, node-telegram-bot-api, discord.js, React + react-markdown, mermaid.

**Spec:** `docs/superpowers/specs/2026-10-21-agent-media-output-design.md`

**Environment:** Node ≥ 24.12 (`nvm use v24.18.1`). Build order matters: `npm run build -w @codey/core` before gateway tests pick up new core exports.

**Channel copy is English** (matches existing channel strings such as `Reply with the number or the option text.`): `[Image: alt]`, `Image failed to send: <names>`, `Diagram preview: <url>`. The repo lint (`npm run lint`) rejects non-English characters in source.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/output-media.ts` (new) | `extractOutputImages`, `labelOutputImages` — find, validate, snapshot, rewrite |
| `packages/core/src/mermaid-link.ts` (new) | `findMermaidBlocks`, `mermaidLiveUrl` |
| `packages/core/src/media-prompt.ts` (new) | `mediaOutputInstruction(channelLinked)` |
| `packages/core/src/index.ts` | export the three modules |
| `packages/core/src/types/index.ts` | `GatewayResponse.attachments` |
| `packages/gateway/src/channel-delivery.ts` (new) | `channelMessageLimit`, `deliverMediaExtras` |
| `packages/gateway/src/channels/base.ts` | optional `sendImages` on `ChannelHandler` |
| `packages/gateway/src/channels/telegram.ts` | `sendImages` (photo / document) |
| `packages/gateway/src/channels/discord.ts` | `sendImages` (one message, files) |
| `packages/gateway/src/channels/imessage.ts` | `sendImages` via `osascript` with `execFile` |
| `packages/gateway/src/gateway.ts` | wire extraction, delivery, prompt hint |
| `packages/gateway/src/bot-message-emitter.ts` | rewrite worker message content on `endBot` |
| `packages/gateway/src/team-finalizer.ts` | pass member images to the Aide summary |
| `codey-mac/src/components/markdownImage.ts` (new) | pure `markdownImageSource` |
| `codey-mac/src/components/MermaidBlock.tsx` (new) | lazy mermaid render with fallback |
| `codey-mac/src/components/Markdown.tsx` | `img` + mermaid hooks |
| `codey-mac/src/hooks/useChats.tsx`, `codey-mac/src/services/api.ts` | `bot_end.content` |

---

### Task 1: Core — extract and snapshot output images

**Files:**
- Create: `packages/core/src/output-media.ts`
- Test: `packages/core/src/output-media.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/output-media.test.ts
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
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'media-tmp-')), 'plot.svg');
    fs.writeFileSync(tmpFile, '<svg/>');
    const r = extractOutputImages(`![p](${tmpFile})`, { workingDir: work });
    expect(r.images[0].mimeType).toBe('image/svg+xml');
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/core -- output-media`
Expected: FAIL — `Cannot find module './output-media'`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/output-media.ts
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
```

Add to `packages/core/src/index.ts` (next to the other `export *` lines):

```ts
export * from './output-media';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/core -- output-media`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/output-media.ts packages/core/src/output-media.test.ts packages/core/src/index.ts
git commit -m "feat(core): snapshot images referenced in agent replies"
```

---

### Task 2: Core — mermaid blocks and mermaid.live links

**Files:**
- Create: `packages/core/src/mermaid-link.ts`
- Test: `packages/core/src/mermaid-link.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/mermaid-link.test.ts
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { findMermaidBlocks, mermaidLiveUrl } from './mermaid-link';

describe('findMermaidBlocks', () => {
  it('returns the source of each mermaid fence and skips other fences', () => {
    const text = 'a\n```mermaid\ngraph TD\n  A-->B\n```\n```ts\nx\n```\n```mermaid\nsequenceDiagram\n```';
    expect(findMermaidBlocks(text)).toEqual(['graph TD\n  A-->B', 'sequenceDiagram']);
  });

  it('ignores an unterminated fence', () => {
    expect(findMermaidBlocks('```mermaid\ngraph TD')).toEqual([]);
  });
});

describe('mermaidLiveUrl', () => {
  it('encodes the diagram as a pako fragment that round-trips', () => {
    const url = mermaidLiveUrl('graph TD\n  A-->B');
    expect(url.startsWith('https://mermaid.live/view#pako:')).toBe(true);
    const data = url.split('#pako:')[1];
    expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
    const state = JSON.parse(inflateSync(Buffer.from(data, 'base64url')).toString('utf8'));
    expect(state.code).toBe('graph TD\n  A-->B');
    expect(JSON.parse(state.mermaid)).toEqual({ theme: 'default' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/core -- mermaid-link`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/mermaid-link.ts
import { deflateSync } from 'zlib';

const MERMAID_FENCE_RE = /^```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** Sources of every complete ```mermaid fence, in order. */
export function findMermaidBlocks(text: string): string[] {
  return [...text.matchAll(MERMAID_FENCE_RE)].map(m => m[1]);
}

/**
 * mermaid.live "pako" link. The diagram lives in the URL fragment, which the
 * browser never sends to the server.
 */
export function mermaidLiveUrl(code: string): string {
  const state = JSON.stringify({ code, mermaid: JSON.stringify({ theme: 'default' }) });
  const data = deflateSync(Buffer.from(state, 'utf8'), { level: 9 }).toString('base64url');
  return `https://mermaid.live/view#pako:${data}`;
}
```

Add `export * from './mermaid-link';` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @codey/core -- mermaid-link`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mermaid-link.ts packages/core/src/mermaid-link.test.ts packages/core/src/index.ts
git commit -m "feat(core): mermaid.live preview links"
```

---

### Task 3: Core — per-turn media prompt + `GatewayResponse.attachments`

**Files:**
- Create: `packages/core/src/media-prompt.ts`
- Test: `packages/core/src/media-prompt.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/types/index.ts:25-32`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/media-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { mediaOutputInstruction } from './media-prompt';

describe('mediaOutputInstruction', () => {
  it('always explains the image syntax', () => {
    for (const linked of [true, false]) {
      expect(mediaOutputInstruction(linked)).toContain('![short description](path/to/file.png)');
    }
  });

  it('asks channel-linked chats for PNG instead of mermaid', () => {
    const s = mediaOutputInstruction(true);
    expect(s).toContain('PNG');
    expect(s).toContain('do not use mermaid');
  });

  it('offers mermaid to Mac-only chats', () => {
    const s = mediaOutputInstruction(false);
    expect(s).toContain('```mermaid');
    expect(s).not.toContain('do not use mermaid');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/core -- media-prompt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/media-prompt.ts

/**
 * Appended to every turn's prompt (sessions are resumed, so a chat linked to a
 * channel mid-session must see the PNG rule on its next turn).
 */
export function mediaOutputInstruction(channelLinked: boolean): string {
  const base = '\n\n[Codey media output]\nTo show an image to the user, save it as a file inside the working directory (or the system temp directory) and reference it in your reply with Markdown: ![short description](path/to/file.png). Supported: png, jpg, gif, webp, svg, up to 10 MB.';
  return channelLinked
    ? `${base}\nThis chat is delivered to a messaging app (Telegram, Discord or iMessage). Draw charts and diagrams as PNG image files and reference them as above; do not use mermaid code blocks.`
    : `${base}\n\`\`\`mermaid code blocks render as diagrams in this app; use them for flowcharts and sequence diagrams.`;
}
```

Add `export * from './media-prompt';` to `packages/core/src/index.ts`.

In `packages/core/src/types/index.ts`, extend `GatewayResponse`:

```ts
export interface GatewayResponse {
  chatId: string;
  channel: ChannelType;
  text: string;
  replyTo?: string;
  /** When present, the response is asking the user to pick from these options. */
  choices?: string[];
  /** Image snapshots referenced from `text`; channels send them after the text. */
  attachments?: import('./chat').FileAttachment[];
}
```

- [ ] **Step 4: Run tests + build core**

Run: `npm test -w @codey/core -- media-prompt && npm run build -w @codey/core`
Expected: PASS, build exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/media-prompt.ts packages/core/src/media-prompt.test.ts packages/core/src/index.ts packages/core/src/types/index.ts
git commit -m "feat(core): media output prompt and response attachments"
```

---

### Task 4: Gateway — channel delivery helper

**Files:**
- Create: `packages/gateway/src/channel-delivery.ts`
- Test: `packages/gateway/src/channel-delivery.test.ts`
- Modify: `packages/gateway/src/channels/base.ts:3-11`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/src/channel-delivery.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { FileAttachment } from '@codey/core';
import { channelMessageLimit, deliverMediaExtras } from './channel-delivery';

const img = (name: string): FileAttachment => ({ id: name, name, path: `/w/.codey/uploads/outputs/${name}`, mimeType: 'image/png', size: 1 });

describe('channelMessageLimit', () => {
  it('uses each platform limit', () => {
    expect(channelMessageLimit('telegram')).toBe(4096);
    expect(channelMessageLimit('discord')).toBe(2000);
    expect(channelMessageLimit('imessage')).toBe(2000);
  });
});

describe('deliverMediaExtras', () => {
  it('sends images, then one preview link per mermaid block', async () => {
    const calls: string[] = [];
    await deliverMediaExtras({
      originalText: 'x\n```mermaid\ngraph TD\nA-->B\n```',
      attachments: [img('a.png')],
      maxLinkLength: 4096,
      sendText: async t => { calls.push(`text:${t.slice(0, 31)}`); },
      sendImages: async imgs => { calls.push(`images:${imgs.map(i => i.name).join(',')}`); return []; },
    });
    expect(calls).toEqual(['images:a.png', 'text:Diagram preview: https://mermai']);
  });

  it('reports failed images without throwing', async () => {
    const sendText = vi.fn(async () => {});
    await deliverMediaExtras({
      originalText: '',
      attachments: [img('a.png'), img('b.png')],
      maxLinkLength: 4096,
      sendText,
      sendImages: async () => ['b.png'],
    });
    expect(sendText).toHaveBeenCalledWith('Image failed to send: b.png');
  });

  it('treats a throwing sender and a missing sender as all failed', async () => {
    const sendText = vi.fn(async () => {});
    await deliverMediaExtras({
      originalText: '', attachments: [img('a.png')], maxLinkLength: 4096, sendText,
      sendImages: async () => { throw new Error('boom'); },
    });
    await deliverMediaExtras({ originalText: '', attachments: [img('c.png')], maxLinkLength: 4096, sendText });
    expect(sendText.mock.calls.map(c => c[0])).toEqual(['Image failed to send: a.png', 'Image failed to send: c.png']);
  });

  it('skips a preview link longer than the channel limit', async () => {
    const sendText = vi.fn(async () => {});
    await deliverMediaExtras({
      originalText: '```mermaid\ngraph TD\nA-->B\n```', attachments: [], maxLinkLength: 20, sendText,
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('does nothing for plain text', async () => {
    const sendText = vi.fn(async () => {});
    await deliverMediaExtras({ originalText: 'hello', attachments: [], maxLinkLength: 4096, sendText });
    expect(sendText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/gateway -- channel-delivery`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/channel-delivery.ts
import { findMermaidBlocks, mermaidLiveUrl, type FileAttachment, type ChannelType } from '@codey/core';

export function channelMessageLimit(channel: ChannelType | string): number {
  return channel === 'telegram' ? 4096 : 2000;
}

export interface MediaExtrasArgs {
  /** The reply as the agent wrote it (mermaid fences intact). */
  originalText: string;
  attachments: FileAttachment[];
  maxLinkLength: number;
  sendText: (text: string) => Promise<void>;
  /** Returns the names of images that failed. Absent = channel cannot send files. */
  sendImages?: (images: FileAttachment[]) => Promise<string[]>;
  log?: (message: string) => void;
}

/**
 * Everything a channel receives after the reply text: the image files, a
 * failure note when some did not go out, and one mermaid.live link per
 * mermaid block. Each link is its own message so chunking can never split it.
 * Never throws: the reply text has already been delivered.
 */
export async function deliverMediaExtras(args: MediaExtrasArgs): Promise<void> {
  const { attachments, sendText, sendImages, log } = args;
  if (attachments.length > 0) {
    let failed: string[];
    try {
      failed = sendImages ? await sendImages(attachments) : attachments.map(a => a.name);
    } catch (err) {
      log?.(`[media] image send failed: ${(err as Error).message}`);
      failed = attachments.map(a => a.name);
    }
    if (failed.length > 0) {
      await sendText(`Image failed to send: ${failed.join(', ')}`).catch(() => {});
    }
  }
  for (const code of findMermaidBlocks(args.originalText)) {
    const line = `Diagram preview: ${mermaidLiveUrl(code)}`;
    if (line.length > args.maxLinkLength) {
      log?.(`[media] mermaid preview link skipped (${line.length} chars)`);
      continue;
    }
    await sendText(line).catch(err => log?.(`[media] preview link failed: ${(err as Error).message}`));
  }
}
```

In `packages/gateway/src/channels/base.ts`, add to the `ChannelHandler` interface (after `sendToRoute?`):

```ts
  /** Send image files to a chat/channel id. Resolves with the names that failed. */
  sendImages?(target: string, images: FileAttachment[]): Promise<string[]>;
```

and change the import to `import { UserMessage, GatewayResponse, ChatRoute, FileAttachment } from '@codey/core';`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @codey/gateway -- channel-delivery`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/channel-delivery.ts packages/gateway/src/channel-delivery.test.ts packages/gateway/src/channels/base.ts
git commit -m "feat(gateway): deliver images and mermaid preview links to channels"
```

---

### Task 5: Telegram `sendImages`

**Files:**
- Modify: `packages/gateway/src/channels/telegram.ts` (add method after `sendToRoute`, ~line 286)
- Test: `packages/gateway/src/channels/telegram.test.ts`

- [ ] **Step 1: Write the failing test** (append to `telegram.test.ts`; add `vi` and `TelegramHandler` to the imports)

```ts
import { vi } from 'vitest';
import { TelegramHandler } from './telegram';

describe('TelegramHandler.sendImages', () => {
  const att = (name: string, mimeType: string) => ({ id: name, name, path: `/w/${name}`, mimeType, size: 1 });

  it('sends raster images as photos and svg as documents, reporting failures', async () => {
    const bot = {
      sendPhoto: vi.fn(async () => ({})),
      sendDocument: vi.fn(async () => { throw new Error('too big'); }),
    };
    const h = new TelegramHandler();
    (h as any).bot = bot;
    const failed = await h.sendImages('42', [att('a.png', 'image/png'), att('b.svg', 'image/svg+xml')]);
    expect(bot.sendPhoto).toHaveBeenCalledWith('42', '/w/a.png', {}, { filename: 'a.png', contentType: 'image/png' });
    expect(bot.sendDocument).toHaveBeenCalledWith('42', '/w/b.svg', {}, { filename: 'b.svg', contentType: 'image/svg+xml' });
    expect(failed).toEqual(['b.svg']);
  });

  it('reports everything as failed when the bot is not running', async () => {
    expect(await new TelegramHandler().sendImages('42', [att('a.png', 'image/png')])).toEqual(['a.png']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/gateway -- telegram`
Expected: FAIL — `h.sendImages is not a function`.

- [ ] **Step 3: Implement** (update the core import to include `FileAttachment`)

```ts
  async sendImages(target: string, images: FileAttachment[]): Promise<string[]> {
    if (!this.bot) return images.map(i => i.name);
    const failed: string[] = [];
    for (const img of images) {
      const fileOptions = { filename: img.name, contentType: img.mimeType };
      try {
        // Telegram cannot show SVG as a photo; send it as a file instead.
        if (img.mimeType === 'image/svg+xml') await this.bot.sendDocument(target, img.path, {}, fileOptions);
        else await this.bot.sendPhoto(target, img.path, {}, fileOptions);
      } catch {
        failed.push(img.name);
      }
    }
    return failed;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @codey/gateway -- telegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/channels/telegram.ts packages/gateway/src/channels/telegram.test.ts
git commit -m "feat(telegram): send reply images"
```

---

### Task 6: Discord `sendImages`

**Files:**
- Modify: `packages/gateway/src/channels/discord.ts` (add after `sendToRoute`)
- Create: `packages/gateway/src/channels/discord.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/channels/discord.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TextChannel } from 'discord.js';
import { DiscordHandler } from './discord';

const att = (name: string) => ({ id: name, name, path: `/w/${name}`, mimeType: 'image/png', size: 1 });

const handlerWith = (send: (arg: unknown) => Promise<unknown>) => {
  const channel = Object.create(TextChannel.prototype);
  channel.send = vi.fn(send);
  const h = new DiscordHandler();
  (h as any).client = { channels: { fetch: vi.fn(async () => channel) } };
  return { h, channel };
};

describe('DiscordHandler.sendImages', () => {
  it('sends every image in one message', async () => {
    const { h, channel } = handlerWith(async () => ({}));
    expect(await h.sendImages('c1', [att('a.png'), att('b.png')])).toEqual([]);
    expect(channel.send).toHaveBeenCalledWith({
      files: [{ attachment: '/w/a.png', name: 'a.png' }, { attachment: '/w/b.png', name: 'b.png' }],
    });
  });

  it('reports all images when the send fails', async () => {
    const { h } = handlerWith(async () => { throw new Error('413'); });
    expect(await h.sendImages('c1', [att('a.png')])).toEqual(['a.png']);
  });

  it('reports all images when the client is not running', async () => {
    expect(await new DiscordHandler().sendImages('c1', [att('a.png')])).toEqual(['a.png']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/gateway -- discord`
Expected: FAIL — `h.sendImages is not a function`.

- [ ] **Step 3: Implement** (add `FileAttachment` to the core import)

```ts
  async sendImages(target: string, images: FileAttachment[]): Promise<string[]> {
    const names = images.map(i => i.name);
    if (!this.client) return names;
    const channel = await this.client.channels.fetch(target).catch(() => null);
    if (!(channel instanceof TextChannel)) return names;
    try {
      await channel.send({ files: images.map(i => ({ attachment: i.path, name: i.name })) });
      return [];
    } catch {
      return names;
    }
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @codey/gateway -- discord`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/channels/discord.ts packages/gateway/src/channels/discord.test.ts
git commit -m "feat(discord): send reply images"
```

---

### Task 7: iMessage `sendImages`

**Files:**
- Modify: `packages/gateway/src/channels/imessage.ts` (imports + new method/helpers after `sendToRoute`)
- Create: `packages/gateway/src/channels/imessage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/channels/imessage.test.ts
import { describe, it, expect, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), execFile }));

import { IMessageHandler, buildSendFileScript } from './imessage';

describe('buildSendFileScript', () => {
  it('quotes paths and recipients for AppleScript', () => {
    expect(buildSendFileScript('a@b.c', '/w/my "chart".png'))
      .toBe('tell application "Messages" to send (POSIX file "/w/my \\"chart\\".png") to buddy "a@b.c"');
  });
});

describe('IMessageHandler.sendImages', () => {
  it('sends one file per image with execFile and reports failures', async () => {
    execFile.mockImplementation((_cmd: string, args: string[], cb: (e: Error | null) => void) => {
      cb(args[1].includes('bad.png') ? new Error('denied') : null);
    });
    const h = new IMessageHandler();
    const failed = await h.sendImages('+1555', [
      { id: '1', name: 'ok.png', path: '/w/ok.png', mimeType: 'image/png', size: 1 },
      { id: '2', name: 'bad.png', path: '/w/bad.png', mimeType: 'image/png', size: 1 },
    ]);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0][0]).toBe('osascript');
    expect(execFile.mock.calls[0][1][0]).toBe('-e');
    expect(failed).toEqual(['bad.png']);
  });
});
```

Before writing, confirm the class name: `grep -n "export class" packages/gateway/src/channels/imessage.ts`. If it is not `IMessageHandler`, use the real name in the test.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/gateway -- imessage`
Expected: FAIL — `buildSendFileScript` is not exported.

- [ ] **Step 3: Implement**

Change the import line to `import { exec, execFile } from 'child_process';` and add `FileAttachment` to the core import. Add at module level:

```ts
const appleScriptString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildSendFileScript(recipient: string, filePath: string): string {
  return `tell application "Messages" to send (POSIX file ${appleScriptString(filePath)}) to buddy ${appleScriptString(recipient)}`;
}
```

Add to the class:

```ts
  async sendImages(target: string, images: FileAttachment[]): Promise<string[]> {
    const failed: string[] = [];
    for (const img of images) {
      // execFile, not exec: the path never passes through a shell.
      const ok = await new Promise<boolean>(resolve => {
        execFile('osascript', ['-e', buildSendFileScript(target, img.path)], err => {
          if (err) console.error('[iMessage] Send file error:', err.message);
          resolve(!err);
        });
      });
      if (!ok) failed.push(img.name);
    }
    return failed;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @codey/gateway -- imessage`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/channels/imessage.ts packages/gateway/src/channels/imessage.test.ts
git commit -m "feat(imessage): send reply images"
```

---

### Task 8: Gateway — deliver attachments + preview links on every channel path

**Files:**
- Modify: `packages/gateway/src/gateway.ts` — `sendResponse` (~5926), `sendResponseWithChunking` (~5940), `fanOutToOtherRoutes` (~2774), `linkChat` summary push (~1165)
- Test: `packages/gateway/src/gateway.channel-media.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Look at how `packages/gateway/src/gateway.channel-chat.test.ts` builds a `Gateway` and registers a fake handler (copy its setup block verbatim into the new file). Then:

```ts
// packages/gateway/src/gateway.channel-media.test.ts — after the copied setup
describe('channel media delivery', () => {
  it('sends labelled text, then images, then a mermaid preview link', async () => {
    const sent: string[] = [];
    const handler = {
      name: 'telegram',
      sendMessage: vi.fn(async (r: any) => { sent.push(`msg:${r.text}`); }),
      sendImages: vi.fn(async (_t: string, imgs: any[]) => { sent.push(`img:${imgs.map(i => i.name)}`); return []; }),
    };
    (gateway as any).handlers.set('telegram', handler);
    const p = '/w/.codey/uploads/outputs/1-a-chart.png';
    await (gateway as any).sendResponse({
      chatId: '42', channel: 'telegram',
      text: `![Sales](<${p}>)\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\``,
      attachments: [{ id: '1', name: 'chart.png', path: p, mimeType: 'image/png', size: 1 }],
    });
    expect(sent[0]).toContain('msg:[Image: Sales]');
    expect(sent[1]).toBe('img:chart.png');
    expect(sent[2]).toMatch(/^msg:Diagram preview: https:\/\/mermaid\.live\/view#pako:/);
  });

  it('fan-out sends images after the last chunk', async () => {
    const sent: string[] = [];
    const handler = {
      name: 'discord',
      sendMessage: vi.fn(async () => {}),
      sendToRoute: vi.fn(async (_r: any, t: string) => { sent.push(`text:${t.length}`); }),
      sendImages: vi.fn(async () => { sent.push('img'); return []; }),
    };
    (gateway as any).handlers.set('discord', handler);
    const route = { channel: 'discord', channelUserId: 'u', channelChatId: 'c', attachedAt: 0 };
    (gateway as any).chatManager.get = () => ({ routes: [route] });
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
    await (gateway as any).fanOutToOtherRoutes('chat1', '__mac__', '', long, [
      { id: '1', name: 'a.png', path: '/w/a.png', mimeType: 'image/png', size: 1 },
    ]);
    expect(sent.filter(s => s.startsWith('text')).length).toBeGreaterThan(1);
    expect(sent[sent.length - 1]).toBe('img');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build -w @codey/core && npm test -w @codey/gateway -- gateway.channel-media`
Expected: FAIL — first message still contains `![Sales]`, no `img` call.

- [ ] **Step 3: Implement**

Add to the gateway's `@codey/core` import: `labelOutputImages`, `FileAttachment` (type). Add `import { channelMessageLimit, deliverMediaExtras } from './channel-delivery';`.

Replace `sendResponse` and the recursive call in `sendResponseWithChunking`:

```ts
  private async sendResponse(response: GatewayResponse): Promise<void> {
    const handler = this.handlers.get(response.channel);
    if (!handler) return;
    const attachments = response.attachments ?? [];
    const { attachments: _drop, ...rest } = response;
    await this.sendTextResponse({ ...rest, text: labelOutputImages(response.text, attachments) });
    await deliverMediaExtras({
      originalText: response.text,
      attachments,
      maxLinkLength: channelMessageLimit(response.channel),
      sendText: text => handler.sendMessage({ chatId: response.chatId, channel: response.channel, text }),
      sendImages: handler.sendImages ? imgs => handler.sendImages!(response.chatId, imgs) : undefined,
      log: m => this.logger.warn(m),
    });
  }

  /** Text only (chunked). Extras are added once by sendResponse. */
  private async sendTextResponse(response: GatewayResponse): Promise<void> {
    const handler = this.handlers.get(response.channel);
    if (!handler) return;

    try {
      // Auto-chunking for long messages
      if (response.text.length > this.MAX_MESSAGE_LENGTH) {
        await this.sendResponseWithChunking(response);
      } else {
        await handler.sendMessage(response);
      }
    } catch (error) {
      this.logger.error(`Error sending response: ${error}`);
    }
  }
```

In `sendResponseWithChunking`, change both `this.sendResponse(` calls to `this.sendTextResponse(`.

Change `fanOutToOtherRoutes` signature and body:

```ts
  private async fanOutToOtherRoutes(
    codeyChatId: string,
    originChannel: ChannelType,
    originUserId: string,
    text: string,
    attachments: FileAttachment[] = [],
  ): Promise<void> {
```

Right before `const chunks = …`, add `const channelText = labelOutputImages(text, attachments);` and chunk `channelText` instead of `text` (both occurrences in the `chunks` expression). After the `for (let i …)` loop inside the `try`, before the `✓ sent` log, add:

```ts
        await deliverMediaExtras({
          originalText: text,
          attachments,
          maxLinkLength: channelMessageLimit(route.channel),
          sendText: t => handler.sendToRoute!(route, t),
          sendImages: handler.sendImages ? imgs => handler.sendImages!(route.channelChatId, imgs) : undefined,
          log: m => this.logger.warn(m),
        });
```

In `linkChat` (~1167), after `await handler.sendToRoute(route, summary);` add (inside the same `try`):

```ts
          await deliverMediaExtras({
            originalText: summary,
            attachments: [],
            maxLinkLength: channelMessageLimit(channel),
            sendText: t => handler.sendToRoute!(route, t),
          });
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @codey/gateway -- gateway.channel-media gateway.channel-chat`
Expected: PASS (new tests + existing channel-chat tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/gateway.channel-media.test.ts
git commit -m "feat(gateway): send reply images and preview links on every channel path"
```

---

### Task 9: Gateway — extract images when a turn finishes

**Files:**
- Modify: `packages/gateway/src/gateway.ts` — solo channel path (~2654), `sendToChat` completion (~6810, ~7019-7106, ~7178, ~7256), `runChannelTurnViaChat` sink (~2727)
- Modify: `packages/gateway/src/bot-message-emitter.ts` (meta + `endBot`)
- Test: `packages/gateway/src/bot-message-emitter.test.ts`

- [ ] **Step 1: Write the failing emitter test** (append to `bot-message-emitter.test.ts`; reuse its existing fake store/sink helpers — read the top of the file for their names)

```ts
describe('endBot content rewrite', () => {
  it('rewrites the finished content and reports it on bot_end', () => {
    const events: any[] = [];
    const updates: any[] = [];
    const store = {
      appendMessage: () => {},
      updateMessage: (_c: string, _id: string, patch: any) => { updates.push(patch); },
    } as any;
    const emitter = new BotMessageEmitter(e => events.push(e), store, 'chat1', {
      teamTurnId: 't1', teamName: 'team', mode: 'sequential',
      rewriteContent: c => ({ content: c.replace('a.png', '/snap/a.png'), attachments: [{ id: '1', name: 'a.png', path: '/snap/a.png', mimeType: 'image/png', size: 1 }] }),
    });
    emitter.beginBot({ step: 0, bot: 'writer' } as any);
    emitter.token('![c](a.png)');
    emitter.endBot('done');
    const last = updates[updates.length - 1];
    expect(last.content).toBe('![c](/snap/a.png)');
    expect(last.attachments).toHaveLength(1);
    expect(events.find(e => e.type === 'bot_end').content).toBe('![c](/snap/a.png)');
  });
});
```

Check the real streaming method name before running: `grep -n "buf.content += token" -B6 packages/gateway/src/bot-message-emitter.ts` and use it in place of `token` if different; likewise use the real `BeginBotArgs` fields.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/gateway -- bot-message-emitter`
Expected: FAIL — `content` unchanged / `rewriteContent` ignored.

- [ ] **Step 3: Implement the emitter change**

In `bot-message-emitter.ts`, widen `meta`:

```ts
    private meta: {
      teamTurnId: string;
      teamName: string;
      mode: ChatMessage['teamMode'];
      taskId?: string;
      /** Snapshot images referenced in a finished member reply. */
      rewriteContent?: (content: string) => { content: string; attachments: FileAttachment[] };
    },
```

(import `FileAttachment` from `@codey/core` alongside `ChatMessage`). In `endBot`, before `this.store.updateMessage`:

```ts
    const media = this.meta.rewriteContent && buf.content
      ? this.meta.rewriteContent(buf.content)
      : { content: buf.content, attachments: [] as FileAttachment[] };
    const rewritten = media.content !== buf.content;
    buf.content = media.content;
```

Add `...(media.attachments.length ? { attachments: media.attachments } : {}),` to the `updateMessage` patch, and `...(rewritten ? { content: buf.content } : {})` to the `bot_end` sink event.

- [ ] **Step 4: Wire extraction in `gateway.ts`**

Add `extractOutputImages` to the `@codey/core` import.

a) Both `new BotMessageEmitter(` calls (~5172 and ~6826): add to the meta object

```ts
rewriteContent: c => { const r = extractOutputImages(c, { workingDir }); return { content: r.text, attachments: r.images }; },
```

`workingDir` is a parameter at ~5146 and a local at ~6583; confirm with `awk 'NR>=5140 && NR<=5175' packages/gateway/src/gateway.ts | grep -n workingDir` before editing.

b) `sendToChat` completion: next to `let output = '';` (~6810) add `let outputImages: FileAttachment[] = [];`. Immediately before `const assistantMessage: ChatMessage = {` (~7070) add:

```ts
      if (output) {
        const media = extractOutputImages(output, { workingDir });
        output = media.text;
        outputImages = media.images;
      }
```

Add `...(outputImages.length ? { attachments: outputImages } : {}),` to `assistantMessage`; add `...(outputImages.length ? { attachments: outputImages } : {})` to the `sink({ type: 'done', … })` call (~7178); change the fan-out (~7256) to `this.fanOutToOtherRoutes(chatId, originChannel, originUserId, output, outputImages)`. If `output`/`outputImages` are out of scope at 7256 (different block), hoist the `let outputImages` declaration to the same block as the variable used there.

c) `runChannelTurnViaChat` sink (~2727): add `attachments: ev.attachments,` to the `done` branch's `sendResponse({...})`.

d) Solo channel path (~2654): replace

```ts
    const replyText = this.formatAgentResponse(response);
```

with

```ts
    const media = extractOutputImages(this.formatAgentResponse(response), { workingDir: this.workingDir });
    const replyText = media.text;
```

and pass `attachments: media.images` to the `sendResponse({...})` right below, and `media.images` as the fifth argument to `fanOutToOtherRoutes(codeyChatId, channel, userId, replyText, media.images)`.

- [ ] **Step 5: Run gateway tests + typecheck**

Run: `npm test -w @codey/gateway && npm run build -w @codey/gateway`
Expected: all PASS, build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/bot-message-emitter.ts packages/gateway/src/bot-message-emitter.test.ts
git commit -m "feat(gateway): snapshot images when a turn or team member finishes"
```

---

### Task 10: Gateway — per-turn prompt hint + Aide image evidence

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (~2614 solo channel path; ~6681 `prompt += chatWorkspaceInstruction;`)
- Modify: `packages/gateway/src/team-finalizer.ts:83-90, 115`
- Test: `packages/gateway/src/team-finalizer.test.ts`

- [ ] **Step 1: Write the failing finalizer test** (append; follow the existing input fixtures in that file)

```ts
it('passes member images to the Aide summary as evidence', async () => {
  let seen = '';
  await buildTeamFinalMessage({
    ...baseInput, // the file's existing minimal input fixture
    messages: [{
      id: 'm1', role: 'assistant', content: 'done', timestamp: 0, teamTurnId: 't1', bot: 'writer', botStatus: 'done',
      attachments: [{ id: 'a', name: 'chart.png', path: '/w/.codey/uploads/outputs/1-x-chart.png', mimeType: 'image/png', size: 1 }],
    }],
    run: async (prompt: string) => { seen = prompt; return 'ok'; },
  });
  expect(seen).toContain('![chart.png](</w/.codey/uploads/outputs/1-x-chart.png>)');
  expect(seen).toContain('Keep Markdown image references');
});
```

Use the real exported function name and fixture name: `grep -n "^export" packages/gateway/src/team-finalizer.ts` and the top of `team-finalizer.test.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @codey/gateway -- team-finalizer`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `team-finalizer.ts`, add to `facts` after the `Result —` line:

```ts
    ...done.flatMap(m => (m.attachments ?? []).map(a => `Image — ${m.bot}: ![${a.name}](<${a.path}>)`)),
```

and append to the prompt string (after `return only the summary.`): `' Keep Markdown image references (![...](...)) from the evidence when they show results the user needs.'`

In `gateway.ts`, import `mediaOutputInstruction` from `@codey/core`. After `prompt += chatWorkspaceInstruction;` (~6681):

```ts
    prompt += mediaOutputInstruction(!!origin || (chat.routes?.length ?? 0) > 0);
```

(confirm `origin` is the `sendToChatWithMemoryTrace` parameter in scope). In the solo channel path, after the explicit-skill block (~2618, before `let prep = this.prepareAgentTurn(`):

```ts
    runPrompt += mediaOutputInstruction(true);
```

- [ ] **Step 4: Run tests**

Run: `npm test -w @codey/gateway`
Expected: PASS. If a snapshot/prompt-equality test now fails because the prompt gained the media block, update that test's expectation to include `mediaOutputInstruction(...)` (import it) rather than a literal copy.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/team-finalizer.ts packages/gateway/src/team-finalizer.test.ts
git commit -m "feat(gateway): tell agents how to show images; keep member images in the Aide summary"
```

---

### Task 11: Mac — render snapshot images inline

**Files:**
- Create: `codey-mac/src/components/markdownImage.ts`, `codey-mac/src/components/markdownImage.test.ts`
- Modify: `codey-mac/src/components/Markdown.tsx` (`components={{ … }}`, ~line 273)
- Test: `codey-mac/src/components/Markdown.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// codey-mac/src/components/markdownImage.test.ts
import { describe, expect, it } from 'vitest'
import { markdownImageSource } from './markdownImage'

describe('markdownImageSource', () => {
  it('serves Codey uploads through codey-asset', () => {
    expect(markdownImageSource('/w/.codey/uploads/outputs/1-a b.png'))
      .toEqual({ kind: 'asset', url: `codey-asset://file/${encodeURIComponent('/w/.codey/uploads/outputs/1-a b.png')}` })
  })
  it('does not auto-load remote images', () => {
    expect(markdownImageSource('https://e.com/x.png')).toEqual({ kind: 'remote', url: 'https://e.com/x.png' })
  })
  it('rejects other paths', () => {
    expect(markdownImageSource('/etc/x.png')).toEqual({ kind: 'none' })
    expect(markdownImageSource(undefined)).toEqual({ kind: 'none' })
  })
})
```

Append to `Markdown.test.ts`:

```ts
describe('Markdown images', () => {
  it('renders an upload snapshot as an img', () => {
    const html = render('![Sales](</w/.codey/uploads/outputs/1-x-chart.png>)')
    expect(html).toContain('<img')
    expect(html).toContain('codey-asset://file/')
  })
  it('renders a remote image as a link, not an img', () => {
    const html = render('![r](https://e.com/x.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://e.com/x.png"')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w codey-mac -- markdownImage Markdown.test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// codey-mac/src/components/markdownImage.ts
export type MarkdownImageSource =
  | { kind: 'asset'; url: string }
  | { kind: 'remote'; url: string }
  | { kind: 'none' }

/** Only Codey's own upload snapshots load inline; remote images could track reads. */
export const markdownImageSource = (src: string | undefined): MarkdownImageSource => {
  if (!src) return { kind: 'none' }
  if (/^https?:\/\//i.test(src)) return { kind: 'remote', url: src }
  if (src.startsWith('/') && src.includes('/.codey/uploads/')) {
    return { kind: 'asset', url: `codey-asset://file/${encodeURIComponent(src)}` }
  }
  return { kind: 'none' }
}
```

In `Markdown.tsx`, import `markdownImageSource` and add to `components`:

```tsx
          img: ({ src, alt }) => {
            const source = markdownImageSource(typeof src === 'string' ? src : undefined)
            if (source.kind === 'asset') {
              return <img src={source.url} alt={alt ?? ''} style={{ display: 'block', maxWidth: '100%', borderRadius: 6, margin: `6px 0 ${M.blockGap}px` }} />
            }
            if (source.kind === 'remote') {
              return (
                <a href={source.url} onClick={e => { e.preventDefault(); e.stopPropagation(); void openLink(source.url, e.metaKey || e.shiftKey) }}
                  style={{ color: linkColor, textDecoration: 'underline' }}>{alt || source.url}</a>
              )
            }
            return <span>{alt ? `[${alt}]` : ''}</span>
          },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w codey-mac -- markdownImage Markdown.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/markdownImage.ts codey-mac/src/components/markdownImage.test.ts codey-mac/src/components/Markdown.tsx codey-mac/src/components/Markdown.test.ts
git commit -m "feat(mac): show reply images inline"
```

---

### Task 12: Mac — render mermaid blocks

**Files:**
- Modify: `codey-mac/package.json` (dependency)
- Create: `codey-mac/src/components/MermaidBlock.tsx`
- Modify: `codey-mac/src/components/Markdown.tsx` (`pre` component, ~line 354)
- Test: `codey-mac/src/components/Markdown.test.ts`

- [ ] **Step 1: Install**

Run: `npm install mermaid -w codey-mac`
Expected: `codey-mac/package.json` gains `"mermaid"`; lockfile updated.

- [ ] **Step 2: Write the failing test** (append to `Markdown.test.ts`)

```ts
describe('Markdown mermaid', () => {
  it('server-renders the code fallback until mermaid has drawn the diagram', () => {
    const html = render('```mermaid\ngraph TD\nA-->B\n```')
    expect(html).toContain('data-mermaid-pending')
    expect(html).toContain('graph TD')
  })
  it('leaves other code blocks alone', () => {
    expect(render('```ts\nconst a = 1\n```')).not.toContain('data-mermaid-pending')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -w codey-mac -- Markdown.test`
Expected: FAIL — no `data-mermaid-pending`.

- [ ] **Step 4: Implement**

```tsx
// codey-mac/src/components/MermaidBlock.tsx
import React from 'react'

type Mermaid = typeof import('mermaid').default
let loader: Promise<Mermaid> | null = null
const loadMermaid = (): Promise<Mermaid> => (loader ??= import('mermaid').then(m => m.default))
let seq = 0

/**
 * Draws a ```mermaid block. Shows `fallback` (the normal code block) while
 * loading, while a reply is still streaming an incomplete diagram, and on any
 * parse error.
 */
export const MermaidBlock: React.FC<{ code: string; fallback: React.ReactNode }> = ({ code, fallback }) => {
  const [svg, setSvg] = React.useState<string | null>(null)
  React.useEffect(() => {
    let alive = true
    setSvg(null)
    loadMermaid()
      .then(mermaid => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
        })
        return mermaid.render(`codey-mermaid-${++seq}`, code)
      })
      .then(result => { if (alive) setSvg(result.svg) })
      .catch(() => { /* keep the code fallback */ })
    return () => { alive = false }
  }, [code])
  if (!svg) return <div data-mermaid-pending="">{fallback}</div>
  return <div style={{ overflowX: 'auto', margin: '6px 0 10px' }} dangerouslySetInnerHTML={{ __html: svg }} />
}
```

In `Markdown.tsx`, import `MermaidBlock` and change the `pre` component:

```tsx
          pre: ({ children }: any) => {
            const block = (
              <CodeBlock
                background={codeBlockBg}
                borderColor={codeBlockBorder}
                headerBackground={codeBlockHeaderBg}
                metaColor={codeBlockMeta}
                codeColor={codeBlockFg}
                blockMargin={M.blockGap}
              >
                {children}
              </CodeBlock>
            )
            const child: any = React.Children.toArray(children)[0]
            if (/language-mermaid/.test(child?.props?.className ?? '')) {
              const raw = child.props.children
              const code = (Array.isArray(raw) ? raw.join('') : String(raw ?? '')).replace(/\n$/, '')
              return <MermaidBlock code={code} fallback={block} />
            }
            return block
          },
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -w codey-mac && npx -w codey-mac tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/package.json package-lock.json codey-mac/src/components/MermaidBlock.tsx codey-mac/src/components/Markdown.tsx codey-mac/src/components/Markdown.test.ts
git commit -m "feat(mac): render mermaid diagrams"
```

---

### Task 13: Mac — pick up rewritten worker content

**Files:**
- Modify: `codey-mac/src/services/api.ts:22` (`bot_end` event type)
- Modify: `codey-mac/src/hooks/useChats.tsx` (`botEnd` action type ~98, reducer ~511, dispatch ~903)

- [ ] **Step 1: Implement** (types + plumbing; behavior is covered by the emitter test in Task 9)

`api.ts` `bot_end` union member: add `content?: string;`.

`useChats.tsx` action type `botEnd`: add `content?: string`. Reducer `case 'botEnd'`: add `...(action.content !== undefined ? { content: action.content } : {}),` inside the message spread. Dispatch at `case 'bot_end'`: add `content: ev.content,`.

- [ ] **Step 2: Typecheck + tests**

Run: `npx -w codey-mac tsc --noEmit -p tsconfig.json && npm test -w codey-mac`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/services/api.ts codey-mac/src/hooks/useChats.tsx
git commit -m "feat(mac): refresh team member content after image snapshot"
```

---

### Task 14: Full verification

- [ ] **Step 1:** `npm run build` — Expected: exit 0.
- [ ] **Step 2:** `npm test` — Expected: all workspaces PASS. Paste the summary lines.
- [ ] **Step 3:** `npm run lint` — Expected: no non-English characters flagged.
- [ ] **Step 4:** Update the spec's channel copy to the English strings used (`[Image: alt]`, `Image failed to send:`, `Diagram preview:`) and drop "click to open full size" from §2; commit `docs: align media spec with implementation`.
- [ ] **Step 5: Real-machine checks (manual, record results in the PR):**
  1. Mac-only chat: ask an agent to plot a small chart to `chart.png` → image shows inline; a mermaid flowchart renders as a diagram.
  2. Telegram-linked chat: same request → text with `[Image: …]`, then the photo; force a mermaid reply → `Diagram preview:` link opens the diagram on the phone.
  3. Discord: image arrives as an attachment.
  4. iMessage: image arrives; if Messages refuses the file, note the error (known macOS risk).
  5. `git status` in the project shows nothing under `.codey/uploads/`.
