// packages/gateway/src/turn-files-undo.ts
//
// Undo and redo for chats on the shared checkout, from the per-turn ledger
// (`ChatMessage.turnFiles`). A worktree chat restores a whole-folder
// snapshot instead (turn-checkpoints.ts); a shared checkout cannot, because
// the folder also holds other chats' and the user's own edits. So only the
// paths a turn wrote are put back, and only when nobody touched them since:
// a path whose content is no longer what the turn left is a conflict, and the
// whole undo is refused rather than half-applied.
//
// The ledger's blobs are loose objects. `pinTurnFiles` hangs them off a ref so
// `git gc` keeps them for as long as the turn can still be undone.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { TurnFileEntry } from '@codey/core';
import { chatRefPrefix, type CheckpointGit, defaultCheckpointGit } from './turn-checkpoints';
import { EMPTY_BLOB } from './write-diff-recorder';

/** Ref that keeps a turn's ledger blobs alive. */
export const turnFilesRef = (chatId: string, messageId: string): string =>
  `${chatRefPrefix(chatId)}files/${messageId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** The repository a working directory belongs to. */
export async function repoRootOf(cwd: string, git: CheckpointGit = defaultCheckpointGit): Promise<string> {
  return (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
}

/**
 * Pins every blob in `entries` under `ref`: a parentless commit whose tree
 * lists them. Best effort — a turn without a pin can still be undone until gc
 * prunes its blobs, and the undo then says the content is gone.
 */
export async function pinTurnFiles(
  cwd: string,
  ref: string,
  entries: TurnFileEntry[],
  git: CheckpointGit = defaultCheckpointGit,
): Promise<boolean> {
  const blobs = [...new Set(entries.flatMap(e => [e.before, e.after]).filter((b): b is string => !!b))];
  if (!blobs.length) return false;
  try {
    const listing = blobs.map((b, i) => `100644 blob ${b}\t${i}`).join('\n') + '\n';
    const tree = (await gitWithInput(cwd, ['mktree'], listing)).trim();
    const commit = (await git(['commit-tree', tree, '-m', 'codey turn files'], cwd, {
      GIT_AUTHOR_NAME: 'Codey', GIT_AUTHOR_EMAIL: 'codey@localhost',
      GIT_COMMITTER_NAME: 'Codey', GIT_COMMITTER_EMAIL: 'codey@localhost',
    })).trim();
    await git(['update-ref', ref, commit], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Deletes the pins of turns that can no longer be undone. Best effort. */
export async function unpinTurnFiles(cwd: string, refs: string[], git: CheckpointGit = defaultCheckpointGit): Promise<void> {
  for (const ref of refs) await git(['update-ref', '-d', ref], cwd).catch(() => undefined);
}

/**
 * One entry per path across several turns (oldest first): the `before` of
 * the first turn that wrote it, the `after` of the last. A path whose first
 * write had no exact before keeps `before` unset.
 */
export function combineTurnFiles(turns: TurnFileEntry[][]): TurnFileEntry[] {
  const map = new Map<string, TurnFileEntry>();
  for (const turn of turns) {
    for (const e of turn) {
      const existing = map.get(e.path);
      if (existing) existing.after = e.after;
      else map.set(e.path, { ...e });
    }
  }
  return [...map.values()];
}

/** Blob id of a file's current content; the empty blob when it is gone. */
async function currentBlob(cwd: string, absPath: string, git: CheckpointGit): Promise<string> {
  try {
    await fs.access(absPath);
  } catch {
    return EMPTY_BLOB;
  }
  return (await git(['hash-object', '--', absPath], cwd)).trim();
}

async function blobExists(cwd: string, blob: string, git: CheckpointGit): Promise<boolean> {
  if (blob === EMPTY_BLOB) return true;
  try {
    await git(['cat-file', '-e', blob], cwd);
    return true;
  } catch {
    return false;
  }
}

export interface FileRestorePlan {
  files: TurnFileEntry[];
  /** Paths whose pre-turn content was never known for sure. */
  unknown: string[];
  /** Paths changed since the turn (by the user, another chat, a commit). */
  conflicts: string[];
  /** Paths whose stored content git no longer has. */
  missing: string[];
}

/**
 * Checks that every path is still exactly as the undo (or redo) expects:
 * `after` for an undo, `before` for a redo. Nothing is written.
 */
export async function planFileRestore(
  cwd: string,
  files: TurnFileEntry[],
  direction: 'undo' | 'redo',
  git: CheckpointGit = defaultCheckpointGit,
): Promise<FileRestorePlan> {
  const plan: FileRestorePlan = { files, unknown: [], conflicts: [], missing: [] };
  for (const f of files) {
    if (!f.before) { plan.unknown.push(f.path); continue; }
    const expected = direction === 'undo' ? f.after : f.before;
    const target = direction === 'undo' ? f.before : f.after;
    if (await currentBlob(cwd, f.path, git) !== expected) plan.conflicts.push(f.path);
    else if (!(await blobExists(cwd, target, git))) plan.missing.push(f.path);
  }
  return plan;
}

/** Why a plan cannot be applied, in words for the user; null when it can. */
export function planBlocker(plan: FileRestorePlan, cwd: string, direction: 'undo' | 'redo'): string | null {
  const list = (paths: string[]) => {
    const names = paths.slice(0, 5).map(p => path.relative(cwd, p) || p);
    return names.join(', ') + (paths.length > 5 ? ` and ${paths.length - 5} more` : '');
  };
  if (plan.unknown.length) {
    return `Codey does not know for sure what these files held before, so it will not overwrite them: ${list(plan.unknown)}.`;
  }
  if (plan.conflicts.length) {
    return direction === 'undo'
      ? `These files changed after the agent edited them (by you, another chat, or a commit), so undo would overwrite that work: ${list(plan.conflicts)}.`
      : `These files changed after the undo, so redo would overwrite that work: ${list(plan.conflicts)}.`;
  }
  if (plan.missing.length) return `The saved copies of these files are gone: ${list(plan.missing)}.`;
  return null;
}

/** Writes each path back to `before` (undo) or `after` (redo). The empty blob
 *  means the file did not exist, so it is deleted. */
export async function applyFileRestore(
  cwd: string,
  files: TurnFileEntry[],
  direction: 'undo' | 'redo',
): Promise<void> {
  for (const f of files) {
    const target = direction === 'undo' ? f.before! : f.after;
    if (target === EMPTY_BLOB) {
      await fs.rm(f.path, { force: true });
      continue;
    }
    const content = await readBlob(cwd, target);
    await fs.mkdir(path.dirname(f.path), { recursive: true });
    await fs.writeFile(f.path, content);
  }
}

function readBlob(cwd: string, blob: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['cat-file', 'blob', blob], { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout as Buffer)));
  });
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    child.stdin?.end(input);
  });
}
