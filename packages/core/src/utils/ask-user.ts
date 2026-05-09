export interface AskUser {
  /** Worker output before the marker line (joined with \n, trimmed of trailing whitespace). */
  preamble: string;
  /** The question text after `[ASK_USER]:`, trimmed. */
  question: string;
}

export interface AskTeam {
  preamble: string;
  /** The teammate the asking worker has nominated to answer. */
  target: string;
  question: string;
}

export type AskMarker =
  | ({ kind: 'user' } & AskUser)
  | ({ kind: 'team' } & AskTeam);

const USER_MARKER_RE = /^\s*\[ASK_USER\]\s*:\s*(.*)$/;
const TEAM_MARKER_RE = /^\s*\[ASK\s*:\s*([^\]]+?)\s*\]\s*:\s*(.*)$/;

/**
 * Detect a `[ASK_USER]: <question>` marker line in worker output.
 * Returns null when no marker is present or the question is blank.
 */
export function parseAskUser(output: string): AskUser | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(USER_MARKER_RE);
    if (!m) continue;
    const question = m[1].trim();
    if (!question) return null;
    const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    return { preamble, question };
  }
  return null;
}

/**
 * Detect either a `[ASK_USER]: q` or `[ASK: <teammate>]: q` marker line.
 * Returns the first marker found (in document order) or null.
 */
export function parseAsk(output: string): AskMarker | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const userMatch = line.match(USER_MARKER_RE);
    if (userMatch) {
      const question = userMatch[1].trim();
      if (!question) return null;
      const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
      return { kind: 'user', preamble, question };
    }
    const teamMatch = line.match(TEAM_MARKER_RE);
    if (teamMatch) {
      const target = teamMatch[1].trim();
      const question = teamMatch[2].trim();
      if (!target || !question) continue;
      const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
      return { kind: 'team', target, preamble, question };
    }
  }
  return null;
}
