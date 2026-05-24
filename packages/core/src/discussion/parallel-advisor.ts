import { extractJsonObject } from '../advisor';

export interface ParallelManagerInput {
  topic: string;
  summary: string;
  opinions: Array<{ name: string; text: string }>;
  pendingAsks: Array<{ worker: string; question: string }>;
  idleMs: number;
  revision: number;
  userAnswer?: { question: string; answer: string };
}

export type ParallelAction = 'continue' | 'ask_user' | 'finalize' | 'terminate';
export type ParallelReason = 'continuing' | 'pending_question' | 'consensus' | 'drift' | 'idle' | 'manager_error';

export interface ParallelManagerTurn {
  action: ParallelAction;
  summary_update?: string;
  directive?: string;
  route_to?: string;
  user_question?: string;
  user_question_choices?: string[];
  final_message?: string;
  reason: ParallelReason;
}

const VALID_ACTIONS: readonly ParallelAction[] = ['continue', 'ask_user', 'finalize', 'terminate'];
const VALID_REASONS: readonly ParallelReason[] = ['continuing', 'pending_question', 'consensus', 'drift', 'idle', 'manager_error'];

export function buildParallelManagerPrompt(input: ParallelManagerInput): string {
  const lines: string[] = [];
  lines.push('# Role');
  lines.push('You are the Manager of a parallel roundtable discussion. Multiple workers are appending opinions in parallel. Read the current state, optionally update the shared summary, and decide what happens next.');

  lines.push('## Topic');
  lines.push(input.topic);

  lines.push('## Current Summary');
  lines.push(input.summary || '(empty)');

  lines.push('## Opinions');
  if (input.opinions.length === 0) {
    lines.push('(no opinions yet)');
  } else {
    for (const op of input.opinions) {
      lines.push(`### ${op.name}`);
      lines.push(op.text || '(empty)');
    }
  }

  lines.push('## Pending Worker Questions');
  if (input.pendingAsks.length === 0) {
    lines.push('(none)');
  } else {
    lines.push(input.pendingAsks.map(a => `- ${a.worker}: ${a.question}`).join('\n'));
  }

  lines.push('## State');
  lines.push(`- idle_ms: ${input.idleMs}`);
  lines.push(`- control_revision: ${input.revision}`);

  if (input.userAnswer) {
    lines.push('## User Just Answered');
    lines.push(`Question: ${input.userAnswer.question}`);
    lines.push(`Answer: ${input.userAnswer.answer}`);
  }

  lines.push('## Decide');
  lines.push([
    'Respond with a single JSON object and no prose. Schema:',
    '{',
    '  "action": "continue" | "ask_user" | "finalize" | "terminate",',
    '  "summary_update": "<optional new summary text to replace the shared summary>",',
    '  "directive": "<optional short steering note for workers on the next loop>",',
    '  "route_to": "<optional worker name to route a pending question to>",',
    '  "user_question": "<required when action == ask_user>",',
    '  "user_question_choices": ["<optional>", "<pick-one>", "<choices>"] ,',
    '  "final_message": "<required when action == finalize or terminate>",',
    '  "reason": "continuing" | "pending_question" | "consensus" | "drift" | "idle" | "manager_error"',
    '}',
    '',
    'Guidelines:',
    '- Use "continue" with reason "continuing" when workers should keep iterating.',
    '- Use "ask_user" with reason "pending_question" when a worker question requires human input.',
    '- Use "finalize" with reason "consensus" or "idle" when the discussion has converged or stalled.',
    '- Use "terminate" with reason "drift" when the discussion has gone off-topic and must be stopped.',
    '- "manager_error" is reserved for parser-side fallbacks; do not emit it yourself.',
    '- Output a single JSON object. No markdown fences, no commentary.',
  ].join('\n'));

  return lines.join('\n\n');
}

export function parseParallelManagerTurn(raw: string): ParallelManagerTurn | null {
  const obj = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;

  const action = obj.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as ParallelAction)) return null;
  const reason = obj.reason;
  if (typeof reason !== 'string' || !VALID_REASONS.includes(reason as ParallelReason)) return null;

  const strOrUndef = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const user_question = strOrUndef(obj.user_question);
  const final_message = strOrUndef(obj.final_message);

  if (action === 'ask_user' && !user_question) return null;
  if ((action === 'finalize' || action === 'terminate') && !final_message) return null;

  const choices = Array.isArray(obj.user_question_choices)
    ? (obj.user_question_choices.filter(c => typeof c === 'string') as string[])
    : undefined;

  const turn: ParallelManagerTurn = {
    action: action as ParallelAction,
    reason: reason as ParallelReason,
  };
  const summary_update = strOrUndef(obj.summary_update);
  const directive = strOrUndef(obj.directive);
  const route_to = strOrUndef(obj.route_to);
  if (summary_update !== undefined) turn.summary_update = summary_update;
  if (directive !== undefined) turn.directive = directive;
  if (route_to !== undefined) turn.route_to = route_to;
  if (user_question !== undefined) turn.user_question = user_question;
  if (choices !== undefined) turn.user_question_choices = choices;
  if (final_message !== undefined) turn.final_message = final_message;
  return turn;
}
