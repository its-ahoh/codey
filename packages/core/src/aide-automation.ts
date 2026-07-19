// packages/core/src/aide-automation.ts
import { AideOptions, runAideJson } from './aide';
import type { AutomationNotifyMode, AutomationSchedule, AutomationTarget } from './types/automation';
import { NOTIFY_MODES, normalizeSchedule } from './types/automation';

/**
 * Resolve {{placeholders}} from params; params without a placeholder are
 * appended as a trailing "Parameters:" block so edits always take effect.
 */
export function renderBrief(brief: string, params: Record<string, string>): string {
  const used = new Set<string>();
  const out = brief.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) { used.add(key); return params[key]; }
    return match;
  });
  const leftovers = Object.entries(params).filter(([k]) => !used.has(k));
  if (leftovers.length === 0) return out;
  return `${out}\n\nParameters:\n${leftovers.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
}

// ---- Conversational authoring (chat-driven creation/edit) ----

/** Partial automation assembled turn-by-turn during the authoring chat. */
export interface AutomationDraft {
  name?: string;
  target?: AutomationTarget;
  schedule?: AutomationSchedule;
  notify?: AutomationNotifyMode;
  brief?: string;
  params?: Record<string, string>;
}

export interface AutomationChatContext {
  workspaces: string[];
  teams: string[];
  /** User's IANA zone, e.g. "Asia/Shanghai". */
  tz: string;
  /** Current local datetime string, for resolving "every morning" etc. */
  nowIso: string;
  mode: 'create' | 'edit';
}

export interface AutomationChatTurn {
  reply: string;
  /** Shallow-merged into the session draft; a null value clears the field. */
  draftPatch: Partial<AutomationDraft>;
  /** Quick-reply chips (may be empty). */
  suggestions: string[];
  /** All required fields present + no open questions. */
  ready: boolean;
}

export type AutomationChatMessage = { role: 'user' | 'assistant'; text: string };

const DRAFT_KEYS = new Set(['name', 'target', 'schedule', 'notify', 'brief', 'params']);

function isValidTargetPatch(v: unknown): v is AutomationTarget {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  if (t.kind === 'prompt') return typeof t.workspaceName === 'string' && !!t.workspaceName;
  if (t.kind === 'team') return typeof t.teamName === 'string' && !!t.teamName && typeof t.workspaceName === 'string' && !!t.workspaceName;
  return false;
}

const CHAT_TURN_PROMPT = (
  messages: AutomationChatMessage[], draft: AutomationDraft, ctx: AutomationChatContext,
) => `You are Codey's automation-setup assistant, configuring an UNATTENDED automation through a short chat. It will run on a schedule with nobody available to answer questions, so every ambiguity that would block a run must be resolved during this conversation.

Environment:
- Workspaces (the only valid choices): ${ctx.workspaces.join(', ') || '(none)'}
- Teams (optional execution target): ${ctx.teams.join(', ') || '(none)'}
- User timezone: ${ctx.tz}; current time: ${ctx.nowIso}
- Mode: ${ctx.mode === 'edit' ? 'editing an existing automation - only change what the user asks to change' : 'creating a new automation'}

Current draft (gathered so far):
${JSON.stringify(draft, null, 2)}

