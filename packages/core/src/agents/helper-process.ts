// packages/core/src/agents/helper-process.ts
//
// Short-lived helper processes: start an agent CLI in a long-running mode,
// ask it one thing, and close it. Shared by the session rewinds
// (`codex-revert.ts`, `session-fork.ts`) so the start, deadline and kill
// rules live in one place.

import { spawn, type ChildProcess } from 'child_process';

export interface HelperOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The process environment with the usual CLI install folders on PATH. */
export const helperEnv = (): NodeJS.ProcessEnv => {
  const { withCommonBinPaths } = require('./env') as typeof import('./env');
  return withCommonBinPaths({ ...process.env });
};

/** Kills the helper and anything it started: it runs in its own process
 *  group, and some CLIs (`opencode serve`) ignore SIGTERM. */
function killHelper(child: ChildProcess): void {
  try { child.stdin?.end(); } catch { /* already closed */ }
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Runs `work` against a freshly started helper, with a deadline. Resolves
 * null (never rejects) when the helper cannot start, exits early, times out,
 * or `work` throws. The helper is always killed before this resolves.
 */
export function withHelper<T>(
  command: string,
  args: string[],
  opts: HelperOptions,
  work: (child: ChildProcess) => Promise<T | null>,
): Promise<T | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd, env: opts.env ?? helperEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killHelper(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), opts.timeoutMs ?? 20_000);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    // A write to a helper that already died must not crash the gateway.
    child.stdin?.on('error', () => undefined);
    // Drained so a chatty helper never blocks on a full pipe.
    child.stderr?.resume();
    let started: Promise<T | null>;
    try {
      started = work(child);
    } catch {
      finish(null);
      return;
    }
    started.then(finish, () => finish(null));
  });
}

/** Calls `onMessage` for every JSON line the helper prints; other lines are skipped. */
export function onJsonLines(child: ChildProcess, onMessage: (msg: any) => void): void {
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg);
    }
  });
}

/** Writes one JSON message as a line to the helper's stdin. */
export const sendJsonLine = (child: ChildProcess, msg: unknown): void => {
  child.stdin?.write(`${JSON.stringify(msg)}\n`);
};
