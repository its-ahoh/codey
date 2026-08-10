import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';
import { buildChatCatchupPrompt } from './chat-runner';

describe('ChatManager.setWorkingDirOverride', () => {
  let root: string;
  let mgr: ChatManager;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('sets and clears the override', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    const set = mgr.setWorkingDirOverride(chat.id, '/tmp/wt');
    expect(set.workingDirOverride).toBe('/tmp/wt');
    const cleared = mgr.setWorkingDirOverride(chat.id, null);
    expect(cleared.workingDirOverride).toBeUndefined();
  });

  it('persists an owned git context and clears stale identity on manual override', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    const context = {
      repositoryRoot: '/repo',
      branch: 'codey/chat-123',
      worktreePath: '/worktrees/chat-123',
      workingDir: '/worktrees/chat-123/packages/app',
    };
    const isolated = mgr.setGitContext(chat.id, context);
    expect(isolated.gitContext).toEqual(context);
    expect(isolated.workingDirOverride).toBe(context.workingDir);

    const rebound = mgr.setWorkingDirOverride(chat.id, '/tmp/other');
    expect(rebound.gitContext).toBeUndefined();
  });
});

describe('ChatManager.updateAgentModel', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('retains the previous model session when the selection changes', () => {
    const chat = mgr.create({ workspaceName: 'ws', agent: 'codex', model: 'model-a' });
    mgr.setSessionAnchor(chat.id, { agent: 'codex', model: 'model-a', sessionId: 'session-a' });

    const updated = mgr.updateAgentModel(chat.id, 'codex', 'model-b');

    expect(updated.model).toBe('model-b');
    expect(mgr.getSessionAnchor(chat.id, 'codex', 'model-a')?.sessionId).toBe('session-a');
  });

  it('stores independent warm sessions for each agent/model identity', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.setSessionAnchor(chat.id, {
      agent: 'codex', model: 'model-a', sessionId: 'session-a', syncedThroughMessageId: 'a1',
    });
    mgr.setSessionAnchor(chat.id, {
      agent: 'claude-code', model: 'model-b', sessionId: 'session-b', syncedThroughMessageId: 'b1',
    });

    expect(mgr.getSessionAnchor(chat.id, 'codex', 'model-a')).toMatchObject({
      sessionId: 'session-a', syncedThroughMessageId: 'a1',
    });
    expect(mgr.getSessionAnchor(chat.id, 'claude-code', 'model-b')).toMatchObject({
      sessionId: 'session-b', syncedThroughMessageId: 'b1',
    });
  });

  it('clears only the failed identity while preserving other agents', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.setSessionAnchor(chat.id, { agent: 'codex', model: 'model-a', sessionId: 'session-a' });
    mgr.setSessionAnchor(chat.id, { agent: 'claude-code', model: 'model-b', sessionId: 'session-b' });

    mgr.clearSessionAnchor(chat.id, 'codex', 'model-a');

    expect(mgr.getSessionAnchor(chat.id, 'codex', 'model-a')).toBeUndefined();
    expect(mgr.getSessionAnchor(chat.id, 'claude-code', 'model-b')?.sessionId).toBe('session-b');
  });

  it('migrates a legacy anchor with the current transcript cursor', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'question', timestamp: 1, isComplete: true });
    mgr.appendMessage(chat.id, { id: 'a1', role: 'assistant', content: 'answer', timestamp: 2, isComplete: true });
    const stored = mgr.get(chat.id)!;
    stored.sessionAnchor = { agent: 'codex', model: 'model-a', sessionId: 'legacy-session' };
    delete stored.sessionAnchors;

    expect(mgr.getSessionAnchor(chat.id, 'codex', 'model-a')).toMatchObject({
      sessionId: 'legacy-session', syncedThroughMessageId: 'a1',
    });
    expect(mgr.get(chat.id)?.sessionAnchor).toBeUndefined();
  });
});

describe('buildChatCatchupPrompt', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('replays only messages after the returning agent sync cursor', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'already known user turn', timestamp: 1, isComplete: true });
    mgr.appendMessage(chat.id, { id: 'a1', role: 'assistant', content: 'already known answer', timestamp: 2, isComplete: true, agent: 'codex', model: 'model-a' });
    mgr.appendMessage(chat.id, { id: 'u2', role: 'user', content: 'message handled while away', timestamp: 3, isComplete: true });
    mgr.appendMessage(chat.id, { id: 'a2', role: 'assistant', content: 'other agent answer', timestamp: 4, isComplete: true, agent: 'claude-code', model: 'model-b' });

    const prompt = buildChatCatchupPrompt(mgr.get(chat.id)!, 'a1', 'new question');

    expect(prompt).toContain('message handled while away');
    expect(prompt).toContain('other agent answer');
    expect(prompt).toContain('new question');
    expect(prompt).not.toContain('already known user turn');
    expect(prompt).not.toContain('already known answer');
  });
});
