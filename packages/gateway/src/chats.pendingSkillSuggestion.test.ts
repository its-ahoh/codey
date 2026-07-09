import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

describe('ChatManager.setPendingSkillSuggestion', () => {
  let root: string;
  let mgr: ChatManager;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const suggestion = {
    name: 'generate-changelog',
    description: 'Generates a changelog from merged PRs',
    whenToUse: 'When the user asks for a changelog or release notes',
    steps: '1. List merged PRs\n2. Summarize each\n3. Format as changelog',
  };

  it('persists the suggestion so a fresh ChatManager reads it from disk', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.setPendingSkillSuggestion(chat.id, suggestion);
    expect(mgr.get(chat.id)?.pendingSkillSuggestion).toEqual(suggestion);

    const reloaded = new ChatManager(root);
    expect(reloaded.get(chat.id)?.pendingSkillSuggestion).toEqual(suggestion);
  });

  it('clears the field with null and persists the deletion', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.setPendingSkillSuggestion(chat.id, suggestion);
    mgr.setPendingSkillSuggestion(chat.id, null);
    expect(mgr.get(chat.id)?.pendingSkillSuggestion).toBeUndefined();

    const reloaded = new ChatManager(root);
    expect(reloaded.get(chat.id)?.pendingSkillSuggestion).toBeUndefined();
  });

  it('returns silently when the chat does not exist', () => {
    expect(() => mgr.setPendingSkillSuggestion('nope', suggestion)).not.toThrow();
  });
});
