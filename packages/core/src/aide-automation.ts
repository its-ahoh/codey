// packages/core/src/aide-automation.ts
import { AideOptions, runAideJson } from './aide';
import type { AutomationSchedule, AutomationTarget } from './types/automation';

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
  notify?: boolean;
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
1. Update the draft with anything the user's latest message settles. draftPatch contains ONLY fields that changed; set a field to null to clear it. Draft fields: name (short title), target ({"kind":"prompt","workspaceName":"..."} or {"kind":"team","teamName":"...","workspaceName":"..."}), schedule ({"hour":0-23,"minute":0-59,"daysOfWeek":[0-6] optional,"tz":"${ctx.tz}"} or null for manual-only), notify (boolean), brief (string), params (object of string values).
2. Reply conversationally and ask about ONE thing at a time - the next most important gap: missing specifics, choices, accounts/handles, formats, limits, edge cases (e.g. "what if there is nothing to report?"), and eventually scheduling. Never ask about something the user already answered, even in passing. If the user revises an earlier choice, just patch it and move on.
3. When the answer space is enumerable (workspace names, team names, times, yes/no), offer 2-5 short suggestions the user can tap. Only ever suggest workspace/team names that appear in the environment above.
4. Maintain the brief as you learn: a frozen, fully self-contained instruction block for an unattended agent - no "the user said", concrete values, edge-case handling, expected output. Surface tweakable knobs as {{placeholder}} in the brief with current values in params.
5. Set ready=true ONLY when name, target and brief are complete, scheduling has been explicitly discussed (a concrete schedule or deliberately manual-only), and you have no open questions. On that turn, reply with a short summary of the full plan and invite the user to confirm or change anything. If they then request changes, patch the draft and set ready accordingly.

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
  const suggestions = Array.isArray(res!.suggestions)
    ? (res!.suggestions as unknown[]).filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 6)
    : [];
  return { reply, draftPatch, suggestions, ready: res!.ready === true };
}
