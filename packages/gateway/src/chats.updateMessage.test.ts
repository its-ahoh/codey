import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

describe('ChatManager.updateMessage', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    mgr = new ChatManager(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('patches a message in place and persists', () => {
    const chat = mgr.create({ workspaceName: 'ws', selection: { type: 'team', name: 't' }, title: 't' });
    mgr.appendMessage(chat.id, { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [], workerStatus: 'running' });

    mgr.updateMessage(chat.id, 'm1', { content: 'hello', workerStatus: 'done', isComplete: true });

    const after = mgr.get(chat.id)!;
    const m = after.messages.find(x => x.id === 'm1')!;
    expect(m.content).toBe('hello');
    expect(m.workerStatus).toBe('done');
    expect(m.isComplete).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'ws', 'chats', `${chat.id}.json`), 'utf8'));
    expect(onDisk.messages.find((x: any) => x.id === 'm1').content).toBe('hello');
  });

  it('is a no-op when the message id is unknown', () => {
    const chat = mgr.create({ workspaceName: 'ws', selection: { type: 'team', name: 't' }, title: 't' });
    expect(() => mgr.updateMessage(chat.id, 'nope', { content: 'x' })).not.toThrow();
  });
});
