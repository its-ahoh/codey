import { ChatMessage, Chat, TaskBrief, TeamRunSummary, TeamRunSummaryEntry } from './types/chat';
import { AideOptions, runAide, runAideJson } from './aide';
import { coerceTaskBrief } from './task-brief';

/** Hard cap on characters per message included in a summary prompt — guards against runaway prompts. */
const MAX_MSG_CHARS = 4000;

/**
 * Fold older messages into a rolling chat summary. Pass any existing summary
 * as `priorSummary` to extend it incrementally; pass undefined to summarize
 * from scratch.
 *
 * The returned string is the NEW full summary that should replace whatever
 * the caller had stored. Caller is responsible for bumping `summarizedUpTo`.
 */
export async function summarizeChatMessages(
  messages: ChatMessage[],
  priorSummary: string | undefined,
  opts: AideOptions,
): Promise<string> {
  if (messages.length === 0) return priorSummary ?? '';

  const transcript = messages
    .map(m => {
      const body = m.content.length > MAX_MSG_CHARS
        ? m.content.slice(0, MAX_MSG_CHARS) + '… [truncated]'
        : m.content;
      return `[${m.role}]\n${body}`;
    })
    .join('\n\n');

  const lines: string[] = [];
  lines.push('You are maintaining a rolling summary of a long developer chat.');
  lines.push('Your output replaces the existing summary; it must stand alone.');
  lines.push('');
  if (priorSummary && priorSummary.trim()) {
    lines.push('## Existing summary');
    lines.push(priorSummary.trim());
    lines.push('');
  }
  lines.push('## New messages to fold in');
  lines.push(transcript);
  lines.push('');
  lines.push('## Output requirements');
  lines.push('- Plain prose, ≤ 500 words, no markdown headers, no bullet lists, no preamble.');
  lines.push('- Preserve: the user\'s overall goal, key decisions made, files/symbols touched, unresolved questions or TODOs.');
  lines.push('- Drop: small talk, exact tool call payloads, transient errors that were resolved.');
  lines.push('- Refer to participants as "the user" and "the assistant".');
  lines.push('- If a prior summary exists, integrate its facts — do not duplicate or contradict it.');
  lines.push('');
  lines.push('Output only the summary text.');

  return runAide(lines.join('\n'), opts);
}

/** Upper bound on a generated chat title. Matches the truncation fallback. */
const MAX_TITLE_CHARS = 40;

/**
 * Generate a short, human-readable chat title from the opening user message.
 * Used in place of blindly truncating the first message. Returns a sanitized
 * single-line title (≤ MAX_TITLE_CHARS), or '' if the Aide produced nothing
 * usable — the caller should fall back to truncation in that case.
 */
export async function generateChatTitle(
  firstUserMessage: string,
  opts: AideOptions,
): Promise<string> {
  const source = firstUserMessage.trim();
  if (!source) return '';

  const lines: string[] = [];
  lines.push('You write concise titles for developer chat threads.');
  lines.push('Summarize the user message below into a short title.');
  lines.push('');
  lines.push('## User message');
  lines.push(source.length > MAX_MSG_CHARS ? source.slice(0, MAX_MSG_CHARS) + '… [truncated]' : source);
  lines.push('');
  lines.push('## Requirements');
  lines.push('- A noun phrase capturing the topic or intent, not a greeting.');
  lines.push('- At most 6 words and 40 characters.');
  lines.push('- Same language as the user message.');
  lines.push('- No surrounding quotes, no trailing punctuation, no preamble — output only the title.');

  const raw = await runAide(lines.join('\n'), opts);
  return sanitizeTitle(raw);
}

/** Collapse whitespace, strip wrapping quotes/markdown, and clamp length. */
function sanitizeTitle(raw: string): string {
  // Defensive: drop a leading "[Fallback: … → …]" banner line if one ever
  // reaches here (the banner now travels as response metadata, not text, but
  // a cached/older output could still carry it — never make it the title).
  const cleaned = raw.replace(/^\s*\[Fallback:[^\]]*\]\s*/i, '');
  let t = cleaned.trim().split('\n')[0].trim();
  // Drop a leading "Title:" style label some models prepend.
  t = t.replace(new RegExp(`^(title|\u6807\u9898)\\s*[:\uFF1A]\\s*`, 'i'), '');
  // Strip a single layer of wrapping quotes or backticks.
  t = t.replace(/^["'`“”]+|["'`“”]+$/g, '').trim();
  t = t.replace(/\s+/g, ' ');
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS).trim() + '…';
  return t;
}