Conversation so far:
${messages.map(m => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n')}

Your job this turn:
1. Update the draft with anything the user's latest message settles. draftPatch contains ONLY fields that changed; set a field to null to clear it. Draft fields: name (short title), target ({"kind":"prompt","workspaceName":"..."} or {"kind":"team","teamName":"...","workspaceName":"..."}), schedule ({"times":[{"hour":0-23,"minute":0-59},...],"daysOfWeek":[0-6] optional,"tz":"${ctx.tz}"} or null for manual-only; times holds one entry per firing time, so "9am and 6pm" is [{"hour":9,"minute":0},{"hour":18,"minute":0}]), notify ("all" | "failure" | "success" | "none" - which run outcomes fire an OS notification; default "none"), brief (string), params (object of string values).
2. Reply conversationally and ask about ONE thing at a time - the next most important gap: missing specifics, choices, accounts/handles, formats, limits, edge cases (e.g. "what if there is nothing to report?"). Never ask about something the user already answered, even in passing. If the user revises an earlier choice, just patch it and move on. Patch schedule whenever the user's message settles timing, but do not steer the conversation toward scheduling.
3. When the answer space is enumerable (workspace names, team names, times, yes/no), offer 2-5 short suggestions the user can tap. Only ever suggest workspace/team names that appear in the environment above.
4. Maintain the brief as you learn: a frozen, fully self-contained instruction block for an unattended agent - no "the user said", concrete values, edge-case handling, expected output. Surface tweakable knobs as {{placeholder}} in the brief with current values in params.
5. Set ready=true ONLY when name, target and brief are complete and you have no open questions about the task itself. Scheduling is NOT required for ready: on the ready turn, reply with a short summary of the full plan, and if no schedule is set, mention once that it will run manually unless they set a schedule now or later from the automation's page. If they then request changes, patch the draft and set ready accordingly. If the conversation contains dry-run findings ("Dry run found things to pin down") that the user has not yet fully addressed, treat them as open questions: keep ready=false until each is resolved.

Respond with ONLY this JSON:
{"reply":"...","draftPatch":{},"suggestions":[],"ready":false}`;

export async function automationChatTurn(
  messages: AutomationChatMessage[],
  draft: AutomationDraft,
  context: AutomationChatContext,
  opts: AideOptions,
): Promise<AutomationChatTurn> {
  const res = await runAideJson<Record<string, unknown>>(CHAT_TURN_PROMPT(messages, draft, context), opts);
  const reply = res && typeof res.reply === 'string' ? res.reply.trim() : '';
  if (!reply) throw new Error('Aide returned no reply');
  const draftPatch: Partial<AutomationDraft> = {};
  if (res!.draftPatch && typeof res!.draftPatch === 'object' && !Array.isArray(res!.draftPatch)) {
    for (const [k, v] of Object.entries(res!.draftPatch as Record<string, unknown>)) {
      if (DRAFT_KEYS.has(k)) (draftPatch as Record<string, unknown>)[k] = v;
    }
  }
  if ('schedule' in draftPatch && draftPatch.schedule !== null) {
    // Coerce rather than drop: a schedule the user settled in conversation
    // must not silently vanish because the model emitted a near-miss shape
    // (numeric strings, missing tz, legacy single {hour,minute}).
    const coerced = normalizeSchedule(draftPatch.schedule, context.tz);
    if (coerced) draftPatch.schedule = coerced;
    else delete draftPatch.schedule;
  }
  if ('target' in draftPatch && draftPatch.target !== null && !isValidTargetPatch(draftPatch.target)) {
    delete draftPatch.target;
  }
  if ('notify' in draftPatch && draftPatch.notify !== null
      && !NOTIFY_MODES.includes(draftPatch.notify as AutomationNotifyMode)) {
    delete draftPatch.notify;
  }
  const suggestions = Array.isArray(res!.suggestions)
    ? (res!.suggestions as unknown[]).filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 6)
    : [];
  return { reply, draftPatch, suggestions, ready: res!.ready === true };
}

// ---- Authoring-time dry-run (verify a brief can run unattended) ----

export type DryRunVerdict =
  | { status: 'clean' }
  | { status: 'gaps'; questions: string[] }
  | { status: 'error'; message: string };

/**
 * Wrap a rendered brief in a no-act preamble. The agent walks the brief in
 * the real workspace but must not act; its output is classified by
 * classifyDryRun. Team targets are never dispatched as teams - their
 * definitions are inlined as context instead.
 */
export function buildDryRunPrompt(
  brief: string,
  params: Record<string, string>,
  teamContext?: string,
): string {
  const rendered = renderBrief(brief, params);
  const teamBlock = teamContext
    ? `\nThis brief is normally executed by a team; its definitions, for context:\n${teamContext}\n`
    : '';
  return `DRY RUN - do not perform any real actions (no messages sent, no files changed, no external side effects). Walk through the brief below step by step as if executing it unattended. Report:
(a) anything missing or ambiguous you would need to ask a human about,
(b) anything in the workspace that contradicts the brief.
If nothing blocks unattended execution, say so explicitly.
${teamBlock}
Brief:
${rendered}`;
}

const CLASSIFY_DRY_RUN_PROMPT = (output: string) => `An agent just performed a DRY RUN of an automation brief and reported the following. Decide whether anything would block fully unattended execution.

Agent report:
${output}

Respond with ONLY this JSON:
- Nothing blocks unattended execution: {"verdict":"clean"}
- Something blocks it: {"verdict":"gaps","questions":["<one concrete question per blocking item, phrased to the automation's owner>"]}`;

/** Classify dry-run output. Throws on malformed/unusable classification -
 *  callers map a throw to an 'error' verdict, never to 'gaps'. */
export async function classifyDryRun(output: string, opts: AideOptions): Promise<DryRunVerdict> {
  const res = await runAideJson<Record<string, unknown>>(CLASSIFY_DRY_RUN_PROMPT(output), opts);
  if (res?.verdict === 'clean') return { status: 'clean' };
  if (res?.verdict === 'gaps') {
    const questions = Array.isArray(res.questions)
      ? (res.questions as unknown[]).filter((q): q is string => typeof q === 'string' && !!q.trim())
      : [];
    if (questions.length > 0) return { status: 'gaps', questions };
  }
  throw new Error('Unrecognized dry-run classification');
}
