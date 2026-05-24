import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discussionDir,
  opinionsDir,
  opinionPath,
  controlPath,
  summaryPath,
  topicPath,
  transcriptPath,
  initDiscussionDir,
  destroyDiscussionDir,
  listOpinionFiles,
  appendTranscript,
} from './files';

let root: string;
const ws = 'ws1';
const chat = 'chat1';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
});

describe('path helpers', () => {
  it('return correct paths', () => {
    expect(discussionDir(root, ws, chat)).toBe(path.join(root, ws, 'chats', chat, 'discussion'));
    expect(opinionsDir(root, ws, chat)).toBe(path.join(root, ws, 'chats', chat, 'discussion', 'opinions'));
    expect(opinionPath(root, ws, chat, 'alice')).toBe(path.join(root, ws, 'chats', chat, 'discussion', 'opinions', 'alice.md'));
    expect(controlPath(root, ws, chat)).toBe(path.join(root, ws, 'chats', chat, 'discussion', 'control.md'));
    expect(summaryPath(root, ws, chat)).toBe(path.join(root, ws, 'chats', chat, 'discussion', 'summary.md'));
    expect(topicPath(root, ws, chat)).toBe(path.join(root, ws, 'chats', chat, 'discussion', 'topic.md'));
    expect(transcriptPath(root, ws, chat)).toBe(path.join(root, ws, 'chats', chat, 'discussion', 'transcript.log'));
  });
});

describe('initDiscussionDir', () => {
  it('first call creates all files', async () => {
    await initDiscussionDir(root, ws, chat, 'Should we ship?', ['alice', 'bob']);
    const topic = fs.readFileSync(topicPath(root, ws, chat), 'utf8');
    expect(topic).toContain('Should we ship?');
    const control = fs.readFileSync(controlPath(root, ws, chat), 'utf8');
    expect(control).toContain('status: running');
    expect(fs.existsSync(summaryPath(root, ws, chat))).toBe(true);
    expect(fs.existsSync(transcriptPath(root, ws, chat))).toBe(true);
    expect(fs.readFileSync(opinionPath(root, ws, chat, 'alice'), 'utf8')).toContain("alice's opinion");
    expect(fs.readFileSync(opinionPath(root, ws, chat, 'bob'), 'utf8')).toContain("bob's opinion");
  });
});

describe('listOpinionFiles', () => {
  it('returns sorted names without .md', async () => {
    await initDiscussionDir(root, ws, chat, 't', ['charlie', 'alice', 'bob']);
    const names = await listOpinionFiles(root, ws, chat);
    expect(names).toEqual(['alice', 'bob', 'charlie']);
  });
});

describe('destroyDiscussionDir', () => {
  it('removes entire dir', async () => {
    await initDiscussionDir(root, ws, chat, 't', ['alice']);
    expect(fs.existsSync(discussionDir(root, ws, chat))).toBe(true);
    await destroyDiscussionDir(root, ws, chat);
    expect(fs.existsSync(discussionDir(root, ws, chat))).toBe(false);
  });

  it('is a no-op when missing', async () => {
    await expect(destroyDiscussionDir(root, ws, chat)).resolves.toBeUndefined();
  });
});

describe('resume', () => {
  it('preserves existing opinions and appends to topic', async () => {
    await initDiscussionDir(root, ws, chat, 'First topic', ['alice']);
    const customContent = '# alice opinion\n\nI think yes.\n';
    fs.writeFileSync(opinionPath(root, ws, chat, 'alice'), customContent);

    await initDiscussionDir(root, ws, chat, 'Second topic', ['alice', 'bob']);

    expect(fs.readFileSync(opinionPath(root, ws, chat, 'alice'), 'utf8')).toBe(customContent);
    const topic = fs.readFileSync(topicPath(root, ws, chat), 'utf8');
    expect(topic).toContain('First topic');
    expect(topic).toContain('## Continuation');
    expect(topic).toContain('Second topic');
    expect(fs.readFileSync(opinionPath(root, ws, chat, 'bob'), 'utf8')).toContain("bob's opinion");
    const control = fs.readFileSync(controlPath(root, ws, chat), 'utf8');
    expect(control).toContain('status: running');
    expect(control).toContain('revision: 1');
  });
});

describe('appendTranscript', () => {
  it('appends a line with actor and kind', async () => {
    await initDiscussionDir(root, ws, chat, 't', ['alice']);
    await appendTranscript(root, ws, chat, { actor: 'alice', kind: 'spoke', note: 'hello\nworld' });
    const content = fs.readFileSync(transcriptPath(root, ws, chat), 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('alice');
    expect(lines[0]).toContain('spoke');
    expect(lines[0]).toContain('hello world');
    expect(lines[0]).not.toMatch(/hello\nworld/);
  });
});
