import { randomUUID } from 'crypto';
import type { AutomationChatContext, AutomationChatTurn, AutomationDraft, AutomationChatMessage, AutomationCheckStatus } from '@codey/core';

export interface ChatManagerDeps {
  /** Bound automationChatTurn with AideOptions pre-applied. */
  turn: (
    messages: AutomationChatMessage[],
    draft: AutomationDraft,
    context: AutomationChatContext,
  ) => Promise<AutomationChatTurn>;
  /** Live grounding lists - re-read per turn so new workspaces/teams appear. */
  context: () => Omit<AutomationChatContext, 'mode'>;
  /** Fired when a session's ready flag rises false->true (dry-run trigger). */
  onReadyTransition?: (sessionId: string, draft: AutomationDraft) => void;
  now?: () => number;
}

export interface ChatStep {
  sessionId: string;
  reply: string;
  /** Full draft after the patch - drives the live summary panel. */
  draft: AutomationDraft;
  suggestions: string[];
  ready: boolean;
  /** Dry-run check state; undefined until the first ready transition. */
  check?: AutomationCheckStatus;
}

interface Session {
  mode: 'create' | 'edit';
  messages: AutomationChatMessage[];
  draft: AutomationDraft;
  inFlight: boolean;
  touchedAt: number;
  wasReady: boolean;
  check?: AutomationCheckStatus;
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
  start(mode: 'create' | 'edit', initialDraft: AutomationDraft = {}): ChatStep {
    this.sweep();
    const sessionId = randomUUID();
    const reply = OPENER[mode];
    const s: Session = {
      mode,
      messages: [{ role: 'assistant', text: reply }],
      draft: { ...initialDraft },
      inFlight: false,
      touchedAt: this.now(),
      wasReady: false,
    };
    this.sessions.set(sessionId, s);
    return { sessionId, reply, draft: { ...s.draft }, suggestions: [], ready: false };
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
      const transition = turn.ready && !s.wasReady;
      s.wasReady = turn.ready;
      if (!turn.ready) s.check = undefined;
      else if (transition) s.check = 'pending';
      if (transition) {
        try { this.deps.onReadyTransition?.(sessionId, { ...s.draft }); }
        catch { /* dry-run trigger must not fail the turn */ }
      }
      return { sessionId, reply: turn.reply, draft: { ...s.draft }, suggestions: turn.suggestions, ready: turn.ready, check: s.check };
    } finally {
      s.inFlight = false;
    }
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Record a dry-run verdict. Accepted only while the session's check is
   * still pending - rejected (returns false) when the session is gone,
   * ready dropped back to false, or the check was already resolved; the
   * caller must discard such a stale verdict.
   * `message` is appended to the transcript so later turns see it.
   */
  resolveCheck(sessionId: string, check: Exclude<AutomationCheckStatus, 'pending'>, message?: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.check !== 'pending') return false;
    s.check = check;
    if (message) s.messages.push({ role: 'assistant', text: message });
    return true;
  }
}

/** Shallow merge; an explicit null clears the field. */
function applyDraftPatch(draft: AutomationDraft, patch: Partial<AutomationDraft>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete (draft as Record<string, unknown>)[k];
    else (draft as Record<string, unknown>)[k] = v;
  }
}
