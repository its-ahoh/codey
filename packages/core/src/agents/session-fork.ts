// packages/core/src/agents/session-fork.ts
//
// Cuts the newest N turns off an OpenCode or Pi conversation, so the agent's
// own memory matches files the user undid. Neither `opencode run` nor
// `pi --mode json` can do this; both agents can fork a session at a given
// message through their long-running modes. We start that mode just for the
// fork, and close it. No model call is made.
//
// Both forks produce a NEW session (new id) holding everything before the
// first dropped turn; the caller switches to it.
//
//   OpenCode: `opencode serve` → GET /session/:id/message,
//             POST /session/:id/fork { messageID } (keeps messages before it)
//   Pi:       `pi --mode rpc --session <id>` → get_entries,
//             fork { entryId } (keeps entries before it), get_state
//
// Verified against opencode 1.19.5 and pi 1.5.1 (2026-11-16).

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';

export interface SessionForkOptions {
  /** Executable and args; tests point these at fakes. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const defaultEnv = (): NodeJS.ProcessEnv => {
  const { withCommonBinPaths } = require('./env') as typeof import('./env');
  return withCommonBinPaths({ ...process.env });
};

/** Starts a helper process in its own group so it (and anything it starts)
 *  can be killed together: `opencode serve` ignores SIGTERM. */
function startHelper(command: string, args: string[], opts: SessionForkOptions, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
}

function killHelper(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/** Runs `work` against a helper, with a deadline. Resolves null on any failure. */
function withHelper<T>(
  command: string,
  args: string[],
  opts: SessionForkOptions,
  env: NodeJS.ProcessEnv,
  work: (child: ChildProcess) => Promise<T | null>,
): Promise<T | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = startHelper(command, args, opts, env);
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
    work(child).then(finish, () => finish(null));
  });
}

/**
 * OpenCode: forks `sessionId` before its newest `numTurns` user messages.
 * Resolves the new session id, or null on any failure.
 */
export function forkOpenCodeSession(sessionId: string, numTurns: number, opts: SessionForkOptions = {}): Promise<string | null> {
  if (numTurns <= 0) return Promise.resolve(sessionId);
  // The server is reachable on localhost while it runs; a one-off password
  // keeps other local processes out.
  const password = randomBytes(24).toString('hex');
  const env = { ...(opts.env ?? defaultEnv()), OPENCODE_SERVER_PASSWORD: password };
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  return withHelper(opts.command ?? 'opencode', opts.args ?? ['serve', '--port', '0', '--hostname', '127.0.0.1'], opts, env,
    (child) => new Promise<string | null>((resolve, reject) => {
      let out = '';
      let started = false;
      const onData = (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const match = /https?:\/\/127\.0\.0\.1:\d+/.exec(out);
        if (!match || started) return;
        started = true;
        const base = match[0];
        const http = async (path: string, init?: RequestInit) => {
          const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: auth, 'content-type': 'application/json' } });
          if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
          return res.json() as Promise<any>;
        };
        (async () => {
          const id = encodeURIComponent(sessionId);
          const messages: any[] = await http(`/session/${id}/message`);
          const users = messages.filter(m => m?.info?.role === 'user');
          if (users.length < numTurns) return null;
          const boundary = users[users.length - numTurns].info.id;
          const boundaryIndex = messages.findIndex(m => m.info.id === boundary);
          if (boundaryIndex <= 0) return null; // nothing would be kept
          const fork = await http(`/session/${id}/fork`, { method: 'POST', body: JSON.stringify({ messageID: boundary }) });
          if (!fork?.id) return null;
          const kept: any[] = await http(`/session/${encodeURIComponent(fork.id)}/message`);
          return kept.length === boundaryIndex ? String(fork.id) : null;
        })().then(resolve, reject);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
    }));
}

/**
 * Pi: forks `sessionId` before its newest `numTurns` user entries.
 * Resolves the new session id, or null on any failure.
 */
export function forkPiSession(sessionId: string, numTurns: number, opts: SessionForkOptions = {}): Promise<string | null> {
  if (numTurns <= 0) return Promise.resolve(sessionId);
  const env = opts.env ?? defaultEnv();
  return withHelper(opts.command ?? 'pi', opts.args ?? ['--mode', 'rpc', '--session', sessionId], opts, env, async (child) => {
    let buffer = '';
    let next = 0;
    const waiting = new Map<string, (msg: any) => void>();
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.type === 'response' && waiting.has(msg.id)) {
          waiting.get(msg.id)!(msg);
          waiting.delete(msg.id);
        }
      }
    });
    const call = (command: Record<string, unknown>) => new Promise<any>((res, rej) => {
      const id = `codey-${++next}`;
      waiting.set(id, (msg) => (msg.success === false ? rej(new Error(String(msg.error ?? command.type))) : res(msg.data)));
      child.stdin?.write(`${JSON.stringify({ id, ...command })}\n`);
    });

    const listing = await call({ type: 'get_entries' });
    const users = (listing?.entries ?? []).filter((e: any) => e?.type === 'message' && e.message?.role === 'user');
    if (users.length <= numTurns) return null; // nothing would be kept
    const boundary = users[users.length - numTurns].id;
    const forked = await call({ type: 'fork', entryId: boundary });
    if (forked?.cancelled) return null;
    const state = await call({ type: 'get_state' });
    const newId = state?.sessionId;
    return typeof newId === 'string' && newId && newId !== sessionId ? newId : null;
  });
}
