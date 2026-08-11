import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';
import { buildChatCatchupPrompt, buildChatResumePrompt, resumeContextExcerpt } from './chat-runner';

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

describe('ChatManager.updateEffort', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('sets and clears the per-chat effort override, bumping updatedAt', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    const beforeUpdatedAt = chat.updatedAt;

    const set = mgr.updateEffort(chat.id, 'high');
    expect(set.effort).toBe('high');
    expect(set.updatedAt).toBeGreaterThanOrEqual(beforeUpdatedAt);

    const cleared = mgr.updateEffort(chat.id, null);
    expect(cleared.effort).toBeUndefined();
    expect('effort' in cleared).toBe(false);
  });

  it('persists the cleared effort so it does not round-trip from disk', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.updateEffort(chat.id, 'max');
    mgr.updateEffort(chat.id, undefined);

    const reloaded = new ChatManager(root);
    expect(reloaded.get(chat.id)?.effort).toBeUndefined();
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

describe('buildChatResumePrompt', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('pins the latest persisted assistant message for a digit reply', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'How should we execute?', timestamp: 1, isComplete: true });
    mgr.appendMessage(chat.id, {
      id: 'a1', role: 'assistant', content: '1. Subagent-driven\n2. Inline execution\n\nWhich one?', timestamp: 2, isComplete: true,
    });

    const prompt = buildChatResumePrompt(mgr.get(chat.id)!, '1');

    expect(prompt).toContain('Most recent persisted assistant message');
    expect(prompt).toContain('1. Subagent-driven');
    expect(prompt).toContain('Respond to this new user message]\n1');
  });

  it('pins the checkpoint for a substantive new request too', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'a1', role: 'assistant', content: 'old answer', timestamp: 1, isComplete: true });

    const prompt = buildChatResumePrompt(mgr.get(chat.id)!, 'Implement the authentication middleware');

    expect(prompt).toContain('old answer');
    expect(prompt).toContain('Implement the authentication middleware');
  });

  it('bounds a large checkpoint while preserving its head and tail', () => {
    const prior = `HEAD:${'a'.repeat(5_000)}:TAIL:${'z'.repeat(5_000)}`;

    const excerpt = resumeContextExcerpt(prior);

    expect(excerpt.length).toBeLessThan(prior.length);
    expect(excerpt).toContain('HEAD:');
    expect(excerpt).toContain(':TAIL:');
    expect(excerpt).toContain('middle of prior assistant message omitted');
  });
});
