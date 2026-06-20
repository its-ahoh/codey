const INVOKE_ASK_USER_RE = /<invoke\s+name="AskUserQuestion">\s*<parameter\s+name="questions">([\s\S]*?)<\/parameter>\s*<\/invoke>/g;

/**
 * Convert hallucinated `<invoke name="AskUserQuestion">` XML blocks emitted by
 * worker LLMs into `[ASK_USER:choice]` markers so the normal parsing path handles them.
 */
export function normalizeWorkerOutput(output: string): string {
  if (!output.includes('<invoke name="AskUserQuestion">')) return output;
  return output.replace(INVOKE_ASK_USER_RE, (_, rawJson) => {
    try {
      const questions: any[] = JSON.parse(rawJson.trim());
      if (!Array.isArray(questions) || questions.length === 0) return '';
      const q = questions[0];
      const question = String(q.question ?? '').trim();
      if (!question) return '';
      const opts: string[] = Array.isArray(q.options)
        ? q.options
            .map((o: any) => (typeof o === 'string' ? o : String(o.label ?? '')).trim())
            .filter(Boolean)
        : [];
      if (opts.length >= 2) return `[ASK_USER:choice]: ${question} | ${opts.join(' | ')}`;
      return `[ASK_USER]: ${question}`;
    } catch {
      return '';
    }
  });
}

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
  const lines = normalizeWorkerOutput(output).split(/\r?\n/);
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
  const lines = normalizeWorkerOutput(output).split(/\r?\n/);
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

const ADVISOR_MARKER_RE = /^\s*\[ASK_ADVISOR\]\s*:\s*(.*)$/;

export interface AskAdvisor {
  /** Agent output before the marker line (joined with \n, trailing ws trimmed). */
  preamble: string;
  /** The text after `[ASK_ADVISOR]:` describing where the agent is stuck. */
  reason: string;
}

/**
 * Detect a `[ASK_ADVISOR]: <reason>` marker line in a single agent's output.
 * Returns the first marker (in document order) or null when absent/blank.
 */
export function parseAskAdvisor(output: string): AskAdvisor | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ADVISOR_MARKER_RE);
    if (!m) continue;
    const reason = m[1].trim();
    if (!reason) continue;
    const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    return { preamble, reason };
  }
  return null;
}

/** Remove every `[ASK_ADVISOR]: ...` marker line from output (trailing ws trimmed). */
export function stripAskAdvisor(output: string): string {
  if (!output) return output;
  return output
    .split(/\r?\n/)
    .filter(l => !ADVISOR_MARKER_RE.test(l))
    .join('\n')
    .replace(/\s+$/, '');
}
