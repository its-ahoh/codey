import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GrokAdapter,
  acpMcpServers,
  grokChecklistFromPlan,
  grokEffortOption,
  grokErrorMessage,
  grokModelEnv,
  grokPermissionOutcome,
  grokPermissionVerdict,
  grokSpawnArgs,
  grokTokensFrom,
  grokToolEvent,
  isGrokModel,
  isMissingGrokSession,
} from './grok';
import { AcpRequestError } from './acp-client';
import { CODING_AGENTS, StatusUpdate, modelFitsApiType } from '../types';
import { AgentFactory } from './index';

// ── Pure helpers ───────────────────────────────────────────────────────

describe('grokSpawnArgs', () => {
  it('runs the ACP agent over stdio, options before the mode', () => {
    expect(grokSpawnArgs({})).toEqual(['agent', 'stdio']);
  });

  it('passes a grok model and auto-approves only when permissions are skipped', () => {
    const args = grokSpawnArgs({ model: { model: 'grok-build', provider: 'grok', apiType: 'grok' }, skipPermissions: true });
    expect(args).toEqual(['agent', '--model', 'grok-build', '--always-approve', 'stdio']);
  });

  it('never auto-approves under a tool policy', () => {
    expect(grokSpawnArgs({ skipPermissions: true, toolPolicy: 'read-only' })).not.toContain('--always-approve');
  });

  it('ignores a model meant for another CLI', () => {
    for (const apiType of ['anthropic', 'openai', 'all', 'cursor'] as const) {
      expect(grokSpawnArgs({ model: { model: 'other', provider: 'x', apiType } })).not.toContain('--model');
    }
  });
});

describe('grok models and keys', () => {
  it('hands a grok model key over as XAI_API_KEY only', () => {
    const model = { model: 'grok-build', provider: 'grok', apiType: 'grok' as const, apiKey: 'xai-test' };
    expect(grokModelEnv(model)).toEqual({ XAI_API_KEY: 'xai-test' });
    expect(grokModelEnv({ ...model, apiType: 'openai' })).toEqual({});
    expect(grokSpawnArgs({ model }).join(' ')).not.toContain('xai-test');
  });

  it('trusts a bare typed name', () => {
    expect(isGrokModel({ model: 'grok-build', provider: 'grok' })).toBe(true);
  });

  it('grok models and the grok agent only fit each other', () => {
    expect(modelFitsApiType('grok', 'grok')).toBe(true);
    expect(modelFitsApiType('all', 'grok')).toBe(false);
    expect(modelFitsApiType('grok', 'all')).toBe(false);
    expect(modelFitsApiType('grok', 'cursor')).toBe(false);
    expect(modelFitsApiType('grok', undefined)).toBe(false);
  });
});

describe('acpMcpServers', () => {
  it('maps local and remote servers to ACP shapes', () => {
    expect(acpMcpServers({
      local: { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 't' } },
      remote: { command: '', args: [], env: {}, url: 'https://mcp.example.test' },
    })).toEqual([
      { name: 'local', command: 'npx', args: ['-y', 'srv'], env: [{ name: 'TOKEN', value: 't' }] },
      { type: 'http', name: 'remote', url: 'https://mcp.example.test', headers: [] },
    ]);
    expect(acpMcpServers(undefined)).toEqual([]);
  });
});

