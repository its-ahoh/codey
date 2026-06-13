import { describe, it, expect, vi } from 'vitest';
import { generateTaskBrief, generateChatTitle } from './aide-tasks';
import type { Chat } from './types/chat';
import type { AideOptions } from './aide';

function makeChat(over: Partial<Chat> = {}): Chat {
  return {
    id: 'c1', title: 'Add OAuth', workspaceName: 'ws', selection: { type: 'none' },
    messages: [
      { id: 'm1', role: 'user', content: 'add google login', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'picked Google OAuth', timestamp: 2 },
    ],
    createdAt: 0, updatedAt: 2,
    ...over,
  } as Chat;
}

function optsReturning(json: string): AideOptions {
  return {
    agent: 'claude-code',
    runner: vi.fn(async () => ({ success: true, output: json })),
  } as unknown as AideOptions;
}

describe('generateTaskBrief', () => {
  it('parses a JSON brief from the Aide and fills generatedAt', async () => {
    const opts = optsReturning(JSON.stringify({
      goal: 'Add OAuth login',
      state: { progress: 60, stepLabel: '3 / 5', status: 'waiting' },
      nextAction: { text: 'Delete /api/login?' },
      timeline: [{ kind: 'decision', text: 'Use Google', why: 'ubiquitous' }],
    }));
    const brief = await generateTaskBrief(makeChat(), opts);
    expect(brief.goal).toBe('Add OAuth login');
    expect(brief.state.progress).toBe(60);
    expect(brief.nextAction?.text).toBe('Delete /api/login?');
    expect(brief.timeline).toHaveLength(1);
    expect(brief.generatedAt).toBeGreaterThan(0);
  });

  it('falls back to chat title as goal when the Aide returns junk', async () => {
    const brief = await generateTaskBrief(makeChat({ title: 'My Task' }), optsReturning('not json'));
    expect(brief.goal).toBe('My Task');
    expect(brief.timeline).toEqual([]);
  });
});

describe('generateChatTitle', () => {
  it('strips a leaked fallback banner so it never becomes the title', async () => {
    // Regression: the Aide reuses the fallback-routed runner, so a fallback
    // could prepend "[Fallback: …]\n\n" to its output. sanitizeTitle must not
    // take that banner line as the title.
    const banner = '[Fallback: claude-code(opus) → opencode(deepseek)]\n\nRefactor auth module';
    const title = await generateChatTitle('refactor the auth module', optsReturning(banner));
    expect(title).toBe('Refactor auth module');
  });

  it('returns the clean title when no banner is present', async () => {
    const title = await generateChatTitle('add google login', optsReturning('Add Google login'));
    expect(title).toBe('Add Google login');
  });
});
