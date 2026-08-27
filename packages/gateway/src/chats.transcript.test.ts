import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';
import { buildChatCatchupPrompt, CATCHUP_INLINE_LIMIT } from './chat-runner';

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

describe('ChatManager transcript sidecar', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-transcript-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes one line per message, in order', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'first', timestamp: 1, isComplete: true });
    mgr.appendMessage(chat.id, { id: 'a1', role: 'assistant', content: 'second', timestamp: 2, isComplete: true, agent: 'codex', model: 'm' });

    const file = mgr.transcriptPath(chat.id)!;
    const rows = lines(file).map(l => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'u1', role: 'user', content: 'first' });
    expect(rows[1]).toMatchObject({ id: 'a1', role: 'assistant', content: 'second', agent: 'codex', model: 'm' });
  });

  it('keeps line N aligned with messages[N-1] as the chat grows', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    for (let i = 0; i < 25; i++) {
      mgr.appendMessage(chat.id, { id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `body ${i}`, timestamp: i, isComplete: true });
    }
    const rows = lines(mgr.transcriptPath(chat.id)!).map(l => JSON.parse(l));
    const messages = mgr.get(chat.id)!.messages;
    expect(rows).toHaveLength(messages.length);
    rows.forEach((row, idx) => expect(row.id).toBe(messages[idx].id));
  });

  it('embeds newlines rather than emitting extra lines', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'line one\nline two\nline three', timestamp: 1, isComplete: true });
    const rows = lines(mgr.transcriptPath(chat.id)!);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]).content).toBe('line one\nline two\nline three');
  });

  it('omits bulky tool calls and thinking', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, {
      id: 'a1', role: 'assistant', content: 'answer', timestamp: 1, isComplete: true,
      thinking: 'SECRET_REASONING',
      toolCalls: [{ type: 'tool_end', tool: 'Bash', message: 'BULKY_TOOL_OUTPUT' } as never],
    });
    const raw = fs.readFileSync(mgr.transcriptPath(chat.id)!, 'utf8');
    expect(raw).toContain('answer');
    expect(raw).not.toContain('SECRET_REASONING');
    expect(raw).not.toContain('BULKY_TOOL_OUTPUT');
  });

  it('refreshes the line when a stub message is filled in later', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'a1', role: 'assistant', content: '', timestamp: 1, isComplete: false });
    mgr.updateMessage(chat.id, 'a1', { content: 'filled in by the worker', isComplete: true });

    const rows = lines(mgr.transcriptPath(chat.id)!).map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('filled in by the worker');
  });

  it('rebuilds after a mid-list removal', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'keep me', timestamp: 1, isComplete: true });
    mgr.appendMessage(chat.id, { id: 'u2', role: 'user', content: 'drop me', timestamp: 2, isComplete: true });
    mgr.appendMessage(chat.id, { id: 'u3', role: 'user', content: 'keep me too', timestamp: 3, isComplete: true });

    mgr.removeMessage(chat.id, 'u2');

    const rows = lines(mgr.transcriptPath(chat.id)!).map(l => JSON.parse(l));
    expect(rows.map(r => r.id)).toEqual(['u1', 'u3']);
  });

  it('backfills a chat that predates the sidecar', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'old one', timestamp: 1, isComplete: true });
    mgr.appendMessage(chat.id, { id: 'u2', role: 'user', content: 'old two', timestamp: 2, isComplete: true });

    // Simulate a chat written before the sidecar existed.
    fs.unlinkSync(mgr.transcriptPath(chat.id)!);
    const reloaded = new ChatManager(root);
    reloaded.appendMessage(chat.id, { id: 'u3', role: 'user', content: 'new one', timestamp: 3, isComplete: true });

    const rows = lines(reloaded.transcriptPath(chat.id)!).map(l => JSON.parse(l));
    expect(rows.map(r => r.id)).toEqual(['u1', 'u2', 'u3']);
  });

  it('deletes the sidecar with the chat', () => {
    const chat = mgr.create({ workspaceName: 'ws' });
    mgr.appendMessage(chat.id, { id: 'u1', role: 'user', content: 'hi', timestamp: 1, isComplete: true });
    const file = mgr.transcriptPath(chat.id)!;
    expect(fs.existsSync(file)).toBe(true);

    mgr.delete(chat.id);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('returns an absolute path even for a relative workspaces root', () => {
    // Relative to cwd but still inside the temp dir, so nothing lands in the repo.
    const relativeRoot = path.relative(process.cwd(), root);
    expect(path.isAbsolute(relativeRoot)).toBe(false);

    const relative = new ChatManager(relativeRoot);
    const chat = relative.create({ workspaceName: 'ws' });
    const file = relative.transcriptPath(chat.id)!;
    expect(path.isAbsolute(file)).toBe(true);
    expect(file.startsWith(path.resolve(root))).toBe(true);
  });
});

describe('buildChatCatchupPrompt gap handling', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-transcript-gap-'));
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    mgr = new ChatManager(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function seed(count: number) {
    const chat = mgr.create({ workspaceName: 'ws' });
    for (let i = 0; i < count; i++) {
      mgr.appendMessage(chat.id, { id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `body ${i}`, timestamp: i, isComplete: true });
    }
    return chat.id;
  }

  it('still inlines a small gap', () => {
    const chatId = seed(6);
    const prompt = buildChatCatchupPrompt(mgr.get(chatId)!, 'm1', 'now what', undefined, {
      transcriptPath: mgr.transcriptPath(chatId),
    });
    expect(prompt).toContain('body 2');
    expect(prompt).toContain('body 5');
    expect(prompt).not.toContain('.jsonl');
  });

  it('points at the transcript instead of replaying a large gap', () => {
    const total = CATCHUP_INLINE_LIMIT + 30;
    const chatId = seed(total);
    const file = mgr.transcriptPath(chatId)!;

    const prompt = buildChatCatchupPrompt(mgr.get(chatId)!, 'm0', 'now what', undefined, {
      transcriptPath: file,
    });

    expect(prompt).toContain(file);
    expect(prompt).toContain(`${total - 1} messages`);
    // m0 is messages[0] -> line 1; the first unseen message is line 2.
    expect(prompt).toContain(`Lines 2-${total} are new`);
    expect(prompt).toContain('You last saw line 1.');
    expect(prompt).toContain('now what');
    // The bodies themselves must not be inlined — that is the whole point.
    expect(prompt).not.toContain('body 5');
  });

  it('names a cursor that maps back to the right sidecar line', () => {
    const total = CATCHUP_INLINE_LIMIT + 10;
    const chatId = seed(total);
    const file = mgr.transcriptPath(chatId)!;

    const prompt = buildChatCatchupPrompt(mgr.get(chatId)!, 'm3', 'go on', undefined, { transcriptPath: file });
    expect(prompt).toContain('You last saw line 4.');

    const rows = lines(file).map(l => JSON.parse(l));
    expect(rows[3].id).toBe('m3');
    expect(rows[4].id).toBe('m4');
  });

  it('falls back to inlining when no transcript path is supplied', () => {
    const chatId = seed(CATCHUP_INLINE_LIMIT + 30);
    const prompt = buildChatCatchupPrompt(mgr.get(chatId)!, 'm0', 'now what');
    expect(prompt).toContain('body 5');
    expect(prompt).not.toContain('.jsonl');
  });
});
