import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { revertCodexTurns } from './codex-revert';

// A fake `codex app-server`: answers JSON-RPC and logs every request.
const FAKE = `
const fs = require('fs');
const log = process.argv[2];
const turns = JSON.parse(process.argv[3]);
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify(m) + '\\n');
    if (m.id == null) continue;
    let result = {};
    if (m.method === 'thread/turns/list') result = { data: turns.slice().reverse().map(id => ({ id })), nextCursor: null };
    if (m.method === 'thread/resume' && m.params.threadId === 'missing') {
      process.stdout.write(JSON.stringify({ id: m.id, error: { message: 'no thread' } }) + '\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
  }
});
`;

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function setup(turns: string[]) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-revert-'));
  const script = path.join(dir, 'fake.js');
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(script, FAKE);
  const opts = { command: process.execPath, args: [script, log, JSON.stringify(turns)], env: process.env, timeoutMs: 5000 };
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { opts, calls };
}

describe('revertCodexTurns', () => {
  it('reverts to before the oldest of the newest N turns', async () => {
    const { opts, calls } = setup(['t1', 't2', 't3']);
    expect(await revertCodexTurns('thread-1', 2, opts)).toBe(true);
    const methods = calls().map(c => c.method);
    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume', 'thread/turns/list', 'thread/revert']);
    expect(calls().at(-1).params).toEqual({ threadId: 'thread-1', beforeTurnId: 't2' });
  });

  it('refuses when no older turn would be left, instead of wiping the thread', async () => {
    for (const turns of [['t1', 't2'], ['t1', 't2', 't3']]) {
      const { opts, calls } = setup(turns);
      expect(await revertCodexTurns('thread-1', 3, opts)).toBe(false);
      expect(calls().map(c => c.method)).not.toContain('thread/revert');
    }
  });

  it('fails when the thread is unknown', async () => {
    const { opts } = setup(['t1']);
    expect(await revertCodexTurns('missing', 1, opts)).toBe(false);
  });

  it('fails when the CLI is missing', async () => {
    expect(await revertCodexTurns('x', 1, { command: '/nonexistent/codex', env: process.env, timeoutMs: 2000 })).toBe(false);
  });

  it('does nothing for zero turns', async () => {
    expect(await revertCodexTurns('x', 0, { command: '/nonexistent/codex' })).toBe(true);
  });
});
