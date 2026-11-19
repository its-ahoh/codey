// packages/gateway/src/write-diff-recorder.ts
//
// Records what a single tool call changed in each file it wrote.
//
// A shell command or a codex `file_change` leaves no diff behind — only the
// fact that a path changed (see shell-write-tracker.ts). Diffing the working
// tree against HEAD later shows *everything* since the last commit, so a
// turn's edits were indistinguishable from every earlier turn's. This module
// captures the file the moment the call ends and diffs it against the file
// as the previous call left it.
//
// Git does the storing: `hash-object -w` puts the file's content in the
// repo's object database (the same thing `git add` does), and `git diff
// <blob> <blob>` compares two stored contents. Only the blob ids and the
// patch text go into the chat, so the baseline survives a gateway restart —
// the next write to a path diffs against the blob its last write recorded.
// A blob that git has since pruned falls back to HEAD's copy of the file.
//
// The recorder also keeps the turn's undo ledger (`turnFiles`): per path, the
// content before the turn's first write and after its last. Callers should
// `primeBefore` on tool_start so that "before" is what was on disk (not HEAD,
// which misses uncommitted edits). The WriteDiffs stay display-only.

import { promises as fs } from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import type { TurnFileEntry, WriteDiff } from '@codey/core';
import type { GitRunner } from './shell-write-tracker';

/** Resolves symlinks so a path can be matched against git's repo root, which
 *  git always reports resolved (`/tmp` → `/private/tmp` on macOS). A path that
 *  cannot be resolved (deleted, or a fake in tests) is used as given. */
export type RealpathRunner = (p: string) => Promise<string>;
export const defaultRealpath: RealpathRunner = async (p) => {
  try { return await fs.realpath(p); } catch { return p; }
};

/** Patches past this size are dropped and counted only: the chat file is
 *  read on every open, and a generated bundle's diff is not worth reading. */
export const MAX_PATCH_CHARS = 64 * 1024;

/** Git's id for empty content. `hash-object -w /dev/null` guarantees it exists. */
export const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** Counts +/- lines of a unified diff, ignoring the file header. */
export const countPatchLines = (patch: string): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
};

/**
 * Blob each path was last left at, from a chat's saved tool calls. Later
 * writes win, so the map holds the newest state of every file the chat wrote.
 */
export const priorBlobs = (
  messages: Array<{ toolCalls?: Array<{ writeDiffs?: WriteDiff[] }> }>,
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      for (const d of tc.writeDiffs ?? []) out.set(d.path, d.blob);
    }
  }
  return out;
};

/**
 * Fold a later ledger onto an earlier one (a stopped turn's files onto the
 * turn that follows it): per path, the earlier `before` and the later `after`.
 */
export const mergeTurnFiles = (earlier: TurnFileEntry[], later: TurnFileEntry[]): TurnFileEntry[] => {
  const map = new Map<string, TurnFileEntry>(earlier.map(e => [e.path, { ...e }]));
  for (const e of later) {
    const existing = map.get(e.path);
    if (existing) existing.after = e.after;
    else map.set(e.path, { ...e });
  }
  return [...map.values()];
};

export class WriteDiffRecorder {
  private disabled = false;
  private repoRoot: string | null = null;
  /** Path → on-disk blob hashed on the pending call's tool_start. Consumed by
   *  that call's record(), so each call still diffs only its own change. */
  private readonly primed = new Map<string, string>();
  /** The turn's undo ledger, in first-write order. */
  private readonly ledger = new Map<string, TurnFileEntry>();

  constructor(
    private readonly workingDir: string,
    private readonly git: GitRunner,
    /** Path → blob of its last recorded write. Updated as calls are recorded. */
    private readonly lastBlob: Map<string, string> = new Map(),
    private readonly realpath: RealpathRunner = defaultRealpath,
  ) {}

  /** Repo-relative form of `absPath`, or null when it lies outside the repo. */
  private async relativeTo(root: string, absPath: string): Promise<string | null> {
    const candidates = [absPath, await this.realpath(absPath)];
    // A deleted file cannot be resolved itself, but its directory can.
    const slash = absPath.lastIndexOf('/');
    if (slash > 0) candidates.push(`${await this.realpath(absPath.slice(0, slash))}${absPath.slice(slash)}`);
    for (const c of candidates) {
      if (c.startsWith(`${root}/`)) return c.slice(root.length + 1);
    }
    return null;
  }

  private async resolveRepoRoot(): Promise<string | null> {
    if (this.repoRoot) return this.repoRoot;
    try {
      const root = (await this.git(['rev-parse', '--show-toplevel'], this.workingDir)).trim();
      if (!root) { this.disabled = true; return null; }
      this.repoRoot = root;
      return root;
    } catch {
      this.disabled = true;
      return null;
    }
  }

  private async blobExists(blob: string): Promise<boolean> {
    try {
      await this.git(['cat-file', '-e', blob], this.workingDir);
      return true;
    } catch {
      return false;
    }
  }

  /** Stores the file's current content and returns its blob; the empty blob
   *  when the file is gone (deleted or not yet created). */
  private async hashPath(absPath: string): Promise<string> {
    try {
      const id = (await this.git(['hash-object', '-w', '--', absPath], this.workingDir)).trim();
      if (id) return id;
    } catch { /* deleted, unreadable, or outside the repo */ }
    await this.git(['hash-object', '-w', '/dev/null'], this.workingDir);
    return EMPTY_BLOB;
  }

