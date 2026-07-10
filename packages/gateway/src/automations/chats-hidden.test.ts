import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from '../chats';

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-hidden-'));
  fs.mkdirSync(path.join(root, 'default'), { recursive: true });
  return root;
};

const makeManager = () => new ChatManager(makeRoot());

describe('automation chats are hidden', () => {
  it('list() excludes kind=automation by default, includes with the flag', () => {
    const m = makeManager();
    m.create({ workspaceName: 'default', title: 'normal' });
    const hidden = m.create({ workspaceName: 'default', title: 'Automation: x', kind: 'automation' });
    expect(m.list('default').map(c => c.title)).toEqual(['normal']);
    expect(m.list('default', { includeAutomation: true })).toHaveLength(2);
    expect(m.get(hidden.id)?.kind).toBe('automation');
  });

  it('appendMessage does not clobber an automation chat title', () => {
    const m = makeManager();
    const c = m.create({ workspaceName: 'default', title: 'Automation: daily digest', kind: 'automation' });
    m.appendMessage(c.id, {
      id: 'm1', role: 'user', content: 'Summarize yesterday commits and open PRs', timestamp: Date.now(), isComplete: true,
    });
    expect(m.get(c.id)?.title).toBe('Automation: daily digest');
  });

  it('reload sees cross-process changes, new chats, and deletions', () => {
    // Two managers on the same root simulate the daemon + embedded gateways.
    const root = makeRoot();
    const a = new ChatManager(root);
    const b = new ChatManager(root);

    // Both caches warm, then B mutates: A is stale until reload.
    const shared = a.create({ workspaceName: 'default', title: 'Automation: x', kind: 'automation' });
    b.setPendingTeam(shared.id, {
      teamName: 't', task: 'deploy', mode: 'sequential', teamTurnId: 'turn-1',
      memberIndex: 0, carry: '', askingWorker: 'w', question: 'Deploy now?', askedAt: Date.now(),
    });
    expect(a.get(shared.id)?.pendingTeam).toBeUndefined(); // stale cache
    expect(a.reload(shared.id)?.pendingTeam?.question).toBe('Deploy now?');

    // Chat created by B after A loaded: invisible to A's get, found by reload.
    const fresh = b.create({ workspaceName: 'default', title: 'Automation: y', kind: 'automation' });
    expect(a.get(fresh.id)).toBeUndefined();
    expect(a.reload(fresh.id)?.title).toBe('Automation: y');

    // Deleted on disk by B: reload evicts A's cache entry and returns undefined.
    b.delete(shared.id);
    expect(a.reload(shared.id)).toBeUndefined();
    expect(a.get(shared.id)).toBeUndefined();
  });

  it('create honors agent/model overrides', () => {
    const m = makeManager();
    const c = m.create({ workspaceName: 'default', kind: 'automation', agent: 'claude-code', model: 'opus' });
    expect(c.agent).toBe('claude-code');
    expect(c.model).toBe('opus');
  });
});