describe('permissions', () => {
  it('always allows read-like tools on a normal turn', () => {
    expect(grokPermissionVerdict('read', {})).toEqual({ allow: true, record: false });
    expect(grokPermissionVerdict('search', {})).toEqual({ allow: true, record: false });
  });

  it('refuses and reports writes unless permissions are skipped', () => {
    expect(grokPermissionVerdict('edit', {})).toEqual({ allow: false, record: true });
    expect(grokPermissionVerdict('execute', { skipPermissions: true })).toEqual({ allow: true, record: false });
  });

  it('a policy refuses writes even when skipping, silently', () => {
    expect(grokPermissionVerdict('edit', { toolPolicy: 'read-only', skipPermissions: true })).toEqual({ allow: false, record: false });
    expect(grokPermissionVerdict('read', { toolPolicy: 'read-only' })).toEqual({ allow: true, record: false });
    expect(grokPermissionVerdict('read', { toolPolicy: 'none' })).toEqual({ allow: false, record: false });
  });

  it('picks one-shot options and cancels when none fit', () => {
    const options = [
      { optionId: 'a1', kind: 'allow_always' },
      { optionId: 'a0', kind: 'allow_once' },
      { optionId: 'r0', kind: 'reject_once' },
    ];
    expect(grokPermissionOutcome(options, true)).toEqual({ outcome: { outcome: 'selected', optionId: 'a0' } });
    expect(grokPermissionOutcome(options, false)).toEqual({ outcome: { outcome: 'selected', optionId: 'r0' } });
    expect(grokPermissionOutcome([], true)).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('grokToolEvent', () => {
  it('opens on tool_call and closes on a terminal update with the same name', () => {
    const names = new Map<string, string>();
    expect(grokToolEvent({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'Read a.ts', status: 'pending', rawInput: { path: 'a.ts' } }, names))
      .toEqual({ tool: 'read', key: 't1', phase: 'start', input: { path: 'a.ts' } });
    expect(grokToolEvent({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }, names)).toBeNull();
    expect(grokToolEvent({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'x' }, names))
      .toEqual({ tool: 'read', key: 't1', phase: 'end', status: 'completed', output: 'x' });
  });

  it('falls back to the title for kind "other" and reads text content as output', () => {
    const names = new Map<string, string>();
    grokToolEvent({ sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'other', title: 'mcp: list_prs' }, names);
    expect(grokToolEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
    }, names)).toMatchObject({ tool: 'mcp: list_prs', status: 'failed', output: 'boom' });
  });
});

describe('plan, usage, effort, errors', () => {
  it('turns the plan into checklist items', () => {
    expect(grokChecklistFromPlan([
      { content: 'Read code', status: 'completed' },
      { content: 'Fix bug', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
    ])).toEqual([
      { text: 'Read code', status: 'completed' },
      { text: 'Fix bug', status: 'in_progress' },
      { text: 'Test', status: 'pending' },
    ]);
    expect(grokChecklistFromPlan([])).toBeNull();
  });

  it('takes the cache out of ACP input tokens', () => {
    expect(grokTokensFrom({ inputTokens: 1000, outputTokens: 50, cachedReadTokens: 800, cachedWriteTokens: 0, thoughtTokens: 20 }))
      .toEqual({ input: 200, output: 50, total: 250, reasoning: 20, cache: { read: 800, write: 0 } });
    expect(grokTokensFrom(undefined)).toBeUndefined();
  });

  it('sets effort only through a thought_level option that offers the level', () => {
    const configOptions = [
      { id: 'model', category: 'model', options: [{ value: 'grok-build' }] },
      { id: 'effort', category: 'thought_level', options: [{ value: 'low' }, { value: 'high' }] },
    ];
    expect(grokEffortOption(configOptions, 'high')).toEqual({ configId: 'effort', value: 'high' });
    expect(grokEffortOption(configOptions, 'max')).toBeNull();
    expect(grokEffortOption(undefined, 'high')).toBeNull();
  });

  it('spots a missing session but not an auth failure', () => {
    expect(isMissingGrokSession(new AcpRequestError('session/load', { code: -32002, message: 'Resource not found' }))).toBe(true);
    expect(isMissingGrokSession(new AcpRequestError('session/load', { code: -32000, message: 'Authentication required' }))).toBe(false);
  });

  it('explains how to sign in', () => {
    const msg = grokErrorMessage(new AcpRequestError('session/new', { code: -32000, message: 'Authentication required', data: 'no auth method id provided' }));
    expect(msg).toMatch(/grok login/);
    expect(msg).toMatch(/no auth method id provided/);
  });
});

describe('registration', () => {
  it('grok is a known agent with an adapter', () => {
    expect(CODING_AGENTS).toContain('grok');
    expect(new AgentFactory().get('grok')?.name).toBe('grok');
  });
});

// ── Whole flow, against a fake ACP agent ───────────────────────────────

/** A stand-in `grok` that speaks ACP the way grok 0.2.102 does at the
 *  protocol level: same methods, same error for a missing login. */
const FAKE_GROK = String.raw`#!/usr/bin/env node
const log = process.env.FAKE_GROK_LOG;
const fs = require('fs');
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), key: process.env.XAI_API_KEY || null, pid: process.pid }) + '\n');
// Like grok: stdin EOF means the client is gone, so persist and exit — unless
// told to be stubborn, which stands in for a grok that hangs on shutdown.
process.stdin.on('end', () => {
  if (process.env.FAKE_GROK_STUBBORN) { setInterval(() => {}, 1000); return; }
  if (log) fs.appendFileSync(log, JSON.stringify({ saved: true }) + '\n');
  process.exit(0);
});
let buf = '';
let nextId = 1000;
const waiting = {};
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) => new Promise(r => { const id = nextId++; waiting[id] = r; send({ jsonrpc: '2.0', id, method, params }); });
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
async function handle(m) {
  if (m.id !== undefined && waiting[m.id]) { waiting[m.id](m.result); delete waiting[m.id]; return; }
  const p = m.params || {};
  switch (m.method) {
    case 'initialize':
      // Real grok rejects an initialize whose clientInfo has no version.
      if (!p.clientInfo || typeof p.clientInfo.version !== 'string') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid params: missing field version' } });
      return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    case 'session/new':
      if (process.env.FAKE_GROK_NO_AUTH) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required', data: 'no auth method id provided' } });
      return send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess-new', configOptions: [{ id: 'effort', category: 'thought_level', options: [{ value: 'high' }] }] } });
    case 'session/load':
      if (p.sessionId === 'gone') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Resource not found' } });
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } });
      return send({ jsonrpc: '2.0', id: m.id, result: {} });
    case 'session/set_config_option':
      if (log) fs.appendFileSync(log, JSON.stringify({ config: p }) + '\n');
      return send({ jsonrpc: '2.0', id: m.id, result: {} });
    case 'session/prompt': {
      const s = p.sessionId;
      update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } });
      update(s, { sessionUpdate: 'plan', entries: [{ content: 'Read', status: 'in_progress' }, { content: 'Edit', status: 'pending' }] });
      update(s, { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'Read a.ts', status: 'pending', rawInput: { path: 'a.ts' } });
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'contents' });
      const verdict = await ask('session/request_permission', {
        sessionId: s,
        toolCall: { toolCallId: 't2', kind: 'edit', title: 'Edit a.ts', rawInput: { path: 'a.ts' } },
        options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
      });
      const allowed = verdict.outcome.optionId === 'yes';
      update(s, { sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'edit', title: 'Edit a.ts', status: allowed ? 'completed' : 'failed' });
      update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Edited.' : 'Edit was refused.' } });
      return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', _meta: { usage: { inputTokens: 900, outputTokens: 40, cachedReadTokens: 600 } } } });
    }
  }
}
`;

describe('GrokAdapter against a fake ACP agent', () => {
  let dir: string;
  let logFile: string;
  const env = () => ({ PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, FAKE_GROK_LOG: logFile });
  const readLog = () => fs.readFileSync(logFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-fake-grok-'));
    logFile = path.join(dir, 'log.jsonl');
    const bin = path.join(dir, 'grok');
    fs.writeFileSync(bin, FAKE_GROK, { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const base = (extra: Record<string, unknown> = {}) => ({
    prompt: 'fix it',
    agent: 'grok' as const,
    context: { workingDir: dir },
    timeout: 20000,
    ...extra,
    extraEnv: { ...env(), ...(extra.extraEnv as Record<string, string> | undefined) },
  });

  it('streams text, thoughts, tools and plan, and reports a refused edit', async () => {
    fs.writeFileSync(logFile, '');
    const statuses: StatusUpdate[] = [];
    const streamed: string[] = [];
    const res = await new GrokAdapter().run({
      ...base({ effort: 'high', model: { model: 'grok-build', provider: 'grok', apiType: 'grok', apiKey: 'xai-test' } }),
      onStatus: s => statuses.push(s),
      onStream: t => streamed.push(t),
    });

    expect(res.success).toBe(true);
    expect(res.output).toBe('Looking.\n\nEdit was refused.');
    expect(streamed.join('')).toBe(res.output);
    expect(res.thinking).toBe('thinking');
    expect(res.sessionId).toBe('sess-new');
    expect(res.tokens).toEqual({ input: 300, output: 40, total: 340, cache: { read: 600, write: 0 } });
    expect(res.permissionDenials).toEqual([{ toolName: 'edit', toolInput: { path: 'a.ts' } }]);
    expect(statuses.filter(s => s.type === 'tool_start').map(s => s.tool)).toEqual(['read', 'edit']);
    expect(statuses.some(s => s.type === 'checklist')).toBe(true);

    const log = readLog();
    expect(log[0]).toMatchObject({ argv: ['agent', '--model', 'grok-build', 'stdio'], key: 'xai-test' });
    expect(log).toContainEqual({ config: { sessionId: 'sess-new', configId: 'effort', value: 'high' } });
  });

  it('allows the edit when permissions are skipped', async () => {
    fs.writeFileSync(logFile, '');
    const res = await new GrokAdapter().run(base({ skipPermissions: true }));
    expect(res.output).toBe('Looking.\n\nEdited.');
    expect(res.permissionDenials).toBeUndefined();
    expect(readLog()[0].argv).toEqual(['agent', '--always-approve', 'stdio']);
  });

  it('resumes without leaking the replayed history', async () => {
    const res = await new GrokAdapter().run(base({ resumeSessionId: 'sess-old' }));
    expect(res.success).toBe(true);
    expect(res.output).not.toContain('OLD HISTORY');
    expect(res.sessionId).toBe('sess-old');
  });

  it('reports a vanished session in words the gateway re-bootstraps on', async () => {
    const res = await new GrokAdapter().run(base({ resumeSessionId: 'gone' }));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^Could not resume session gone/);
  });

  it('turns a missing login into a sign-in hint', async () => {
    const res = await new GrokAdapter().run(base({ extraEnv: { FAKE_GROK_NO_AUTH: '1' } }));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/grok login/);
  });

  it('lets grok exit on its own after the turn, so it can save the session', async () => {
    fs.writeFileSync(logFile, '');
    const res = await new GrokAdapter().run(base());
    expect(res.success).toBe(true);
    expect(readLog()).toContainEqual({ saved: true });
  });

  it('kills a grok that will not exit once the grace period is over', async () => {
    fs.writeFileSync(logFile, '');
    const started = Date.now();
    const res = await new GrokAdapter(undefined, { exitGraceMs: 300 }).run(base({ extraEnv: { FAKE_GROK_STUBBORN: '1' } }));
    expect(res.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = readLog()[0].pid as number;
    // Termination is a signal, not a wait; give the process a moment to go.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await new GrokAdapter().run({ ...base(), signal: controller.signal });
    expect(res).toMatchObject({ success: false, error: 'aborted', output: 'Stopped' });
  });
});