/** Build a compact transcript (messages + key tool-call headlines) for the brief prompt. */
function briefTranscript(chat: Chat): string {
  return chat.messages
    .map(m => {
      const body = m.content.length > MAX_MSG_CHARS ? m.content.slice(0, MAX_MSG_CHARS) + '… [truncated]' : m.content;
      const tools = (m.toolCalls ?? [])
        .filter(t => t.type === 'tool_start' || t.type === 'tool_end')
        .map(t => `  · ${t.tool ?? 'tool'}: ${t.message}`)
        .slice(0, 20)
        .join('\n');
      return `[${m.role} @${m.timestamp}]\n${body}${tools ? '\n' + tools : ''}`;
    })
    .join('\n\n');
}

export interface AideTurnDigest {
  taskBrief: TaskBrief;
  teamSummary?: TeamRunSummary;
}

type SummaryRewrite = {
  sources?: unknown;
  text?: unknown;
};

function rewriteSummaryEntries(raw: unknown, source: TeamRunSummaryEntry[]): TeamRunSummaryEntry[] {
  if (source.length === 0) return [];
  if (!Array.isArray(raw)) return source;

  const result: TeamRunSummaryEntry[] = [];
  const used = new Set<number>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') return source;
    const rewrite = value as SummaryRewrite;
    if (!Array.isArray(rewrite.sources) || typeof rewrite.text !== 'string' || !rewrite.text.trim()) return source;
    const indexes = rewrite.sources.filter((index): index is number => Number.isInteger(index));
    if (indexes.length === 0 || indexes.length !== rewrite.sources.length) return source;
    if (indexes.some(index => index < 0 || index >= source.length || used.has(index))) return source;
    indexes.forEach(index => used.add(index));

    const first = source[indexes[0]];
    result.push({
      worker: indexes.length === 1 ? first.worker : 'Team',
      step: indexes.length === 1 ? first.step : Math.min(...indexes.map(index => source[index].step)),
      text: rewrite.text.trim(),
    });
  }

  return used.size === source.length ? result : source;
}

function coerceAideTeamSummary(raw: unknown, source: TeamRunSummary): TeamRunSummary {
  if (!raw || typeof raw !== 'object') return source;
  const value = raw as Record<string, unknown>;
  return {
    completed: rewriteSummaryEntries(value.completed, source.completed),
    failures: rewriteSummaryEntries(value.failures, source.failures),
    nextUserActions: rewriteSummaryEntries(value.nextUserActions, source.nextUserActions),
    finalizedAt: source.finalizedAt,
  };
}

/**
 * Produce the shared structured digest used by the Task HUD and, when a team
 * has just reached a terminal state, its final summary. The terminal summary
 * supplied by the Gateway remains the source of truth: the Aide may merge and
 * rewrite entries, but every result must cite all source indexes exactly once.
 */
