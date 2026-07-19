import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutomationStore } from './store';
import { formatRunLogEvent, EVENT_PAYLOAD_CAP } from './run-log';
import type { ChatStreamEvent } from '../chat-runner';

const T = Date.UTC(2026, 6, 18, 12, 0, 0);
const STAMP = '[2026-07-18T12:00:00.000Z]';

describe('formatRunLogEvent', () => {
  it('formats tool_start with one-lined, capped input', () => {
    const e: ChatStreamEvent = {
      type: 'tool_start', chatId: 'c', tool: 'Bash',
      message: 'running', input: { command: 'ls\n-la' },
    };
    expect(formatRunLogEvent(e, T)).toBe(`${STAMP} tool_start Bash {"command":"ls\\n-la"}`);
  });

  it('formats tool_end and truncates long output', () => {
    const e: ChatStreamEvent = {
      type: 'tool_end', chatId: 'c', tool: 'Bash', message: 'done',
      output: 'x'.repeat(EVENT_PAYLOAD_CAP + 10),
    };
    const line = formatRunLogEvent(e, T)!;
    expect(line.startsWith(`${STAMP} tool_end Bash → ${'x'.repeat(20)}`)).toBe(true);
    expect(line.endsWith('… [truncated]')).toBe(true);
    expect(line.length).toBeLessThan(EVENT_PAYLOAD_CAP + 100);
  });

  it('formats team and worker lifecycle events', () => {
    expect(formatRunLogEvent(
      { type: 'team_start', chatId: 'c', teamTurnId: 't', teamName: 'devs', mode: 'sequential' }, T,
    )).toBe(`${STAMP} team_start devs (sequential)`);
    expect(formatRunLogEvent(
      { type: 'worker_start', chatId: 'c', teamTurnId: 't', messageId: 'm', step: 2, worker: 'coder', agent: 'claude-code', model: 'sonnet' }, T,
    )).toBe(`${STAMP} worker_start #2 coder [claude-code/sonnet]`);
    expect(formatRunLogEvent(
      { type: 'worker_end', chatId: 'c', messageId: 'm', step: 2, status: 'done', durationSec: 12, tokens: 340 }, T,
    )).toBe(`${STAMP} worker_end #2 done (12s) 340 tokens`);
  });

  it('collapses multi-line messages to one log line', () => {
    const line = formatRunLogEvent({ type: 'error', chatId: 'c', message: 'boom\n  at foo' }, T)!;
    expect(line).toBe(`${STAMP} error boom ⏎ at foo`);
    expect(line).not.toContain('\n');
  });

  it('summarizes done and permission_denials', () => {
    expect(formatRunLogEvent(
      { type: 'done', chatId: 'c', response: 'r', tokens: 100, durationSec: 5, agent: 'claude-code' }, T,
    )).toBe(`${STAMP} done agent=claude-code tokens=100 duration=5s`);
    expect(formatRunLogEvent(
      { type: 'permission_denials', chatId: 'c', denials: [{ toolName: 'Bash' }, { toolName: 'Write' }] }, T,
    )).toBe(`${STAMP} permission_denied Bash, Write`);
  });

  it('skips token-level events', () => {
    expect(formatRunLogEvent({ type: 'stream', chatId: 'c', token: 'a' }, T)).toBeNull();
    expect(formatRunLogEvent({ type: 'thinking', chatId: 'c', token: 'a' }, T)).toBeNull();
  });
});

describe('AutomationStore run logs', () => {
  let dir: string;
  let store: AutomationStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-runlog-'));
    store = new AutomationStore(dir);
  });

  it('appends and reads back lines per run', () => {
    store.appendRunLog('auto-1', 'run-a', 'line 1');
    store.appendRunLog('auto-1', 'run-a', 'line 2');
    store.appendRunLog('auto-1', 'run-b', 'other run');
    expect(store.readRunLog('auto-1', 'run-a')).toBe('line 1\nline 2\n');
    expect(store.readRunLog('auto-1', 'run-b')).toBe('other run\n');
  });

  it('returns undefined for runs with no log', () => {
    expect(store.readRunLog('auto-1', 'missing')).toBeUndefined();
  });

  it('rejects path-escaping ids', () => {
    store.appendRunLog('auto-1', '../evil', 'nope');
    expect(fs.existsSync(path.join(dir, 'automation-runs', 'evil.log'))).toBe(false);
    expect(store.readRunLog('../..', 'x')).toBeUndefined();
  });

  it('removes the log directory when the automation is deleted', () => {
    const a = store.create({
      name: 'n', enabled: true,
      target: { kind: 'prompt', workspaceName: 'default' },
      brief: 'b', params: {}, report: { notify: 'none' },
    }, 1000);
    store.appendRunLog(a.id, 'run-a', 'line');
    const logDir = path.join(dir, 'automation-runs', a.id);
    expect(fs.existsSync(logDir)).toBe(true);
    store.delete(a.id);
    expect(fs.existsSync(logDir)).toBe(false);
  });
});
