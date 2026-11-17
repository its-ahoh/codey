import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { forkOpenCodeSession, forkPiSession } from './session-fork';

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const script = (body: string) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fork-'));
  const file = path.join(dir, 'fake.js');
  fs.writeFileSync(file, body);
  return file;
};

// Fake `opencode serve`: messages u1 a1 u2 a2 u3 a3; fork keeps those before the boundary.
const FAKE_OPENCODE = `
const http = require('http');
const sessions = { s1: ['u1','a1','u2','a2','u3','a3'] };
const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expected) { res.writeHead(401); return res.end(); }
  const [, , id, action] = req.url.split('/');
  const list = sessions[decodeURIComponent(id)];
  if (!list) { res.writeHead(404); return res.end(); }
  if (req.method === 'GET') return res.end(JSON.stringify(list.map(m => ({ info: { id: m, role: m[0] === 'u' ? 'user' : 'assistant' } }))));
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const { messageID } = JSON.parse(body);
    sessions.fork1 = list.slice(0, list.indexOf(messageID));
    res.end(JSON.stringify({ id: 'fork1' }));
  });
});
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
`;

// Fake \`pi --mode rpc\`: entries u1 a1 u2 a2; logs the fork entry.
const FAKE_PI = `
const fs = require('fs');
const log = process.argv[2];
let buf = '';
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    let data = {};
    if (m.type === 'get_entries') data = { entries: ['u1','a1','u2','a2'].map(id => ({ id, type: 'message', message: { role: id[0] === 'u' ? 'user' : 'assistant' } })) };
    if (m.type === 'fork') { fs.writeFileSync(log, m.entryId); data = { cancelled: false }; }
    if (m.type === 'get_state') data = { sessionId: 'pi-fork' };
    process.stdout.write(JSON.stringify({ id: m.id, type: 'response', command: m.type, success: true, data }) + '\\n');
  }
});
`;

describe('forkOpenCodeSession', () => {
  it('forks before the oldest of the newest N user messages', async () => {
    const fake = script(FAKE_OPENCODE);
    expect(await forkOpenCodeSession('s1', 2, { command: process.execPath, args: [fake], env: process.env, timeoutMs: 5000 })).toBe('fork1');
  });

  it('refuses to fork away the whole session', async () => {
    const fake = script(FAKE_OPENCODE);
    expect(await forkOpenCodeSession('s1', 3, { command: process.execPath, args: [fake], env: process.env, timeoutMs: 5000 })).toBeNull();
  });

  it('fails for an unknown session or a missing CLI', async () => {
    const fake = script(FAKE_OPENCODE);
    expect(await forkOpenCodeSession('nope', 1, { command: process.execPath, args: [fake], env: process.env, timeoutMs: 5000 })).toBeNull();
    expect(await forkOpenCodeSession('s1', 1, { command: '/nonexistent/opencode', env: process.env, timeoutMs: 2000 })).toBeNull();
  });
});

describe('forkPiSession', () => {
  it('forks at the first dropped user entry and returns the new session id', async () => {
    const fake = script(FAKE_PI);
    const log = path.join(dir, 'fork.log');
    expect(await forkPiSession('pi-1', 1, { command: process.execPath, args: [fake, log], env: process.env, timeoutMs: 5000 })).toBe('pi-fork');
    expect(fs.readFileSync(log, 'utf8')).toBe('u2');
  });

  it('refuses to fork away the whole session', async () => {
    const fake = script(FAKE_PI);
    expect(await forkPiSession('pi-1', 2, { command: process.execPath, args: [fake, path.join(dir, 'x')], env: process.env, timeoutMs: 5000 })).toBeNull();
  });

  it('does nothing for zero turns', async () => {
    expect(await forkPiSession('pi-1', 0, { command: '/nonexistent/pi' })).toBe('pi-1');
  });
});
