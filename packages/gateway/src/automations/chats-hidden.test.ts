import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from '../chats';

const makeManager = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-hidden-'));
  fs.mkdirSync(path.join(root, 'default'), { recursive: true });
  return new ChatManager(root);
};

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

  it('create honors agent/model overrides', () => {
    const m = makeManager();
    const c = m.create({ workspaceName: 'default', kind: 'automation', agent: 'claude-code', model: 'opus' });
    expect(c.agent).toBe('claude-code');
    expect(c.model).toBe('opus');
  });
});
