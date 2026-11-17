// packages/gateway/src/turn-checkpoints.ts
//
// Whole-folder snapshots taken around an agent turn, so the turn can be
// undone. A snapshot is an ordinary git commit that no branch points at: the
// folder is staged into a throwaway index (never the user's), written as a
// tree, wrapped in a commit whose parent is HEAD, and pinned under
// `refs/codey/chats/<chatId>/...` so git keeps it. The user's branch, HEAD
// and staged changes are never touched.
//
// Only used for chats running in their own worktree: in a shared checkout a
// snapshot would also hold other chats' edits, and an undo would erase them.
//
// Git-ignored files are never captured, so an undo never touches them.

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

/** Runs git in `cwd`; `env` is merged over the process environment. */
export type CheckpointGit = (args: string[], cwd: string, env?: Record<string, string>) => Promise<string>;

export const defaultCheckpointGit: CheckpointGit = (args, cwd, env) =>
  new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** A turn longer than this to snapshot runs without an undo point. */
export const CAPTURE_BUDGET_MS = 5_000;

/** Older turns' refs are deleted past this many turns per chat. */
export const MAX_TURNS_PER_CHAT = 50;

const REF_ROOT = 'refs/codey/chats';

/** Ref names may not hold every character a chat or message id could. */
const refSafe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_');

export const chatRefPrefix = (chatId: string): string => `${REF_ROOT}/${refSafe(chatId)}/`;
// Only the snapshot before a turn is kept: undo restores it, and redo uses
// the safety snapshot an undo takes. The state after a turn is never needed.
export const turnRef = (chatId: string, messageId: string, side: 'before'): string =>
  `${chatRefPrefix(chatId)}turns/${refSafe(messageId)}/${side}`;
export const undoRef = (chatId: string, stamp: number): string =>
  `${chatRefPrefix(chatId)}undo/${stamp}`;

/** Per-folder lock: capture and restore never overlap in one worktree. */
const locks = new Map<string, Promise<unknown>>();
export function withFolderLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(cwd);
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

async function headCommit(cwd: string, git: CheckpointGit): Promise<string> {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd)).trim();
  } catch {
    return ''; // no commit yet
  }
}

/** The current HEAD commit id, or '' when the repo has no commit yet. */
export const currentHead = (cwd: string, git: CheckpointGit = defaultCheckpointGit): Promise<string> =>
  headCommit(cwd, git);

export async function isGitWorkTree(cwd: string, git: CheckpointGit = defaultCheckpointGit): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true';
  } catch {
    return false;
  }
}

/** Runs `fn` with a fresh temp index file, removed afterwards. */
async function withTempIndex<T>(cwd: string, git: CheckpointGit, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const gitDir = (await git(['rev-parse', '--absolute-git-dir'], cwd)).trim();
  const indexFile = path.join(gitDir, `codey-checkpoint-index-${randomUUID()}`);
  try {
    return await fn({ GIT_INDEX_FILE: indexFile });
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
    await fs.rm(`${indexFile}.lock`, { force: true }).catch(() => undefined);
  }
}

/** Git settings for writes to a scratch index: never split it (a split
 *  scratch index could expire shared index files the real one still uses),
 *  and never ask fsmonitor, whose answers belong to the real index. */
const SCRATCH_INDEX_CONFIG = [
  '-c', 'core.splitIndex=false',
  '-c', 'splitIndex.sharedIndexExpire=never',
  '-c', 'core.fsmonitor=false',
];

/**
 * Copies the real index to `to`, keeping its modification time. Git trusts
 * an entry's saved stats only if the file changed before the index was
 * written ("racy git"): a file rewritten in the same second with the same
 * size is caught by comparing against the index file's own mtime. A copy
 * stamped "now" would hide such an edit, and the snapshot would keep the old
 * content. Resolves false when there is no real index.
 */
