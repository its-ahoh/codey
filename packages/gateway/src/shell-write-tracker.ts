// packages/gateway/src/shell-write-tracker.ts
//
// Works out which files a shell command actually wrote.
//
// Parsing the command text alone (see codey-mac's shellWrites.ts) only catches
// writes the *shell* performs — `>`, `sed -i`, `cp`. It cannot see a write that
// happens inside an interpreter: `python3 - <<'PY' … open(p,'w') … PY`,
// `node -e`, `git apply`, a Makefile. Those are how agents rewrite files just as
// often, and the Files panel reported nothing for them.
//
// So: git answers *what actually changed* (it sees every writer, whatever the
// language), and the command text answers *whether this command did it*. A
// shared checkout can have several chats editing at once, and a plain
// before/after git diff would blame this command for every one of their edits —
// including the hundreds of phantom paths another session's branch switch
// produces. Requiring the path to also appear in the command text keeps that
// noise out.
//
// The trade: a path the command computes rather than names (`for f in $(ls)`)
// is missed. Silence is the right failure here — a panel that invents file
// changes stops being worth reading.

/** Runs a git subcommand in `cwd` and resolves its stdout. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>
/** Size + mtime of a file, or null when it is gone/unreadable. */
export type StatRunner = (absPath: string) => Promise<{ size: number; mtimeMs: number } | null>

/** Path → stamp for every file git currently reports as dirty. */
export type Snapshot = Map<string, string>

/** Beyond this many dirty files the working tree is not in a state worth
 *  sampling (a branch switch mid-run, a fresh clone) — stat'ing them all would
 *  cost more than the answer is worth. */
const MAX_DIRTY_FILES = 400

/** Un-escapes the C-style quoting git applies to paths with odd bytes. */
const unquotePath = (raw: string): string => {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw
  const body = raw.slice(1, -1)
  return body.replace(/\\([\\"nt]|[0-7]{3})/g, (_, esc: string) => {
    if (esc === '\\') return '\\'
    if (esc === '"') return '"'
    if (esc === 'n') return '\n'
    if (esc === 't') return '\t'
    return String.fromCharCode(parseInt(esc, 8))
  })
}

/**
 * Repo-relative paths from `git status --porcelain` output. For a rename only
 * the destination is reported — that is the path that now holds the content.
 */
export const parsePorcelainPaths = (stdout: string): string[] => {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue
    const rest = line.slice(3)
    // `R  old -> new` (also C for copies). The arrow is outside any quoting.
    const arrow = rest.indexOf(' -> ')
    const raw = arrow >= 0 ? rest.slice(arrow + 4) : rest
    const path = unquotePath(raw.trim())
    if (path) out.push(path)
  }
  return out
}

/**
 * Paths whose content plausibly changed between two snapshots.
 *
 * A file that was already dirty and got edited again keeps the same porcelain
 * status, so the dirty *set* alone would miss it — the size+mtime stamp is what
 * catches that case.
 */
export const changedBetween = (before: Snapshot, after: Snapshot): string[] => {
  const out: string[] = []
  for (const [path, stamp] of after) {
    if (before.get(path) !== stamp) out.push(path)
  }
  // A path that left the dirty set was reverted to its committed content —
  // still a change this command may have made.
  for (const path of before.keys()) {
    if (!after.has(path)) out.push(path)
  }
  return out
}

/**
 * Of `changedPaths` (repo-relative), the ones this command names.
 *
 * A command may refer to a file by its repo-relative path, its path relative to
 * the working directory, an absolute path, or — after a `cd` — a bare basename.
 * All four count: the path already had to *actually change* to get here, so the
 * mention only has to be good enough to separate this command's work from a
 * concurrent chat's.
 */
