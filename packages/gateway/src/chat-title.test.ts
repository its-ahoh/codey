import { describe, expect, it, vi } from 'vitest';
import { openingChatTitle } from './chat-title';

describe('Opening title reuse', () => {
  it('uses a short classified title without asking the model', async () => {
    const generate = vi.fn();
    expect(await openingChatTitle(' Release notes ', generate)).toBe('Release notes');
    expect(generate).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'x'.repeat(41), 'Notes\nDetails'])('retains title generation for unsuitable input %j', async title => {
    const generate = vi.fn().mockResolvedValue('Notes');
    expect(await openingChatTitle(title, generate)).toBe('Notes');
    expect(generate).toHaveBeenCalledOnce();
  });
});
