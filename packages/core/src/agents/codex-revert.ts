// packages/core/src/agents/codex-revert.ts
//
// Drops the last N turns from a Codex thread, so the agent's own memory
// matches files the user undid. `codex exec` has no such command; Codex's
// app server does (`thread/revert`, the same call T3 Code uses). We start the
// app server just for this, ask it, and close it. No model call is made.
//
// The app server speaks newline-delimited JSON-RPC over stdio.

import { onJsonLines, sendJsonLine, withHelper } from './helper-process';

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
 * success, false on any failure (missing CLI, unknown thread, timeout, or a
 * thread with no older turn left to keep); the caller then falls back to a
 * fresh session.
 */
export async function revertCodexTurns(threadId: string, numTurns: number, opts: CodexRevertOptions = {}): Promise<boolean> {
  if (numTurns <= 0) return true;
  const ok = await withHelper(opts.command ?? 'codex', opts.args ?? ['app-server'], opts, async (child) => {
    let nextId = 0;
    const waiting = new Map<number, (msg: any) => void>();
    onJsonLines(child, (msg) => {
      if (typeof msg.id !== 'number' || !waiting.has(msg.id)) return;
      waiting.get(msg.id)!(msg);
      waiting.delete(msg.id);
    });
    const call = (method: string, params: unknown): Promise<any> => new Promise((res, rej) => {
      const id = ++nextId;
      waiting.set(id, (msg) => (msg.error ? rej(new Error(String(msg.error.message ?? method))) : res(msg.result)));
      sendJsonLine(child, { id, method, params });
    });

    await call('initialize', { clientInfo: { name: 'codey', version: '1' } });
    sendJsonLine(child, { method: 'initialized' });
    // The thread must be loaded in this server before it can be reverted.
    await call('thread/resume', { threadId, excludeTurns: true });
    // Newest first: the oldest of the newest N is the first turn to drop.
    // One turn more is read to prove an older turn stays: a thread with
    // fewer turns than expected is not the thread the caller counted, and
    // reverting it would wipe turns the caller means to keep.
    const turnIds: string[] = [];
    let cursor: string | null = null;
    while (turnIds.length <= numTurns) {
      const page: any = await call('thread/turns/list', {
        threadId, cursor, limit: Math.min(numTurns + 1 - turnIds.length, 100), sortDirection: 'desc', itemsView: 'summary',
      });
      for (const turn of page?.data ?? []) {
        if (typeof turn?.id === 'string') turnIds.push(turn.id);
      }
      cursor = page?.nextCursor ?? null;
      if (!cursor) break;
    }
    if (turnIds.length <= numTurns) return false;
    const beforeTurnId = turnIds[numTurns - 1];
    await call('thread/revert', { threadId, beforeTurnId });
    return true;
  });
  return ok === true;
}