  /**
   * Hash on-disk content for paths about to be written. Call on tool_start.
   * Per call, not per turn: the turn's pre-state is the first call's `before`,
   * which `aggregateTurnFiles` keeps.
   */
  async primeBefore(paths: string[]): Promise<void> {
    if (this.disabled || paths.length === 0) return;
    const root = await this.resolveRepoRoot();
    if (!root) return;
    try {
      for (const path of paths) {
        // Outside the repo: still hash so a write there can be ledgered; the
        // relative check in record() will name it by absolute path.
        this.primed.set(path, await this.hashPath(path));
      }
    } catch {
      this.disabled = true;
    }
  }

  /**
   * Set a path's "before" from content the agent reported, rather than from
   * disk. Call on tool_end, before `record`: a tool_start snapshot races the
   * agent's own write (Claude writes the file the moment it emits the call),
   * so the agent's echo of the original is the reliable one. `null` = the
   * call created the file.
   */
  async primeContent(absPath: string, content: string | null): Promise<void> {
    if (this.disabled) return;
    const root = await this.resolveRepoRoot();
    if (!root) return;
    if (content === null) {
      try {
        await this.git(['hash-object', '-w', '/dev/null'], this.workingDir);
        this.primed.set(absPath, EMPTY_BLOB);
      } catch { /* leave the tool_start prime in place */ }
      return;
    }
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'codey-before-'));
    const tmp = nodePath.join(dir, 'content');
    try {
      await fs.writeFile(tmp, content);
      const id = (await this.git(['hash-object', '-w', '--', tmp], this.workingDir)).trim();
      if (id) this.primed.set(absPath, id);
    } catch {
      /* leave the tool_start prime in place */
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The committed copy of `rel`, else the empty blob (a new file). */
  private async headBlob(rel: string | null): Promise<string> {
    if (rel) {
      try {
        const id = (await this.git(['rev-parse', '--verify', '--quiet', `HEAD:${rel}`], this.workingDir)).trim();
        if (id) return id;
      } catch { /* not in HEAD: a new file */ }
    }
    return EMPTY_BLOB;
  }

  /**
   * The file's content before this call, and whether that is known to be what
   * was on disk. Exact: a tool_start prime, or HEAD for a path the caller saw
   * clean at the start. Otherwise a guess — the last recorded write (which a
   * commit, checkout, or hand edit since may have made stale), else HEAD. A
   * guess is fine for showing a diff but not for restoring a file.
   */
  private async beforeBlob(absPath: string, rel: string | null, cleanAtStart: boolean): Promise<{ blob: string; exact: boolean }> {
    const primed = this.primed.get(absPath);
    if (primed && await this.blobExists(primed)) return { blob: primed, exact: true };
    if (cleanAtStart) return { blob: await this.headBlob(rel), exact: true };
    const remembered = this.lastBlob.get(absPath);
    if (remembered && await this.blobExists(remembered)) return { blob: remembered, exact: false };
    return { blob: await this.headBlob(rel), exact: false };
  }

  /**
   * Diffs of what the just-finished call did to `paths` (absolute). A path
   * whose content is unchanged is left out. Best-effort: any git failure
   * disables the recorder for the rest of the turn.
   *
   * `cleanAtStart`: every path not primed was unmodified (matched HEAD, or did
   * not exist) when the call began — true for the shell tracker, whose dirty
   * paths are all primed. The ledger only takes a `before` that is exact.
   */
  async record(paths: string[], opts: { cleanAtStart?: boolean } = {}): Promise<WriteDiff[]> {
    if (this.disabled || paths.length === 0) return [];
    const root = await this.resolveRepoRoot();
    if (!root) return [];
    const out: WriteDiff[] = [];
    try {
      for (const path of paths) {
        const rel = await this.relativeTo(root, path);
        const { blob: before, exact } = await this.beforeBlob(path, rel, !!opts.cleanAtStart);
        if (before === EMPTY_BLOB) await this.git(['hash-object', '-w', '/dev/null'], this.workingDir);
        const after = await this.hashPath(path);
        this.primed.delete(path);
        this.lastBlob.set(path, after);
        if (before === after) continue;
        const ledgered = this.ledger.get(path);
        if (ledgered) ledgered.after = after;
        else this.ledger.set(path, { path, ...(exact ? { before } : {}), after });
        const name = rel ?? path.replace(/^\/+/, '');
        const raw = await this.git(['diff', '--no-color', before, after], this.workingDir);
        // Git names the sides by blob id; name them by the file instead so the
        // patch reads like any other.
        const patch = raw
          .replace(`diff --git a/${before} b/${after}`, `diff --git a/${name} b/${name}`)
          .replace(`--- a/${before}`, `--- a/${name}`)
          .replace(`+++ b/${after}`, `+++ b/${name}`);
        const binary = /^Binary files .* differ$/m.test(raw) && !raw.includes('@@');
        const counts = binary ? { added: 0, removed: 0 } : countPatchLines(patch);
        const entry: WriteDiff = { path, ...counts, blob: after };
        if (!binary) {
          if (patch.length > MAX_PATCH_CHARS) entry.truncated = true;
          else entry.patch = patch;
        }
        out.push(entry);
      }
    } catch {
      this.disabled = true;
    }
    return out;
  }

  /**
   * The turn so far, one entry per path: the content before its first write
   * and after its last. No `before` = the first write's starting content was
   * a guess, so that path must not be restored. A path written and then put
   * back is still listed (before === after).
   */
  turnFiles(): TurnFileEntry[] {
    return [...this.ledger.values()].map(e => ({ ...e }));
  }
}
