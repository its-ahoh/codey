import { describe, it, expect } from 'vitest';
import { Chat, ChatMessage } from '@codey/core';
import {
  buildChatBootstrapPrompt,
  buildQuickQuestionPrompt,
  BOOTSTRAP_INLINE_LIMIT,
  BOOTSTRAP_TAIL_INLINE,
} from './chat-runner';

const PATH = '/tmp/ws/chats/abc.jsonl';

function chatWith(count: number, extra?: Partial<Chat>): Chat {
  const messages: ChatMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `body ${i + 1}`,
    timestamp: i,
    isComplete: true,
  }));
  return {
    id: 'abc',
    workspaceName: 'ws',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    messages,
    selection: { type: 'agent' },
    ...extra,
  } as Chat;
}

describe('buildChatBootstrapPrompt — transcript pointer', () => {
  it('inlines everything when the history is short', () => {
    const prompt = buildChatBootstrapPrompt(chatWith(BOOTSTRAP_INLINE_LIMIT), 'next', undefined, 40,
      { transcriptPath: PATH });
    expect(prompt).not.toContain(PATH);
    expect(prompt).toContain('body 1');
    expect(prompt).toContain(`body ${BOOTSTRAP_INLINE_LIMIT}`);
  });

  it('inlines everything when no transcript path is available', () => {
    const prompt = buildChatBootstrapPrompt(chatWith(100), 'next', undefined, 40);
    expect(prompt).not.toContain('not inlined');
    expect(prompt).toContain('body 100');
  });

  it('points at the transcript once the history is long', () => {
    const prompt = buildChatBootstrapPrompt(chatWith(100), 'next', undefined, 40,
      { transcriptPath: PATH });
    expect(prompt).toContain(PATH);
    expect(prompt).toContain(`Lines 1-${100 - BOOTSTRAP_TAIL_INLINE} hold this history.`);
    expect(prompt).toContain(`sed -n '1,${100 - BOOTSTRAP_TAIL_INLINE}p'`);
    expect(prompt).toContain('96 messages, not inlined');
  });

  it('still inlines the recent tail in pointer mode', () => {
    const prompt = buildChatBootstrapPrompt(chatWith(100), 'next', undefined, 40,
      { transcriptPath: PATH });
    for (let i = 100 - BOOTSTRAP_TAIL_INLINE + 1; i <= 100; i++) {
      expect(prompt).toContain(`body ${i}`);
    }
    expect(prompt).not.toContain(`body ${100 - BOOTSTRAP_TAIL_INLINE}\n`);
  });

  it('starts the pointer after a compaction summary instead of at line 1', () => {
    const chat = chatWith(100, {
      compaction: { summary: 'earlier stuff', summarizedUpTo: 30, model: 'm', updatedAt: 0 },
    } as Partial<Chat>);
    const prompt = buildChatBootstrapPrompt(chat, 'next', undefined, 40, { transcriptPath: PATH });
    expect(prompt).toContain('earlier stuff');
    expect(prompt).toContain(`Lines 31-${100 - BOOTSTRAP_TAIL_INLINE} hold this history.`);
  });

  it('reaches back further than the inline window would have', () => {
    // windowSize 40 would have shown messages 61-100; the pointer offers 1-96.
    const prompt = buildChatBootstrapPrompt(chatWith(100), 'next', undefined, 40,
      { transcriptPath: PATH });
    expect(prompt).toContain('Lines 1-96');
  });

  it('keeps the new user message last', () => {
    const prompt = buildChatBootstrapPrompt(chatWith(100), 'the ask', undefined, 40,
      { transcriptPath: PATH });
    expect(prompt.trimEnd().endsWith('[Respond to this new user message]\nthe ask')).toBe(true);
  });

  it('shrinks the prompt substantially versus inlining', () => {
    const chat = chatWith(100);
    chat.messages.forEach(m => { m.content = 'y'.repeat(2000); });
    const inlined = buildChatBootstrapPrompt(chat, 'next', undefined, 40);
    const pointed = buildChatBootstrapPrompt(chat, 'next', undefined, 40, { transcriptPath: PATH });
    expect(pointed.length).toBeLessThan(inlined.length / 5);
  });

  it('does not point when the tail alone covers the history', () => {
    const chat = chatWith(100, {
      compaction: { summary: 's', summarizedUpTo: 97, model: 'm', updatedAt: 0 },
    } as Partial<Chat>);
    const prompt = buildChatBootstrapPrompt(chat, 'next', undefined, 40, { transcriptPath: PATH });
    expect(prompt).not.toContain(PATH);
  });
});

describe('buildQuickQuestionPrompt — transcript pointer', () => {
  it('points at the transcript for a long parent chat', () => {
    const prompt = buildQuickQuestionPrompt(chatWith(100), [], 'q?', undefined, 40,
      { transcriptPath: PATH });
    expect(prompt).toContain(PATH);
    expect(prompt).toContain('read-only reference');
  });
});
