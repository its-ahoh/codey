import { AgentRequest, AgentResponse, CodingAgent, ModelConfig } from './types';
import { MANAGER_PERSONALITY } from './manager-personality';

export interface ManagerMember {
  name: string;
  hint: string;
}

export interface ManagerHistoryEntry {
  worker: string;
  summary: string;
}

export interface ManagerInput {
  task: string;
  members: ManagerMember[];
  history: ManagerHistoryEntry[];
  lastWorker: string | null;
  lastOutput: string | null;
  /** When true, return only done:true with a final_summary; do not pick next. */
  finalize?: boolean;
  /** Set on the turn immediately after a paused run resumes. */
  userClarification?: { worker: string; question: string; answer: string };
  /**
   * Set when a worker emitted `[ASK_USER]: q` and the Manager must decide
   * whether to route the question to a teammate or escalate to the user.
   */
  pendingQuestion?: { worker: string; question: string };
}

export interface ManagerTurn {
  summary_of_last: string;
  next: string | null;
  instruction: string;
  reason: string;
  done: boolean;
  final_summary?: string;
  fallback: boolean;
  fallbackReason?: string;
  /** Set by the Manager to escalate the pending question to the user. */
  escalateToUser?: boolean;
}

export type ManagerRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface ManagerOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: ManagerRunner;
  /** Hard timeout in ms. Default 30_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildManagerPrompt(input: ManagerInput): string {
  const lines: string[] = [];
  lines.push('# Manager');
  lines.push('## Role');
  lines.push(MANAGER_PERSONALITY.role);
  lines.push('## Instructions');
  lines.push(MANAGER_PERSONALITY.instructions);
  lines.push('## Task');
  lines.push(input.task);
  lines.push('## Roster');
  for (const m of input.members) {
    lines.push(`- ${m.name}: ${m.hint || '(no description)'}`);
  }
  lines.push('## History');
  if (input.history.length === 0) {
    lines.push('(empty — this is the first turn)');
  } else {
    input.history.forEach((h, i) => {
      lines.push(`${i + 1}. ${h.worker}: ${h.summary}`);
    });
  }
  lines.push('## Last Output');
  if (input.lastWorker && input.lastOutput) {
    lines.push(`Worker: ${input.lastWorker}`);
    lines.push('Output:');
    lines.push(input.lastOutput);
  } else {
    lines.push('(none — first turn)');
  }
  if (input.userClarification) {
    const u = input.userClarification;
    lines.push('## User Clarification');
    lines.push(`Worker ${u.worker} asked: ${u.question}`);
    lines.push(`User answered: ${u.answer}`);
  }
  if (input.pendingQuestion) {
    const q = input.pendingQuestion;
    lines.push('## Pending Question');
    lines.push(`Worker ${q.worker} asked: ${q.question}`);
    lines.push(
      'Decide one of: (a) route this to a teammate from the Roster who can answer — set `next` to that teammate and put the question in `instruction`; or (b) escalate to the user — set `escalate_to_user: true` and `done: true` with no `next`. Prefer (a) when a teammate plausibly has the answer.',
    );
  }
  if (input.finalize) {
    lines.push('## Finalize');
    lines.push('FINALIZE=true. Return only done:true with a final_summary; do not pick a next worker.');
  }
  return lines.join('\n\n');
}

/**
 * Extract the first balanced {...} object from a string and JSON.parse it.
 * Tolerates leading/trailing prose, markdown fences, and nested objects.
 */
export function extractJsonObject(text: string): unknown | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

function fallback(reason: string): ManagerTurn {
  return {
    summary_of_last: '',
    next: null,
    instruction: '',
    reason: '',
    done: false,
    fallback: true,
    fallbackReason: reason,
  };
}

export async function runManager(
  input: ManagerInput,
  opts: ManagerOptions,
): Promise<ManagerTurn> {
  if (input.members.length === 0) {
    return {
      summary_of_last: '',
      next: null,
      instruction: '',
      reason: '',
      done: true,
      final_summary: '',
      fallback: false,
    };
  }

  const prompt = buildManagerPrompt(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ac = new AbortController();
  const onUserAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response: AgentResponse;
  try {
    response = await opts.runner({
      prompt,
      agent: opts.agent,
      model: opts.model,
      signal: ac.signal,
    });
  } catch (err) {
    return fallback(`runner threw: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort);
  }

  if (!response.success) {
    return fallback(response.error || 'runner returned non-success');
  }

  const obj = extractJsonObject(response.output) as
    | {
        summary_of_last?: unknown;
        next?: unknown;
        instruction?: unknown;
        reason?: unknown;
        done?: unknown;
        final_summary?: unknown;
        escalate_to_user?: unknown;
      }
    | null;
  if (!obj) return fallback('no JSON object in manager output');

  const summary_of_last = typeof obj.summary_of_last === 'string' ? obj.summary_of_last : '';
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  const instruction = typeof obj.instruction === 'string' ? obj.instruction : '';
  const done = obj.done === true;
  const final_summary = typeof obj.final_summary === 'string' ? obj.final_summary : undefined;
  const escalateToUser = obj.escalate_to_user === true;

  let next: string | null = null;
  if (obj.next === null || obj.next === undefined) {
    next = null;
  } else if (typeof obj.next === 'string' && obj.next.trim().length > 0) {
    next = obj.next.trim();
  } else {
    return fallback('next is not a string or null');
  }

  if (next !== null) {
    const known = new Set(input.members.map(m => m.name));
    if (!known.has(next)) return fallback(`next "${next}" is not in roster`);
  }

  if (input.finalize) {
    return {
      summary_of_last,
      next: null,
      instruction: '',
      reason,
      done: true,
      final_summary: final_summary ?? '',
      fallback: false,
    };
  }

  // When the Manager is arbitrating a pending question, escalate_to_user is a
  // valid resolution: done=true, no next, and we surface the question to the user.
  if (input.pendingQuestion && escalateToUser) {
    return {
      summary_of_last,
      next: null,
      instruction: '',
      reason,
      done: true,
      final_summary,
      fallback: false,
      escalateToUser: true,
    };
  }

  if (!done && next === null) {
    return fallback('next is null but done is false');
  }

  if (done && next !== null) {
    // Treat done:true as authoritative; ignore next.
    return {
      summary_of_last,
      next: null,
      instruction: '',
      reason,
      done: true,
      final_summary: final_summary ?? '',
      fallback: false,
    };
  }

  return {
    summary_of_last,
    next,
    instruction: next !== null ? instruction : '',
    reason,
    done,
    final_summary,
    fallback: false,
  };
}