export const mentionedPaths = (
  command: string,
  changedPaths: string[],
  repoRoot: string,
  workingDir: string,
): string[] => {
  if (!command) return []
  const prefix = workingDir.startsWith(repoRoot)
    ? workingDir.slice(repoRoot.length).replace(/^\//, '')
    : ''
  const out: string[] = []
  for (const rel of changedPaths) {
    const candidates = [rel, `${repoRoot}/${rel}`, rel.split('/').pop() ?? rel]
    if (prefix && rel.startsWith(`${prefix}/`)) candidates.push(rel.slice(prefix.length + 1))
    if (candidates.some(c => c && command.includes(c))) out.push(rel)
  }
  return out
}

/**
 * Samples the working tree around each shell command in a turn.
 *
 * One tracker per turn. `noteStart` is called when a shell tool call begins and
 * `noteEnd` when it finishes; everything is best-effort, and any failure (not a
 * git repo, git too slow, a working tree in an unusable state) permanently
 * disables the tracker for the turn rather than retrying on every command.
 */
export class ShellWriteTracker {
  private disabled = false
  private repoRoot: string | null = null
  private before: Snapshot = new Map()
  private command = ''

  constructor(
    private readonly workingDir: string,
    private readonly git: GitRunner,
    private readonly stat: StatRunner,
  ) {}

  private async resolveRepoRoot(): Promise<string | null> {
    if (this.repoRoot) return this.repoRoot
    try {
      const root = (await this.git(['rev-parse', '--show-toplevel'], this.workingDir)).trim()
      if (!root) { this.disabled = true; return null }
      this.repoRoot = root
      return root
    } catch {
      this.disabled = true
      return null
    }
  }

  private async snapshot(): Promise<Snapshot> {
    const root = await this.resolveRepoRoot()
    if (!root) return new Map()
    const stdout = await this.git(['status', '--porcelain'], this.workingDir)
    const paths = parsePorcelainPaths(stdout)
    if (paths.length > MAX_DIRTY_FILES) {
      this.disabled = true
      return new Map()
    }
    const snap: Snapshot = new Map()
    await Promise.all(paths.map(async rel => {
      const s = await this.stat(`${root}/${rel}`)
      snap.set(rel, s ? `${s.size}:${s.mtimeMs}` : 'gone')
    }))
    return snap
  }

  /** Records the command about to run and samples the tree it will act on. */
  async noteStart(command: string): Promise<void> {
    this.command = command
    if (this.disabled) return
    try {
      this.before = await this.snapshot()
    } catch {
      this.disabled = true
    }
  }

  /** Absolute paths the just-finished command wrote, newest sample retained so
   *  a following command compares against the tree this one left behind. */
  async noteEnd(): Promise<string[]> {
    if (this.disabled) return []
    try {
      const after = await this.snapshot()
      const root = this.repoRoot
      if (this.disabled || !root) return []
      const changed = changedBetween(this.before, after)
      this.before = after
      return mentionedPaths(this.command, changed, root, this.workingDir)
        .map(rel => `${root}/${rel}`)
    } catch {
      this.disabled = true
      return []
    }
  }
}

/** Shell tool names across the adapters we drive. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'shell_command', 'local_shell_call', 'exec', 'command_execution']);

export const isShellTool = (tool?: string): boolean => !!tool && SHELL_TOOLS.has(tool.toLowerCase());

/** Command text as the adapters report it: a string, or codex's argv array. */
export const shellCommandText = (input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>;
  const raw = i.command ?? i.cmd ?? i.script;
  if (Array.isArray(raw)) return raw.map(v => String(v)).join(' ');
  return typeof raw === 'string' ? raw : '';
};

/** Production runners. The timeout is short on purpose: sampling runs between
 *  the agent's tool calls, so a slow answer is worse than no answer — a timeout
 *  throws, which disables the tracker for the rest of the turn. */
export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const { stdout } = await promisify(execFile)('git', args, { cwd, timeout: 2_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

export const defaultStatRunner: StatRunner = async (absPath) => {
  const fs = await import('fs/promises');
  try {
    const s = await fs.stat(absPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
};

/** Codex reports its own edits as a `file_change` item. */
export const isFileChangeTool = (tool?: string): boolean => tool?.toLowerCase() === 'file_change';

/**
 * Absolute paths a codex `file_change` item touched. Its output is a list of
 * `{ path, kind }`, as an array from the adapter or as the JSON string the
 * tool tracker turns it into. Relative paths resolve against `workingDir`.
 */
export const fileChangePaths = (output: unknown, workingDir: string): string[] => {
  let list: unknown = output;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const raw = typeof item === 'string' ? item : (item as { path?: unknown } | null)?.path;
    if (typeof raw !== 'string' || !raw) continue;
    const abs = raw.startsWith('/') ? raw : `${workingDir.replace(/\/$/, '')}/${raw.replace(/^\.\//, '')}`;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
};
