import { describe, it, expect } from 'vitest';
import { pickVoiceAck, voiceAckList, VOICE_ACKS_EN, VOICE_ACKS_ZH } from './voice-ack';

describe('voiceAckList', () => {
  it('answers in the language that was spoken', () => {
    expect(voiceAckList('check the merge conflicts for me')).toBe(VOICE_ACKS_EN);
    expect(voiceAckList('帮我检查一下冲突')).toBe(VOICE_ACKS_ZH); // lint-allow-non-english
  });

  it('treats a mixed sentence as Chinese', () => {
    // Speaking Chinese with an English noun in it is the common case, and the
    // ack should not switch languages because you said "merge".
    expect(voiceAckList('帮我看看 merge 冲突')).toBe(VOICE_ACKS_ZH); // lint-allow-non-english
  });

  it('falls back to English for a language with no list', () => {
    expect(voiceAckList('merci de regarder ce bug')).toBe(VOICE_ACKS_EN);
  });
});

describe('pickVoiceAck', () => {
  it('picks from the matching list', () => {
    expect(VOICE_ACKS_EN).toContain(pickVoiceAck('why did the hotkey stop working'));
    expect(VOICE_ACKS_ZH).toContain(pickVoiceAck('热键为什么不响应了')); // lint-allow-non-english
  });

  it('never repeats the previous phrase', () => {
    const previous = VOICE_ACKS_EN[0];
    // Draw with a generator that would otherwise land on index 0 every time.
    for (let i = 0; i < VOICE_ACKS_EN.length; i++) {
      expect(pickVoiceAck('take a look', { previous, random: () => 0 })).not.toBe(previous);
    }
  });

  it('spreads across the whole list', () => {
    const seen = new Set(
      VOICE_ACKS_EN.map((_, i) => pickVoiceAck('take a look', { random: () => i / VOICE_ACKS_EN.length })),
    );
    expect(seen.size).toBe(VOICE_ACKS_EN.length);
  });

  it('stays in range when random returns its exclusive upper bound', () => {
    expect(VOICE_ACKS_EN).toContain(pickVoiceAck('take a look', { random: () => 1 }));
  });

  it('still answers when the previous phrase is the only one there is', () => {
    // Guards the degenerate case: filtering must never leave an empty pool.
    const only = VOICE_ACKS_EN[3];
    expect(pickVoiceAck('take a look', { previous: only })).not.toBe(only);
  });
});
