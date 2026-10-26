import { describe, it, expect } from 'vitest';
import { mediaOutputInstruction } from './media-prompt';

describe('mediaOutputInstruction', () => {
  it('always explains the image syntax', () => {
    for (const linked of [true, false]) {
      expect(mediaOutputInstruction(linked)).toContain('![short description](path/to/file.png)');
    }
  });

  it('asks channel-linked chats for PNG instead of mermaid', () => {
    const s = mediaOutputInstruction(true);
    expect(s).toContain('PNG');
    expect(s).toContain('do not use mermaid');
  });

  it('offers mermaid to Mac-only chats', () => {
    const s = mediaOutputInstruction(false);
    expect(s).toContain('```mermaid');
    expect(s).not.toContain('do not use mermaid');
  });
});
