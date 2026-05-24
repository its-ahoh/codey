import { promises as fsp } from 'fs';

export type ControlStatus = 'running' | 'paused' | 'finalizing' | 'terminated';

export interface ControlFile {
  status: ControlStatus;
  revision: number;
  updatedAt: string;
  directive: string;
  userQuestion?: string;
  userQuestionChoices?: string[];
  resumeNote?: string;
}

export interface WriteControlOptions {
  expectedRevision?: number;
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'paused',
  'finalizing',
  'terminated',
]);

export function parseControl(text: string): ControlFile {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('control.md: missing frontmatter');
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error('control.md: unterminated frontmatter');
  }
  const fmBlock = normalized.slice(4, end);
  const afterFm = normalized.slice(end + 4).replace(/^\n/, '');

  const fm: Record<string, string> = {};
  for (const rawLine of fmBlock.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`control.md: invalid frontmatter line: ${line}`);
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }

  const status = fm.status;
  if (!status || !VALID_STATUSES.has(status)) {
    throw new Error(`control.md: invalid status: ${status}`);
  }
  if (!('revision' in fm)) {
    throw new Error('control.md: missing revision');
  }
  const revision = Number(fm.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error(`control.md: non-numeric revision: ${fm.revision}`);
  }
  const updatedAt = fm.updated_at;
  if (!updatedAt) {
    throw new Error('control.md: missing updated_at');
  }

  const sections = splitSections(afterFm);
  const directive = (sections.get('directive') ?? '').trim();
  const userQuestionBlock = sections.get('user question');
  const resumeNote = sections.get('resume note');

  const result: ControlFile = {
    status: status as ControlStatus,
    revision,
    updatedAt,
    directive,
  };

  if (userQuestionBlock !== undefined) {
    const lines = userQuestionBlock
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.length > 0);
    if (lines.length >= 2 && lines.slice(1).every((l) => l.startsWith('- '))) {
      result.userQuestion = lines[0];
      result.userQuestionChoices = lines.slice(1).map((l) => l.slice(2));
    } else {
      result.userQuestion = userQuestionBlock.trim();
    }
  }

  if (resumeNote !== undefined && resumeNote.trim().length > 0) {
    result.resumeNote = resumeNote.trim();
  }

  return result;
}

function splitSections(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = body.split('\n');
  let currentKey: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (currentKey !== null) {
      map.set(currentKey, buf.join('\n'));
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      currentKey = m[1].trim().toLowerCase();
      buf = [];
    } else if (currentKey !== null) {
      buf.push(line);
    }
  }
  flush();
  return map;
}

export function serializeControl(c: ControlFile): string {
  let out = '---\n';
  out += `status: ${c.status}\n`;
  out += `revision: ${c.revision}\n`;
  out += `updated_at: ${c.updatedAt}\n`;
  out += '---\n\n';
  out += '## Directive\n\n';
  if (c.directive.length > 0) {
    out += `${c.directive}\n`;
  }
  if (c.userQuestion !== undefined) {
    out += '\n## User Question\n\n';
    out += `${c.userQuestion}\n`;
    if (c.userQuestionChoices && c.userQuestionChoices.length > 0) {
      for (const choice of c.userQuestionChoices) {
        out += `- ${choice}\n`;
      }
    }
  }
  if (c.resumeNote !== undefined) {
    out += '\n## Resume Note\n\n';
    out += `${c.resumeNote}\n`;
  }
  return out;
}

export async function readControl(filePath: string): Promise<ControlFile | null> {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return parseControl(text);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

const writeLocks = new Map<string, Promise<unknown>>();

export async function writeControl(
  filePath: string,
  update: (prev: ControlFile) => Omit<ControlFile, 'revision' | 'updatedAt'> & {
    revision?: number;
    updatedAt?: string;
  },
  opts?: WriteControlOptions,
): Promise<ControlFile> {
  const prior = writeLocks.get(filePath) ?? Promise.resolve();
  const run = prior.then(async () => {
    const current = await readControl(filePath);
    if (!current) {
      throw new Error(`control.md: file not found at ${filePath}`);
    }
    if (opts?.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
      throw new Error(
        `control.md: stale revision (expected ${opts.expectedRevision}, on-disk ${current.revision})`,
      );
    }
    const next = update(current);
    const merged: ControlFile = {
      status: next.status,
      directive: next.directive,
      userQuestion: next.userQuestion,
      userQuestionChoices: next.userQuestionChoices,
      resumeNote: next.resumeNote,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(filePath, serializeControl(merged), 'utf8');
    return merged;
  });
  const settled = run.catch(() => undefined);
  writeLocks.set(filePath, settled);
  return run;
}
