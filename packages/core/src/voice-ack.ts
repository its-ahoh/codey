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
 * A full sentence rather than two words: this is the only thing said during a
 * turn that can run for minutes, and a clipped "On it." leaves the silence
 * after it sounding like a dropped call.
 */
export const VOICE_ACKS_EN = [
  'Working on it now, give me a moment.',
  'Let me take a look and get back to you.',
  'I\'ll dig into that and report back.',
  'Starting on it now, this may take a minute.',
  'Let me check, and I\'ll tell you what I find.',
  'I\'m on it, hang tight for a moment.',
  'Taking a look at that right now.',
  'Let me work through it and come back to you.',
  'I\'ll get to that now, one moment.',
  'Looking into it, back with you shortly.',
];

export const VOICE_ACKS_ZH = [
  '我这就去处理，稍等一下', // lint-allow-non-english
  '我看一下，马上给你结果', // lint-allow-non-english
  '让我查一查，很快就好', // lint-allow-non-english
  '这就开始弄，需要点时间', // lint-allow-non-english
  '我先去看看情况，稍等', // lint-allow-non-english
  '我来处理这件事，请稍候', // lint-allow-non-english
  '这个我来看，马上就来', // lint-allow-non-english
  '我去确认一下，等我消息', // lint-allow-non-english
  '现在就动手，稍微等一会', // lint-allow-non-english
  '我来跟进这件事，稍等片刻', // lint-allow-non-english
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
