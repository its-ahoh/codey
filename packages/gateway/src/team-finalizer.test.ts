import { describe, it, expect, vi } from 'vitest';
import { composeTeamFinal, publishTeamFinal } from './team-finalizer';
import type { ChatMessage } from '@codey/core';
import { ChatManager } from './chats';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const worker = (status: ChatMessage['workerStatus'] = 'done', extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'w', role: 'assistant', worker: 'Alice', workerStatus: status, teamTurnId: 't', content: 'Implemented search', timestamp: 1, ...extra });
const input = () => ({ teamTurnId: 't', task: 'Build search', messages: [worker()] });
describe('Aide terminal message', () => {
  it.each(['sequential', 'graph', 'auto', 'roundtable'] as const)('summarizes evidence across members in %s', async teamMode => {
    const run = vi.fn().mockResolvedValue('Search works; review is still blocked. Grant access.');
    const message = await composeTeamFinal({ ...input(), messages: [worker('done', { teamMode }), worker('failed', { id: 'b', worker: 'Bob', workerFailureReason: 'No access', workerNextUserAction: { text: 'Grant access' } })], run });
    expect(message).toMatchObject({ id: 'team-final:t', worker: 'Aide', builtinMember: 'aide', teamFinal: { source: 'aide', outcome: 'failed' } });
    expect(run.mock.calls[0][0]).toContain('Implemented search');
    expect(run.mock.calls[0][0]).toContain('No access');
    expect(run.mock.calls[0][0]).toContain('do not decide disagreements');
  });
  it.each(['Flow reached maximum hops', 'Flow stopped: no matching next step'])('preserves termination reason: %s', async reason => {
    const message = await composeTeamFinal({ ...input(), reason });
    expect(message!.content).toContain(reason);
    expect(message!.teamFinal!.outcome).toBe('partial');
  });
  it('does not finish a pause; finishes the same run after resume', async () => {
    const run = vi.fn().mockResolvedValue('Finished after clarification.');
    expect(await composeTeamFinal({ ...input(), paused: true, run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect((await composeTeamFinal({ ...input(), paused: false, run }))!.id).toBe('team-final:t');
  });
  it.each([undefined, async () => '', async () => { throw new Error('Unavailable'); }])('falls back honestly when Aide is unavailable or empty', async run => {
    const message = await composeTeamFinal({ ...input(), run });
    expect(message!.teamFinal!.source).toBe('fallback');
    expect(message!.content).toContain('no Aide model summary available');
    expect(message!.content).toContain('Implemented search');
  });
  it('reports no execution rather than claiming completion for a zero-step graph', async () => {
    const message = await composeTeamFinal({ ...input(), messages: [worker('pending')], reason: 'Flow reached its end without executing a member' });
    expect(message!.content).toContain('No member executed');
    expect(message!.teamFinal!.outcome).toBe('empty');
  });
  it('stopping launches no model even when a question was pending', async () => {
    const run = vi.fn();
    const message = await composeTeamFinal({ ...input(), run, stopped: true, paused: true });
    expect(run).not.toHaveBeenCalled();
    expect(message!.teamFinal!.outcome).toBe('stopped');
  });
  it('cancellation does not wait for an unresponsive model and aborts its request', async () => {
    const ac = new AbortController(); let child: AbortSignal | undefined;
    const run = vi.fn((_prompt, signal) => { child = signal; return new Promise<string>(() => {}); });
    const result = composeTeamFinal({ ...input(), signal: ac.signal, run });
    await Promise.resolve(); ac.abort();
    const message = await result;
    expect(child?.aborted).toBe(true);
    expect(message!.teamFinal!.outcome).toBe('stopped');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('times out a stalled Aide and returns an execution record', async () => {
    const message = await composeTeamFinal({ ...input(), run: () => new Promise(() => {}), timeoutMs: 5 });
    expect(message!.teamFinal!.source).toBe('fallback');
  });
  it('persists before emitting, reloads identity, and retries without duplicate records or model calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-final-'));
    try {
      const manager = new ChatManager(root);
      const chat = manager.create({ workspaceName: 'ws', selection: { type: 'team', name: 'T' } });
      manager.appendMessage(chat.id, worker());
      const emitted: ChatMessage[] = [];
      const store = { messages: () => manager.get(chat.id)!.messages, append: (m: ChatMessage) => { manager.appendMessage(chat.id, m); }, emit: (m: ChatMessage) => {
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'ws', 'chats', `${chat.id}.json`), 'utf8'));
        expect(saved.messages.at(-1)).toEqual(m); emitted.push(m);
      } };
      const run = vi.fn().mockResolvedValue('Search implemented. No further action recorded.');
      await publishTeamFinal({ ...input(), run }, store);
      await publishTeamFinal({ ...input(), run }, store);
      expect(run).toHaveBeenCalledTimes(1);
      expect(store.messages().filter(m => m.teamFinal)).toHaveLength(1);
      expect(emitted[0]).toEqual(emitted[1]);
      const reloaded = new ChatManager(root);
      expect(reloaded.get(chat.id)!.messages.at(-1)).toMatchObject({ builtinMember: 'aide', id: 'team-final:t' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
