import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

describe('ChatManager.setWorkingDirOverride', () => {
  let root: string;
  let mgr: ChatManager;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  it('sets and clears the override', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    const set = mgr.setWorkingDirOverride(chat.id, '/tmp/wt');
    expect(set.workingDirOverride).toBe('/tmp/wt');
    const cleared = mgr.setWorkingDirOverride(chat.id, null);
    expect(cleared.workingDirOverride).toBeUndefined();
  });
});
