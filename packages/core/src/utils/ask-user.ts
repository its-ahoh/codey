export interface AskUser {
  /** Worker output before the marker line (joined with \n, trimmed of trailing whitespace). */
  preamble: string;
  /** The question text after `[ASK_USER]:` (or `[ASK_USER:choice]:` before the first `|`). */
  question: string;
  /** Present only when the marker was `[ASK_USER:choice]:` with >= 2 valid options. */
  options?: string[];
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

const USER_MARKER_RE = /^\s*\[ASK_USER(:choice)?\]\s*:\s*(.*)$/;
const TEAM_MARKER_RE = /^\s*\[ASK\s*:\s*([^\]]+?)\s*\]\s*:\s*(.*)$/;

const MAX_OPTIONS = 8;

function splitChoicePayload(payload: string): { question: string; options?: string[] } {
  const parts = payload.split('|').map(s => s.trim());
  const question = parts.shift() ?? '';
  const options = parts.filter(p => p.length > 0).slice(0, MAX_OPTIONS);
  if (options.length < 2) return { question: payload.trim() };
  return { question, options };
}

/**
 * Detect a `[ASK_USER]: <question>` or `[ASK_USER:choice]: <question> | <option1> | <option2>...` marker line in worker output.
 * Returns null when no marker is present or the question is blank.
 */
export function parseAskUser(output: string): AskUser | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(USER_MARKER_RE);
    if (!m) continue;
    const isChoice = !!m[1];
    const payload = m[2];
    const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    if (isChoice) {
      const { question, options } = splitChoicePayload(payload);
      if (!question) return null;
      return options ? { preamble, question, options } : { preamble, question };
    }
    const question = payload.trim();
    if (!question) return null;
    return { preamble, question };
  }
  return null;
}

/**
 * Detect either a `[ASK_USER]: q`, `[ASK_USER:choice]: q | a | b`, or `[ASK: <teammate>]: q` marker line.
 * Returns the first marker found (in document order) or null.
 */
export function parseAsk(output: string): AskMarker | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(USER_MARKER_RE);
    if (m) {
      const isChoice = !!m[1];
      const payload = m[2];
      const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
      if (isChoice) {
        const { question, options } = splitChoicePayload(payload);
        if (!question) return null;
        return options
          ? { kind: 'user', preamble, question, options }
          : { kind: 'user', preamble, question };
      }
      const question = payload.trim();
      if (!question) return null;
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
