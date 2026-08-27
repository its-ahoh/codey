import { describe, it, expect } from 'vitest';
import { ContextManager } from './context';

function manager(): ContextManager {
  return new ContextManager({ ttlMs: 60000 });
}

describe('ContextManager conversation keying', () => {
  it('keeps two conversations on the same channel from leaking into each other', async () => {
    const cm = manager();
    await cm.addUserTurn('conv-a', 'hello from A');
    await cm.addUserTurn('conv-b', 'hello from B');

    expect(cm.getWindow('conv-a')?.turns.map(t => t.text)).toEqual(['hello from A']);
    expect(cm.getWindow('conv-b')?.turns.map(t => t.text)).toEqual(['hello from B']);
  });

  it('appends to shared history when two senders use one conversation', async () => {
    const cm = manager();
    await cm.addUserTurn('conv-a', 'hello from A');
    await cm.addUserTurn('conv-a', 'second message');

    expect(cm.getWindow('conv-a')?.turns).toHaveLength(2);
  });

  it('lists every conversation it has seen', async () => {
    const cm = manager();
    await cm.addUserTurn('conv-a', 'hello from A');
    await cm.addUserTurn('conv-b', 'hello from B');

    expect(cm.listConversationIds()).toEqual(expect.arrayContaining(['conv-a', 'conv-b']));
  });
});

describe('ContextManager session anchors', () => {
  // An anchor only attaches to an existing window, so seed a turn for each.
  async function anchored(): Promise<ContextManager> {
    const cm = manager();
    await cm.addUserTurn('conv-a', 'hello from A');
    await cm.addUserTurn('conv-b', 'hello from B');
    await cm.setSessionAnchor('conv-a', { agent: 'claude-code', sessionId: 'sid-a' });
    await cm.setSessionAnchor('conv-b', { agent: 'claude-code', sessionId: 'sid-b' });
    return cm;
  }

  it('scopes an anchor to its own window', async () => {
    const cm = await anchored();

    expect(cm.getWindow('conv-a')?.sessionAnchor?.sessionId).toBe('sid-a');
    expect(cm.getWindow('conv-b')?.sessionAnchor?.sessionId).toBe('sid-b');
  });

  it('ignores an anchor for a conversation that has no window yet', async () => {
    const cm = manager();

    await cm.setSessionAnchor('never-seen', { agent: 'claude-code', sessionId: 'sid-x' });

    expect(cm.getWindow('never-seen')).toBeUndefined();
  });

  it('clears one anchor without touching the others', async () => {
    const cm = await anchored();

    await cm.clearSessionAnchor('conv-a');

    expect(cm.getWindow('conv-a')?.sessionAnchor).toBeUndefined();
    expect(cm.getWindow('conv-b')?.sessionAnchor?.sessionId).toBe('sid-b');
  });

  it('clearAllSessionAnchors drops every anchor', async () => {
    const cm = await anchored();

    cm.clearAllSessionAnchors();

    expect(cm.getWindow('conv-a')?.sessionAnchor).toBeUndefined();
    expect(cm.getWindow('conv-b')?.sessionAnchor).toBeUndefined();
  });
});
