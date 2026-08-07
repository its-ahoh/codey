/**
 * Turns an agent's text reply into something suitable to read aloud over TTS.
 * Long or detail-heavy replies (diffs, stack traces, file listings) read
 * poorly verbatim, so 'auto'/'digest' verbosity routes them through a
 * summarization prompt instead of speaking every character.
 */

export type SpeechVerbosity = 'full' | 'digest' | 'auto';

/** Replies at or under this length are always spoken verbatim in 'auto' mode. */
export const AUTO_DIGEST_THRESHOLD = 400;

/**
 * Decides whether `text` needs to go through digest summarization before
 * being spoken, given the configured verbosity.
 */
export function needsDigest(text: string, verbosity: SpeechVerbosity): boolean {
  if (verbosity === 'full') return false;
  if (verbosity === 'digest') return text.trim().length > 0;
  return text.length > AUTO_DIGEST_THRESHOLD;
}

/**
 * Builds a prompt asking an LLM to condense `text` into a short, spoken-form
 * gist. Mirrors the plain prompt-builder pattern used for the advisor
 * (see solo-advisor.ts) — the caller is responsible for actually running it
 * through an agent/model and speaking the result.
 */
export function buildSpeechDigestPrompt(text: string): string {
  return [
    '# Speech Digest',
    'Rewrite the following reply as a short spoken summary — the kind you would say out loud to someone, not read verbatim.',
    'Keep the outcome and any decision or number the user needs, drop file paths, code blocks, stack traces, and step-by-step detail.',
    'Two or three sentences. No markdown, no bullet points, no headers — plain spoken prose only.',
    'Write the summary in the same language as the reply below — do not translate it.',
    '## Reply to condense',
    text,
    '## Spoken summary',
  ].join('\n\n');
}

/**
 * Strips the parts of a reply that exist for the eye, so a text-to-speech
 * voice doesn't read them out: fenced code, inline backticks, link syntax,
 * heading and list markers, emphasis, and bare file paths.
 *
 * Used on the raw reply whenever it's spoken undigested. Reading Markdown
 * verbatim is the failure mode this whole layer exists to prevent — the
 * screen already has the full text; speech only has to carry the meaning.
 */
export function stripForSpeech(text: string): string {
  return text
    // Fenced blocks: say that code exists rather than spelling it out.
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/~~~[\s\S]*?~~~/g, ' (code) ')
    .replace(/`([^`]*)`/g, '$1')
    // Images before links — the alt text is rarely worth speaking.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    // Table pipes and horizontal rules read as noise.
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*([-*_])\s*(\1\s*){2,}$/gm, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    // Paths and URLs: unreadable aloud, and never the point of the sentence.
    .replace(/https?:\/\/\S+/g, ' (link) ')
    .replace(/(?:^|\s)[\w.~-]*\/[\w./~-]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
