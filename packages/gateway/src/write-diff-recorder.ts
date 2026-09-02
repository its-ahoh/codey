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

import { promises as fs } from 'fs';
import type { WriteDiff } from '@codey/core';
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
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

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

export class WriteDiffRecorder {
  private disabled = false;
  private repoRoot: string | null = null;

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

  /** The file's content before this call: its last recorded write, else the
   *  committed copy, else nothing (a file this chat created). */
  private async beforeBlob(absPath: string, rel: string | null): Promise<string> {
    const remembered = this.lastBlob.get(absPath);
    if (remembered && await this.blobExists(remembered)) return remembered;
    if (rel) {
      try {
        const id = (await this.git(['rev-parse', '--verify', '--quiet', `HEAD:${rel}`], this.workingDir)).trim();
        if (id) return id;
      } catch { /* not in HEAD: a new file */ }
    }
    return EMPTY_BLOB;
  }

  /** Stores the file's current content and returns its blob; the empty blob
   *  when the file is gone (deleted by the call). */
  private async afterBlob(absPath: string): Promise<string> {
    try {
      const id = (await this.git(['hash-object', '-w', '--', absPath], this.workingDir)).trim();
      if (id) return id;
    } catch { /* deleted, unreadable, or outside the repo */ }
    await this.git(['hash-object', '-w', '/dev/null'], this.workingDir);
    return EMPTY_BLOB;
  }

  /**
   * Diffs of what the just-finished call did to `paths` (absolute). A path
   * whose content is unchanged is left out. Best-effort: any git failure
   * disables the recorder for the rest of the turn.
   */
  async record(paths: string[]): Promise<WriteDiff[]> {
    if (this.disabled || paths.length === 0) return [];
    const root = await this.resolveRepoRoot();
    if (!root) return [];
    const out: WriteDiff[] = [];
    try {
      for (const path of paths) {
        const rel = await this.relativeTo(root, path);
        const before = await this.beforeBlob(path, rel);
        if (before === EMPTY_BLOB) await this.git(['hash-object', '-w', '/dev/null'], this.workingDir);
        const after = await this.afterBlob(path);
        this.lastBlob.set(path, after);
        if (before === after) continue;
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
}
