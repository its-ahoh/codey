import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-stray-'));
  roots.push(root);
  const manager = new ChatManager(root);
  return { manager, chat: manager.create({ workspaceName: 'main' }) };
}

describe('stray-turn marker on a session', () => {
  it('survives the next good turn on the same session', () => {
    const { manager, chat } = setup();
    manager.setSessionAnchor(chat.id, { agent: 'codex', sessionId: 'T', syncedThroughMessageId: 'a1' });
    manager.markSessionStray(chat.id, 'T', 1000);
    manager.setSessionAnchor(chat.id, { agent: 'codex', sessionId: 'T', syncedThroughMessageId: 'a3' });
    expect(manager.get(chat.id)!.sessionAnchors).toEqual([
      { agent: 'codex', sessionId: 'T', syncedThroughMessageId: 'a3', strayAt: 1000 },
    ]);
  });

  it('is dropped when the agent moves to a different session', () => {
    const { manager, chat } = setup();
    manager.setSessionAnchor(chat.id, { agent: 'codex', sessionId: 'T', syncedThroughMessageId: 'a1' });
    manager.markSessionStray(chat.id, 'T', 1000);
    manager.setSessionAnchor(chat.id, { agent: 'codex', sessionId: 'U', syncedThroughMessageId: 'a3' });
    expect(manager.get(chat.id)!.sessionAnchors![0].strayAt).toBeUndefined();
  });
});
