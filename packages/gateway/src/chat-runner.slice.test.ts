import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Chat, ChatMessage, writeTranscriptSlice } from '@codey/core';
import { buildChatBootstrapPrompt, buildChatCatchupPrompt } from './chat-runner';

function chatWith(count: number): Chat {
  const messages: ChatMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `body ${i + 1}`,
    timestamp: i,
    isComplete: true,
  }));
  return {
    id: 'abc', workspaceName: 'ws', title: 't', createdAt: 0, updatedAt: 0,
    messages, selection: { type: 'none' },
  } as Chat;
}

describe('chat prompts with a slice writer', () => {
  let dir: string;
  let source: string;
  let chat: Chat;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chat-slice-'));
    source = path.join(dir, 'abc.jsonl');
    chat = chatWith(100);
    fs.writeFileSync(
      source,
      chat.messages.map(m => JSON.stringify({ id: m.id, role: m.role, content: m.content })).join('\n') + '\n',
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const delivery = () => ({
    transcriptPath: source,
    writeSlice: (first: number, last: number) => writeTranscriptSlice(source, first, last),
  });

  function sliceRows(): any[] {
    const file = path.join(dir, '.slices', 'abc.slice.jsonl');
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('bootstrap hands over a file holding exactly the un-inlined messages', () => {
    const prompt = buildChatBootstrapPrompt(chat, 'next', undefined, 40, delivery());
    expect(prompt).toContain(path.join(dir, '.slices', 'abc.slice.jsonl'));
    expect(prompt).toContain('Read the whole file');
    expect(prompt).not.toContain('sed -n');
    const rows = sliceRows();
    expect(rows).toHaveLength(96);
    expect(rows[0].id).toBe('m1');
    expect(rows[95].id).toBe('m96');
  });

  it('bootstrap keeps the recent tail inline and out of the slice', () => {
    const prompt = buildChatBootstrapPrompt(chat, 'next', undefined, 40, delivery());
    expect(prompt).toContain('body 100');
    expect(sliceRows().some(r => r.id === 'm97')).toBe(false);
  });

  it('catch-up slices only what the returning agent missed', () => {
    const prompt = buildChatCatchupPrompt(chat, 'm40', 'next', undefined, delivery());
    expect(prompt).toContain('since this agent was last active');
    const rows = sliceRows();
    expect(rows).toHaveLength(60);
    expect(rows[0].id).toBe('m41');
    expect(rows[59].id).toBe('m100');
  });

  it('carries an inline skeleton alongside the file', () => {
    const prompt = buildChatBootstrapPrompt(chat, 'next', undefined, 40, delivery());
    expect(prompt).toContain('Skeleton of the same messages');
    expect(prompt).toContain('1 [user] body 1');
  });

  it('falls back to naming the line range when the sidecar is unreadable', () => {
    const prompt = buildChatBootstrapPrompt(chat, 'next', undefined, 40, {
      transcriptPath: source,
      writeSlice: () => writeTranscriptSlice(path.join(dir, 'gone.jsonl'), 1, 96),
    });
    expect(prompt).toContain('sed -n');
    expect(prompt).toContain('Lines 1-96 hold this history.');
  });

  it('keeps the new user message last in both shapes', () => {
    for (const prompt of [
      buildChatBootstrapPrompt(chat, 'the ask', undefined, 40, delivery()),
      buildChatCatchupPrompt(chat, 'm40', 'the ask', undefined, delivery()),
    ]) {
      expect(prompt.trimEnd().endsWith('[Respond to this new user message]\nthe ask')).toBe(true);
    }
  });

  it('costs far fewer prompt bytes than inlining the same history', () => {
    const big = chatWith(100);
    big.messages.forEach(m => { m.content = 'y'.repeat(2000); });
    fs.writeFileSync(
      source,
      big.messages.map(m => JSON.stringify({ id: m.id, role: m.role, content: m.content })).join('\n') + '\n',
    );
    const inlined = buildChatBootstrapPrompt(big, 'next', undefined, 40);
    const sliced = buildChatBootstrapPrompt(big, 'next', undefined, 40, delivery());
    expect(sliced.length).toBeLessThan(inlined.length / 5);
  });
});