export async function generateAideTurnDigest(
  chat: Chat,
  opts: AideOptions,
  sourceTeamSummary?: TeamRunSummary,
): Promise<AideTurnDigest> {
  const fallbackGoal = chat.title?.trim() || 'Untitled task';
  const latestUserRequest = [...chat.messages].reverse().find(message => message.role === 'user')?.content.trim() || fallbackGoal;

  const lines: string[] = [];
  lines.push('You produce a shared turn digest for a developer chat.');
  lines.push('Output ONLY a JSON object (no markdown, no prose) with this exact shape:');
  lines.push('{');
  lines.push('  "taskBrief": {');
  lines.push('    "goal": string,                       // the task in one line');
  lines.push('    "state": { "progress": number,        // 0-100');
  lines.push('               "stepLabel": string,        // e.g. "step 3 / 5" (optional)');
  lines.push('               "status": "working"|"waiting"|"blocked"|"done" },');
  lines.push('    "nextAction": { "text": string,       // single most useful next step or open question');
  lines.push('                    "detail": string,      // one-line elaboration (optional)');
  lines.push('                    "messageId": string }, // id of the assistant message that raised it (optional)');
  lines.push('    "timeline": [ { "kind": "progress"|"action"|"decision"|"dropped",');
  lines.push('                    "text": string, "why": string (optional),');
  lines.push('                    "when": number (epoch ms, optional),');
  lines.push('                    "detail": [string] } ]  // sub-bullets, ONLY on the first (newest) entry');
  lines.push(sourceTeamSummary ? '  },' : '  }');
  if (sourceTeamSummary) {
    lines.push('  "teamSummary": {');
    lines.push('    "completed": [ { "sources": [number], "text": string } ],');
    lines.push('    "failures": [ { "sources": [number], "text": string } ],');
    lines.push('    "nextUserActions": [ { "sources": [number], "text": string } ]');
    lines.push('  }');
  }
  lines.push('}');
  lines.push('');
  lines.push('Rules:');
  lines.push('- timeline is REVERSE-chronological: newest first. The first entry is the current/most-recent progress; give it AT MOST 3 `detail` bullets summarizing what just happened. Older entries: no detail.');
  lines.push('- "status" is "waiting" if the assistant is blocked on a user decision/answer, "done" if the task is finished, "blocked" if stuck on an external problem, else "working".');
  lines.push('- Write every user-facing string (goal, stepLabel, nextAction text/detail, timeline text/why/detail, and teamSummary text) in the same language as the user\'s most recent substantive request.');
  lines.push('- If the latest request is language-neutral (for example "OK" or only code), use the dominant language across the user messages. Preserve code, commands, file paths, API names, and technical identifiers exactly; do not translate the JSON keys or enum values.');
  lines.push('- Be terse — these render in a narrow panel. Hard limits: goal ≤ 8 words; nextAction.text ≤ 10 words; nextAction.detail ≤ 10 words; each timeline.text ≤ 8 words; each why ≤ 10 words; each detail bullet ≤ 10 words. Use fragments, not full sentences. No trailing punctuation.');
  lines.push('- messageId, when: only include if you can ground them in the transcript markers ([role @timestamp], message ids); otherwise omit.');
  if (sourceTeamSummary) {
    lines.push('- teamSummary may only merge, deduplicate, and rewrite the supplied terminal facts. Never introduce a new fact, failure, or user action.');
    lines.push('- Each source index in each category must appear exactly once in that category. Merge related facts by citing multiple indexes in one item. Keep an empty source category empty.');
    lines.push('- Keep teamSummary concise but specific. Describe final outcomes, unresolved failures, and required user actions only.');
  }
  lines.push('');
  lines.push('## Chat title');
  lines.push(fallbackGoal);
  lines.push('');
  lines.push('## Most recent user request (language reference)');
  lines.push(latestUserRequest.length > MAX_MSG_CHARS ? latestUserRequest.slice(0, MAX_MSG_CHARS) + '… [truncated]' : latestUserRequest);
  lines.push('');
  lines.push('## Transcript');
  lines.push(briefTranscript(chat));
  if (sourceTeamSummary) {
    lines.push('');
    lines.push('## Authoritative terminal team facts');
    lines.push(JSON.stringify({
      completed: sourceTeamSummary.completed.map((item, index) => ({ index, text: item.text })),
      failures: sourceTeamSummary.failures.map((item, index) => ({ index, text: item.text })),
      nextUserActions: sourceTeamSummary.nextUserActions.map((item, index) => ({ index, text: item.text })),
    }));
  }

  const raw = await runAideJson<Record<string, unknown>>(lines.join('\n'), opts);
  const taskBrief = coerceTaskBrief(raw?.taskBrief ?? raw, fallbackGoal);
  return {
    taskBrief,
    ...(sourceTeamSummary ? { teamSummary: coerceAideTeamSummary(raw?.teamSummary, sourceTeamSummary) } : {}),
  };
}

/**
 * Produce a structured Task HUD brief (goal / state / next action / timeline)
 * from a chat. Output is validated by coerceTaskBrief, so a malformed model
 * response degrades to a minimal brief (goal = chat title) rather than throwing.
 */
export async function generateTaskBrief(chat: Chat, opts: AideOptions): Promise<TaskBrief> {
  return (await generateAideTurnDigest(chat, opts)).taskBrief;
}
