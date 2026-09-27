import { extractJsonObject } from './advisor';

export interface TeamFastPathMember {
  name: string;
  hint: string;
}

export type TeamFastPathDecision =
  | { route: 'single_bot'; bot: string; reason: string }
  | { route: 'full_flow'; reason: string };

export function buildTeamFastPathPrompt(task: string, members: TeamFastPathMember[]): string {
  return [
    '# Sequential team routing gate',
    'Decide whether this request can safely bypass the full sequential workflow and be answered by exactly one bot.',
    '',
    'Use `single_bot` only for a simple, self-contained question or explanation that one roster member can answer completely without implementation, multi-role tradeoffs, review, validation, or coordination.',
    'Use `full_flow` for any request to change/build/fix code or files, investigate an uncertain problem, make architectural/product decisions, validate work, use several specialties, or when there is any doubt.',
    'If the user explicitly asks for the full team, every member, the whole flow, or a review cycle, always use `full_flow`.',
    '',
    'Return JSON only:',
    '{"route":"single_bot","bot":"<exact roster name>","reason":"<short reason>"}',
    'or',
    '{"route":"full_flow","reason":"<short reason>"}',
    '',
    '## Task',
    task,
    '',
    '## Roster',
    ...members.map(member => `- ${member.name}: ${member.hint || '(no description)'}`),
  ].join('\n');
}

export function parseTeamFastPathDecision(output: string, members: TeamFastPathMember[]): TeamFastPathDecision {
  const fallback: TeamFastPathDecision = { route: 'full_flow', reason: 'Routing gate was uncertain.' };
  const parsed = extractJsonObject(output) as { route?: unknown; bot?: unknown; reason?: unknown } | null;
  if (!parsed) return fallback;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : fallback.reason;
  if (parsed.route === 'full_flow') return { route: 'full_flow', reason };
  if (parsed.route !== 'single_bot' || typeof parsed.bot !== 'string') return fallback;
  const bot = parsed.bot.trim();
  if (!members.some(member => member.name === bot)) return fallback;
  return { route: 'single_bot', bot, reason };
}
