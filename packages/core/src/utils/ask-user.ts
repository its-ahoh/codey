export interface AskUser {
  /** Worker output before the marker line (joined with \n, trimmed of trailing whitespace). */
  preamble: string;
  /** The question text after `[ASK_USER]:`, trimmed. */
  question: string;
}

const MARKER_RE = /^\s*\[ASK_USER\]\s*:\s*(.*)$/;

/**
 * Detect a `[ASK_USER]: <question>` marker line in worker output.
 * Returns null when no marker is present or the question is blank.
 */
export function parseAskUser(output: string): AskUser | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_RE);
    if (!m) continue;
    const question = m[1].trim();
    if (!question) return null;
    const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    return { preamble, question };
  }
  return null;
}
