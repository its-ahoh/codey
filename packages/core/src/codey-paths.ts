import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where Codey keeps its own state on disk.
 *
 * `CODEY_HOME` overrides the location — the gateway honours the same variable,
 * and the test setup points it at a temp dir so a suite can never write into a
 * real `~/.codey`.
 */
export function codeyHome(): string {
  return process.env.CODEY_HOME ?? path.join(os.homedir(), '.codey');
}

/** Files under `tmp/` older than this are deleted the next time it is opened. */
export const CODEY_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * `~/.codey/tmp` — scratch space for files that only matter until someone
 * looks at them: an agent's `--output-last-message` handoff, a diagnostic
 * capture, a generated config a CLI is about to read.
 *
 * Kept here rather than in `os.tmpdir()` so the files are findable when
 * something goes wrong (the system temp dir is a haystack, and macOS puts it
 * behind a per-boot random path). The trade is that nothing reaps it for us,
 * hence the age sweep below.
 *
 * Creates the directory and sweeps entries older than
 * `CODEY_TMP_MAX_AGE_MS`. Both are best effort: a full disk or a read-only
 * home should not take down the caller, which is always in the middle of doing
 * something more important than housekeeping.
 *
 * The sweep riding along here only runs when something asks for scratch space,
 * so the gateway also calls `pruneCodeyTmp` once on startup — otherwise a user
 * who stops using the agent that writes temp files keeps whatever was left.
 */
export function codeyTmpDir(): string {
  const dir = path.join(codeyHome(), 'tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    pruneCodeyTmp();
  } catch { /* best effort */ }
  return dir;
}

/** Absolute path for a scratch file, with `tmp/` created and swept. */
export function codeyTmpFile(name: string): string {
  return path.join(codeyTmpDir(), name);
}

/**
 * Delete stale entries in `~/.codey/tmp` — both files and directories.
 *
 * Directories count because the per-spawn MCP config dirs are directories, and
 * a CLI killed before its `cleanup()` runs leaves one behind. Under
 * `os.tmpdir()` the OS eventually reaped those; inside `~/.codey` nothing does,
 * so the sweep has to. A directory here is a day-old scratch dir by
 * construction — this path is only ever handed out by `codeyTmpDir`.
 */
export function pruneCodeyTmp(maxAgeMs: number = CODEY_TMP_MAX_AGE_MS): void {
  const dir = path.join(codeyHome(), 'tmp');
  const cutoff = Date.now() - maxAgeMs;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      // A directory's own mtime only moves when its listing changes, which is
      // exactly what "still in use" looks like for these — a spawn writes its
      // config once and reads it for the life of the process. Long-running
      // agents are the reason the cutoff is a day and not an hour.
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    } catch { /* raced with another process, or not ours to delete */ }
  }
}
