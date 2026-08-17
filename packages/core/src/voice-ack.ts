/**
 * The spoken "heard you, working on it" that lands right after a voice turn
 * is sent.
 *
 * Written rather than generated. A model-written acknowledgement referred to
 * what you had just asked, which sounds better on paper, but it put a model
 * call on the one part of the turn that has to be instant: every second of
 * silence after you stop talking reads as the thing having died. In practice
 * the call routinely timed out and fell back to a single fixed line, so the
 * feature's actual behaviour was a repeated stock phrase with a delay in
 * front of it. A list of stock phrases with no delay is the same content,
 * sooner — and rotating them removes the parrot effect that made the repeat
 * grating in the first place.
 */

/**
 * Spoken acknowledgements, chosen at random per turn.
 *
 * No agreement opener ("Sure", "Got it", and their Chinese equivalents) on
 * any of them. An opener answers the request as if it were a proposal, which
 * only fits half the turns: reply "Sure" to a question and it lands wrong.
 * What survives is the part that is true of every turn — that the thing is
 * now being worked on.
 *
 * One complete sentence, and no more than one. A bare fragment ("Checking.")
 * is over before the ear settles on it and leaves the wait sounding like a
 * dropped call; a sentence with a second, reassuring clause tacked on
 * ("...and I'll get back to you", "...hang tight for a moment") spends words
 * on nothing the first clause had not already said. What is left is a short
 * sentence that stands on its own.
 */
export const VOICE_ACKS_EN = [
  'Let me take a look.',
  'I\'m on it now.',
  'Working on that now.',
  'Let me check on that.',
  'I\'ll dig into that.',
  'Starting on it now.',
  'Let me go find out.',
  'I\'ll get that sorted.',
  'Taking a look right now.',
  'Give me a moment on that.',
];

export const VOICE_ACKS_ZH = [
  '我这就去看看', // lint-allow-non-english
  '让我来查一下', // lint-allow-non-english
  '这就开始处理', // lint-allow-non-english
  '我去确认一下', // lint-allow-non-english
  '这个我来看看', // lint-allow-non-english
  '我现在就动手', // lint-allow-non-english
  '让我先了解一下', // lint-allow-non-english
  '我这就去弄', // lint-allow-non-english
  '稍等，我看一下', // lint-allow-non-english
  '我来跟进一下', // lint-allow-non-english
];

/**
 * Answers in the language that was spoken. Han characters are the only signal
 * needed here: the two lists are the two languages the acknowledgement exists
 * in, and anything else gets the English one, as the reply itself does when no
 * matching voice is installed.
 */
export function voiceAckList(transcript: string): string[] {
  return /[\u4e00-\u9fff]/.test(transcript) ? VOICE_ACKS_ZH : VOICE_ACKS_EN;
}

export interface VoiceAckOptions {
  /**
   * The phrase used last time, excluded from this draw. Back-to-back repeats
   * are the one thing a rotation is meant to avoid, and with ten phrases
   * chance alone still produces them often enough to notice.
   */
  previous?: string;
  /** Injectable for tests. */
  random?: () => number;
}

/** Picks an acknowledgement for `transcript`, avoiding `previous`. */
export function pickVoiceAck(transcript: string, options: VoiceAckOptions = {}): string {
  const all = voiceAckList(transcript);
  const choices = all.filter(phrase => phrase !== options.previous);
  const pool = choices.length > 0 ? choices : all;
  const random = options.random ?? Math.random;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index];
}
