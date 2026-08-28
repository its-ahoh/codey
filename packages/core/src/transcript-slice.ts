/**
 * Transcript slices — handing an agent exactly the history it is missing.
 *
 * The alternative is a cursor: "read lines 48-260 of this file". That works,
 * but it leaves the agent three ways to get it wrong — read the whole file,
 * miscount the range, or interpret the instruction differently per CLI. A
 * slice removes the choice: Codey cuts the range out itself and hands over a
 * small file whose entire contents are what the agent should see.
 *
 * The prompt cost is identical (one path either way), so this is really the
 * inline replay again — delivered through the filesystem instead of argv,
 * where it is not bounded by ARG_MAX.
 *
 * A slice is still only useful if the agent reads it. `buildSliceDigest`
 * covers the case where it does not: a small skeleton that rides inline, so a
 * cold start that skips the file still knows roughly what happened.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Directory name for slices, created beside the transcript being sliced. */
const SLICE_DIR = '.slices';

/** Slices older than this are swept. Generous: a slice outliving its turn is
 *  harmless, while deleting one an agent is still reading is not. */
const SLICE_TTL_MS = 60 * 60 * 1000;

/** Per-entry text budget in the digest. Enough to recognise a turn, far too
 *  little to stand in for reading the slice. */
const DIGEST_ENTRY_CHARS = 100;

/** Entries kept in the digest: a head and a tail, with the middle dropped. */
const DIGEST_HEAD_ENTRIES = 4;
const DIGEST_TAIL_ENTRIES = 6;

export interface TranscriptSlice {
  /** Absolute path of the written slice. */
  path: string;
  /** Lines it contains. */
  lines: number;
  /** A lossy inline skeleton of the same lines. */
  digest: string;
}

/** One line of a transcript sidecar, as far as slicing cares. */
interface TranscriptRow {
  role?: string;
  text?: string;
  content?: string;
  worker?: string;
  agent?: string;
}

function sliceDir(source: string): string {
  return path.join(path.dirname(source), SLICE_DIR);
}

/**
 * Remove slices left behind by turns that already finished — or by a process
 * that died mid-turn. Age-based rather than lifecycle-based on purpose: a
 * cleanup hook wired into the run would have to fire on success, failure,
 * timeout, abort and crash, and getting it wrong deletes a file the agent is
 * still reading. Superseding and ageing out cannot fail that way.
 */
export function sweepTranscriptSlices(dir: string, now = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      if (now - fs.statSync(file).mtimeMs < SLICE_TTL_MS) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch {
      // Another process may have swept it first.
    }
  }
  return removed;
}

/** Compact one transcript row for the digest. */
function digestEntry(line: string, lineNumber: number): string | undefined {
  let row: TranscriptRow;
  try {
    row = JSON.parse(line) as TranscriptRow;
  } catch {
    return undefined;
  }
  const body = (row.text ?? row.content ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return undefined;
  const who = row.worker || row.agent || row.role || 'turn';
  const clipped = body.length > DIGEST_ENTRY_CHARS
    ? `${body.slice(0, DIGEST_ENTRY_CHARS)}…`
    : body;
  return `${lineNumber} [${who}] ${clipped}`;
}

/**
 * A deliberately lossy skeleton of the sliced lines: enough to know what the
 * conversation was about, not enough to answer from. It exists so that an
 * agent which ignores the slice is merely under-informed rather than blind.
 */
export function buildSliceDigest(lines: string[], firstLine: number): string {
  const entries: string[] = [];
  lines.forEach((line, index) => {
    const entry = digestEntry(line, firstLine + index);
    if (entry) entries.push(entry);
  });
  if (entries.length === 0) return '';
  if (entries.length <= DIGEST_HEAD_ENTRIES + DIGEST_TAIL_ENTRIES) {
    return entries.join('\n');
  }
  return [
    ...entries.slice(0, DIGEST_HEAD_ENTRIES),
    `… ${entries.length - DIGEST_HEAD_ENTRIES - DIGEST_TAIL_ENTRIES} more turns omitted from this skeleton …`,
    ...entries.slice(-DIGEST_TAIL_ENTRIES),
  ].join('\n');
}

/**
 * Cut `firstLine`..`lastLine` (1-based, inclusive) out of a transcript sidecar
 * and write them to a slice beside it. Returns undefined when the source is
 * unreadable or the range is empty — callers fall back to inlining.
 *
 * The slice is named after the source, so the next turn for the same
 * conversation overwrites it instead of accumulating a new file.
 */
export function writeTranscriptSlice(
  source: string,
  firstLine: number,
  lastLine: number,
): TranscriptSlice | undefined {
  if (lastLine < firstLine || firstLine < 1) return undefined;

  let all: string[];
  try {
    all = fs.readFileSync(source, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return undefined;
  }

  const lines = all.slice(firstLine - 1, lastLine);
  if (lines.length === 0) return undefined;

  const dir = sliceDir(source);
  const target = path.join(dir, `${path.basename(source, path.extname(source))}.slice.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, lines.join('\n') + '\n');
  } catch {
    return undefined;
  }
  sweepTranscriptSlices(dir);

  return {
    path: path.resolve(target),
    lines: lines.length,
    digest: buildSliceDigest(lines, firstLine),
  };
}

/**
 * The prompt block that hands a slice over. Says "read this file" rather than
 * naming a line range: the file already is the range, so there is nothing left
 * for the agent to get wrong.
 */
export function renderSliceSection(
  slice: TranscriptSlice,
  opts: { heading: string; closing: string },
): string {
  const parts = [
    `[${opts.heading} — ${slice.lines} messages, extracted into a file for you]`,
    `File: ${slice.path}`,
    'It holds exactly those messages, one JSON object per line, oldest first, and nothing else.',
    'Read the whole file — it is small, and it is the history you are missing.',
    'It is temporary: it is rewritten on the next turn, so do not rely on it later.',
  ];
  if (slice.digest) {
    parts.push('', 'Skeleton of the same messages, in case you skip the file:', slice.digest);
  }
  parts.push('', opts.closing);
  return parts.join('\n');
}
