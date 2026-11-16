// packages/core/src/agents/codex-revert.ts
//
// Drops the last N turns from a Codex thread, so the agent's own memory
// matches files the user undid. `codex exec` has no such command; Codex's
// app server does (`thread/revert`, the same call T3 Code uses). We start the
// app server just for this, ask it, and close it. No model call is made.
//
// The app server speaks newline-delimited JSON-RPC over stdio.

import { spawn, type ChildProcess } from 'child_process';

export interface CodexRevertOptions {
  /** Executable to run; tests point this at a fake server. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Removes the newest `numTurns` turns of `threadId`. Resolves true on
 * success, false on any failure (missing CLI, unknown thread, timeout); the
 * caller then falls back to a fresh session.
 */
export function revertCodexTurns(threadId: string, numTurns: number, opts: CodexRevertOptions = {}): Promise<boolean> {
  if (numTurns <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let env = opts.env;
    if (!env) {
      const { withCommonBinPaths } = require('./env') as typeof import('./env');
      env = withCommonBinPaths({ ...process.env });
    }
    let child: ChildProcess;
    try {
      child = spawn(opts.command ?? 'codex', opts.args ?? ['app-server'], {
        cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin?.end(); } catch { /* already closed */ }
      try { child.kill(); } catch { /* already gone */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), opts.timeoutMs ?? 20_000);
    child.on('error', () => finish(false));
    child.on('exit', () => finish(false));

    let nextId = 0;
    const waiting = new Map<number, (msg: any) => void>();
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
        if (typeof msg.id === 'number' && waiting.has(msg.id)) {
          waiting.get(msg.id)!(msg);
          waiting.delete(msg.id);
        }
      }
    });
    const call = (method: string, params: unknown): Promise<any> => new Promise((res, rej) => {
      const id = ++nextId;
      waiting.set(id, (msg) => (msg.error ? rej(new Error(String(msg.error.message ?? method))) : res(msg.result)));
      child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });

    (async () => {
      await call('initialize', { clientInfo: { name: 'codey', version: '1' } });
      child.stdin?.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      // The thread must be loaded in this server before it can be reverted.
      await call('thread/resume', { threadId, excludeTurns: true });
      // Newest first: the oldest of the newest N is the first turn to drop.
      let remaining = numTurns;
      let beforeTurnId: string | undefined;
      let cursor: string | null = null;
      while (remaining > 0) {
        const page: any = await call('thread/turns/list', {
          threadId, cursor, limit: Math.min(remaining, 100), sortDirection: 'desc', itemsView: 'summary',
        });
        for (const turn of page?.data ?? []) {
          beforeTurnId = turn.id;
          if (--remaining === 0) break;
        }
        cursor = page?.nextCursor ?? null;
        if (!cursor) break;
      }
      if (!beforeTurnId) return false;
      await call('thread/revert', { threadId, beforeTurnId });
      return true;
    })().then(finish, () => finish(false));
  });
}
