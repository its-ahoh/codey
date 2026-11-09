import { describe, expect, it } from 'vitest';
import type { Chat, ChatMessage } from '@codey/core';
import { buildChatPrompt, buildChatResumePrompt, buildChatCatchupPrompt } from './chat-runner';

const msg = (id: string, role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content, timestamp: 0, ...extra });

// A failed turn's visible error must not become context for the next turn.
const chat = {
  id: 'c', messages: [
    msg('u1', 'user', 'Plan the release'),
    msg('a1', 'assistant', 'REAL ANSWER'),
    msg('u2', 'user', 'Now ship it'),
    msg('a2', 'assistant', '❌ Error: Authentication required', { failed: true }),
  ],
} as unknown as Chat;

describe('failed turns stay out of agent context', () => {
  it('uses the last real answer as the resume checkpoint', () => {
    const prompt = buildChatResumePrompt(chat, 'Try again');
    expect(prompt).toContain('REAL ANSWER');
    expect(prompt).not.toContain('Authentication required');
  });

  it('drops failed replies from the history transcript', () => {
    const prompt = buildChatPrompt(chat, 'Try again');
    expect(prompt).toContain('Now ship it');
    expect(prompt).not.toContain('Authentication required');
  });

  it('drops failed replies from a catch-up replay', () => {
    const prompt = buildChatCatchupPrompt(chat, 'a1', 'Try again');
    expect(prompt).toContain('Now ship it');
    expect(prompt).not.toContain('Authentication required');
  });
});