async function copyIndex(from: string, to: string): Promise<boolean> {
  try {
    const stat = await fs.stat(from);
    await fs.copyFile(from, to);
    await fs.utimes(to, stat.atime, stat.mtime);
    return true;
  } catch {
    await fs.rm(to, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Snapshot of the folder as it is now, as a commit id (no ref written). */
async function snapshotCommit(cwd: string, git: CheckpointGit, label: string): Promise<{ commit: string; head: string }> {
  const head = await headCommit(cwd, git);
  const commit = await withTempIndex(cwd, git, async (env) => {
    // Start from a copy of the real index: its saved file stats let `add -A`
    // skip unchanged files and hash only the changed ones. A fresh index
    // would hash every file in the repo on every snapshot (about 3x slower on
    // Codey's own repo, far worse on large ones). Without a real index (a
    // repo that has never staged anything), fall back to HEAD.
    const realIndex = path.resolve(cwd, (await git(['rev-parse', '--git-path', 'index'], cwd)).trim());
    const copied = await copyIndex(realIndex, env.GIT_INDEX_FILE);
    if (!copied && head) await git(['read-tree', head], cwd, env);
    await git([...SCRATCH_INDEX_CONFIG, '-c', 'core.safecrlf=false', 'add', '-A', '--', '.'], cwd, env);
    const tree = (await git([...SCRATCH_INDEX_CONFIG, 'write-tree'], cwd, env)).trim();
    if (!tree) throw new Error('git write-tree returned no tree');
    const args = ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `codey checkpoint ${label}`];
    const id = (await git(args, cwd, {
      ...env,
      // commit-tree needs an identity; the user may have none configured.
      GIT_AUTHOR_NAME: 'Codey', GIT_AUTHOR_EMAIL: 'codey@localhost',
      GIT_COMMITTER_NAME: 'Codey', GIT_COMMITTER_EMAIL: 'codey@localhost',
    })).trim();
    if (!id) throw new Error('git commit-tree returned no commit');
    return id;
  });
  return { commit, head };
}

/**
 * Snapshots the folder and pins it under `ref`. Returns null (never throws)
 * when the folder is not a git work tree, git fails, or the snapshot takes
 * longer than `budgetMs`: the turn then simply has no undo point.
 */
export async function captureCheckpoint(
  cwd: string,
  ref: string,
  opts: { git?: CheckpointGit; budgetMs?: number } = {},
): Promise<{ commit: string; head: string } | null> {
  const git = opts.git ?? defaultCheckpointGit;
  const budget = opts.budgetMs ?? CAPTURE_BUDGET_MS;
  const work = withFolderLock(cwd, async () => {
    if (!(await isGitWorkTree(cwd, git))) return null;
    const snap = await snapshotCommit(cwd, git, ref);
    await git(['update-ref', ref, snap.commit], cwd);
    return snap;
  }).catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budget); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True when the commit still exists in the repo. */
export async function commitExists(cwd: string, commit: string, git: CheckpointGit = defaultCheckpointGit): Promise<boolean> {
  try {
    await git(['cat-file', '-e', `${commit}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

export interface RestoreResult {
  /** Snapshot of the folder taken right before the restore (for redo). */
  safetyCommit: string;
  safetyRef: string;
  /** Paths (relative to cwd) the restore wrote or deleted. */
  changed: string[];
}

/** Removes `dir` and its parents up to (not including) `stop` while empty. */
async function pruneEmptyDirs(dir: string, stop: string): Promise<void> {
  let current = dir;
  while (current.startsWith(`${stop}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return; // not empty, or gone
    }
    current = path.dirname(current);
  }
}

/**
 * Puts the folder's non-ignored files back to how they were in `target`.
 * First pins a safety snapshot of the current state under `safetyRef`, so the
 * restore can itself be undone. Files the target lacks are deleted; files it
 * has are written back. Ignored files, the user's index and HEAD stay as they
 * are.
 */
export async function restoreCheckpoint(
  cwd: string,
  target: string,
  safetyRef: string,
  git: CheckpointGit = defaultCheckpointGit,
): Promise<RestoreResult> {
  return withFolderLock(cwd, async () => {
    const root = path.resolve(cwd);
    const safety = await snapshotCommit(cwd, git, safetyRef);
    await git(['update-ref', safetyRef, safety.commit], cwd);

    const out = await git(['diff', '--name-status', '-z', '--no-renames', '--relative', target, safety.commit], cwd);
    const parts = out.split('\0').filter(Boolean);
    const toDelete: string[] = [];
    const toWrite: string[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i];
      const file = parts[i + 1];
      if (status === 'A') toDelete.push(file); // only in the current state
      else toWrite.push(file); // M, D, T: take the target's copy
    }

    for (const rel of toDelete) {
      const abs = path.join(root, rel);
      await fs.rm(abs, { force: true });
      await pruneEmptyDirs(path.dirname(abs), root);
    }
    if (toWrite.length) {
      await withTempIndex(cwd, git, async (env) => {
        await git([...SCRATCH_INDEX_CONFIG, 'read-tree', target], cwd, env);
        // A path that is now a directory (or the reverse) must be cleared
        // before checkout-index can write it.
        for (const rel of toWrite) {
          const abs = path.join(root, rel);
          const stat = await fs.lstat(abs).catch(() => null);
          if (stat?.isDirectory()) await fs.rm(abs, { recursive: true, force: true });
        }
        // checkout-index takes paths relative to cwd, one per call batch.
        const batch = 200;
        for (let i = 0; i < toWrite.length; i += batch) {
          await git([...SCRATCH_INDEX_CONFIG, 'checkout-index', '-f', '--', ...toWrite.slice(i, i + batch)], cwd, env);
        }
      });
    }
    return { safetyCommit: safety.commit, safetyRef, changed: [...toWrite, ...toDelete].sort() };
  });
}

/** Number of non-ignored files that differ between `target` and the folder now. */
export async function countChangedFiles(cwd: string, target: string, git: CheckpointGit = defaultCheckpointGit): Promise<number> {
  return withFolderLock(cwd, async () => {
    const now = await snapshotCommit(cwd, git, 'preview');
    const out = await git(['diff', '--name-only', '-z', '--no-renames', '--relative', target, now.commit], cwd);
    return out.split('\0').filter(Boolean).length;
  });
}

/** Deletes refs under the chat's prefix. With `keep`, refs whose path holds
 *  any of those ids are left alone. */
export async function deleteChatRefs(
  cwd: string,
  chatId: string,
  opts: { keepMessageIds?: string[]; git?: CheckpointGit } = {},
): Promise<number> {
  const git = opts.git ?? defaultCheckpointGit;
  let refs: string[];
  try {
    refs = (await git(['for-each-ref', '--format=%(refname)', chatRefPrefix(chatId)], cwd))
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return 0;
  }
  const keep = new Set((opts.keepMessageIds ?? []).map(refSafe));
  const doomed = opts.keepMessageIds
    ? refs.filter(r => {
        const m = /\/turns\/([^/]+)\//.exec(r);
        return m ? !keep.has(m[1]) : false; // undo/ safety refs: see pruneUndoRefs
      })
    : refs;
  await deleteRefs(cwd, doomed, git);
  return doomed.length;
}

async function deleteRefs(cwd: string, refs: string[], git: CheckpointGit): Promise<void> {
  if (!refs.length) return;
  const stdin = refs.map(r => `delete ${r}\n`).join('');
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', ['update-ref', '--stdin'], { cwd }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(stdin);
  }).catch(async () => {
    for (const r of refs) await git(['update-ref', '-d', r], cwd).catch(() => undefined);
  });
}

/**
 * Deletes the chat's `undo/` safety refs whose snapshot is not in
 * `keepCommits`. A safety snapshot is only needed while its undo can still be
 * redone; without this every undo and redo would pin a whole-folder snapshot
 * until the chat is deleted. Best effort: returns 0 when git fails.
 */
export async function pruneUndoRefs(
  cwd: string,
  chatId: string,
  keepCommits: string[],
  git: CheckpointGit = defaultCheckpointGit,
): Promise<number> {
  try {
    const keep = new Set(keepCommits);
    const doomed = (await git(['for-each-ref', '--format=%(refname) %(objectname)', `${chatRefPrefix(chatId)}undo/`], cwd))
      .split('\n').map(line => line.trim().split(' ')).filter(([ref, commit]) => ref && !keep.has(commit)).map(([ref]) => ref);
    await deleteRefs(cwd, doomed, git);
    return doomed.length;
  } catch {
    return 0;
  }
}
