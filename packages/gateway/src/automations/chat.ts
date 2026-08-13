import { randomUUID } from 'crypto';
import type { AutomationChatContext, AutomationChatTurn, AutomationDraft, AutomationChatMessage } from '@codey/core';

export interface ChatManagerDeps {
  /** Bound automationChatTurn with AideOptions pre-applied. */
  turn: (
    messages: AutomationChatMessage[],
    draft: AutomationDraft,
    context: AutomationChatContext,
  ) => Promise<AutomationChatTurn>;
  /** Live grounding lists - re-read per turn so new workspaces/teams appear. */
  context: () => Omit<AutomationChatContext, 'mode'>;
  now?: () => number;
}

export interface ChatStep {
  sessionId: string;
  reply: string;
  /** Full draft after the patch - drives the live summary panel. */
  draft: AutomationDraft;
  suggestions: string[];
  /** The assistant has no open questions. Drives copy only - saving is gated
   *  by draftComplete alone. */
  ready: boolean;
  /** Live choices used by the structured editor. */
  context: Omit<AutomationChatContext, 'mode' | 'nowIso'>;
}

interface Session {
  mode: 'create' | 'edit';
  messages: AutomationChatMessage[];
  draft: AutomationDraft;
  inFlight: boolean;
  touchedAt: number;
  sourceAutomationId?: string;
}

export const SESSION_TTL_MS = 30 * 60_000;

const OPENER: Record<'create' | 'edit', string> = {
  create: "What should this automation do? Describe it in your own words - I'll ask about anything that needs pinning down before it can run unattended.",
  edit: 'What should change about this automation?',
};

/** Drives one authoring chat. Sessions are in-memory only - an authoring
 *  session is interactive Mac-app state, not a persisted run. */
export class AutomationChatManager {
  private sessions = new Map<string, Session>();

  constructor(private deps: ChatManagerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Lazy TTL sweep - no timers; runs on every entry point. */
  private sweep(): void {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, s] of this.sessions) {
      if (s.touchedAt < cutoff && !s.inFlight) this.sessions.delete(id);
    }
  }

  /** Fixed opener - no Aide call, so opening the panel is instant. */
  start(mode: 'create' | 'edit', initialDraft: AutomationDraft = {}, sourceAutomationId?: string): ChatStep {
    this.sweep();
    const sessionId = randomUUID();
    const reply = OPENER[mode];
    const s: Session = {
      mode,
      messages: [{ role: 'assistant', text: reply }],
      draft: { ...initialDraft },
      inFlight: false,
      touchedAt: this.now(),
      sourceAutomationId,
    };
    this.sessions.set(sessionId, s);
    // A persisted automation is already a complete, reviewed baseline, so an
    // edit session opens ready without forcing an otherwise empty turn.
    return this.step(sessionId, s, reply, [], mode === 'edit' && draftComplete(s.draft));
  }

  async send(sessionId: string, text: string): Promise<ChatStep> {
    this.sweep();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown automation chat session: ${sessionId}`);
    if (s.inFlight) throw new Error('A turn is already in flight for this session');
    s.inFlight = true;
    s.touchedAt = this.now();
    try {
      // The user message is committed only after the turn succeeds, so a
      // failed Aide call can be retried by resending the same text.
      const turn = await this.deps.turn(
        [...s.messages, { role: 'user', text }],
        { ...s.draft },
        { ...this.deps.context(), mode: s.mode },
      );
      if (!this.sessions.has(sessionId)) throw new Error(`Unknown automation chat session: ${sessionId}`);
      s.messages.push({ role: 'user', text }, { role: 'assistant', text: turn.reply });
      applyDraftPatch(s.draft, turn.draftPatch);
      const ready = turn.ready && draftComplete(s.draft);
      return this.step(sessionId, s, turn.reply, turn.suggestions, ready);
    } finally {
      s.inFlight = false;
    }
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Apply deterministic form edits to the same draft the assistant sees. */
  patch(sessionId: string, patch: Partial<AutomationDraft>): ChatStep {
    this.sweep();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown automation chat session: ${sessionId}`);
    if (s.inFlight) throw new Error('A turn is already in flight for this session');
    s.touchedAt = this.now();
    applyDraftPatch(s.draft, patch);
    const ready = draftComplete(s.draft);
    return this.step(sessionId, s, '', [], ready);
  }

  /** Return a server-owned draft. A complete draft is always saveable: the
   *  dry run is advisory and runs after the automation is persisted. */
  finalize(sessionId: string): {
    mode: 'create' | 'edit'; sourceAutomationId?: string; draft: AutomationDraft;
  } {
    this.sweep();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown automation chat session: ${sessionId}`);
    if (!draftComplete(s.draft)) throw new Error('Automation draft is incomplete');
    return { mode: s.mode, sourceAutomationId: s.sourceAutomationId, draft: { ...s.draft } };
  }

  private step(sessionId: string, s: Session, reply: string, suggestions: string[], ready: boolean): ChatStep {
    const { workspaces, teams, agents, models, tz } = this.deps.context();
    return {
      sessionId, reply, draft: { ...s.draft }, suggestions, ready,
      context: { workspaces, teams, agents, models, tz },
    };
  }
}

export function draftComplete(draft: AutomationDraft): boolean {
  if (!draft.name?.trim() || !draft.brief?.trim() || !draft.target?.workspaceName?.trim()) return false;
  return draft.target.kind !== 'team' || !!draft.target.teamName?.trim();
}

/** Shallow merge; an explicit null clears the field. */
function applyDraftPatch(draft: AutomationDraft, patch: Partial<AutomationDraft>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete (draft as Record<string, unknown>)[k];
    else (draft as Record<string, unknown>)[k] = v;
  }
}
