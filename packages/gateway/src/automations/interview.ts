// packages/gateway/src/automations/interview.ts
import { randomUUID } from 'crypto';
import type { InterviewQuestion, InterviewAnswer } from '@codey/core';

export interface InterviewDeps {
  generateQuestions: (goal: string, targetContext: string) => Promise<InterviewQuestion[]>;
  generateFollowup: (goal: string, question: string, answer: string) => Promise<string | null>;
  synthesize: (goal: string, qa: InterviewAnswer[]) => Promise<{ brief: string; params: Record<string, string> }>;
}

export interface InterviewStep {
  sessionId: string;
  done: boolean;
  question?: InterviewQuestion;
  brief?: string;
  params?: Record<string, string>;
}

interface Session {
  goal: string;
  questions: InterviewQuestion[];
  index: number;
  /** True while the current question is a follow-up (never chain a second). */
  inFollowup: boolean;
  current?: InterviewQuestion;
  qa: InterviewAnswer[];
}

/** Drives one authoring interview: base questions in order, at most one
 *  bounded follow-up each, then brief synthesis. State is in-memory only —
 *  an interview is an interactive Mac-app session, not a persisted run. */
export class InterviewManager {
  private sessions = new Map<string, Session>();

  constructor(private deps: InterviewDeps) {}

  async start(goal: string, targetContext: string): Promise<InterviewStep> {
    const questions = await this.deps.generateQuestions(goal, targetContext);
    const sessionId = randomUUID();
    const s: Session = { goal, questions, index: 0, inFollowup: false, qa: [] };
    this.sessions.set(sessionId, s);
    if (questions.length === 0) return this.finish(sessionId, s);
    s.current = questions[0];
    return { sessionId, done: false, question: s.current };
  }

  async answer(sessionId: string, text: string): Promise<InterviewStep> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.current) throw new Error(`Unknown interview session: ${sessionId}`);
    // Reentrancy defense: clear the pending question so an overlapping
    // answer() for the same session hits the guard above.
    const current = s.current;
    s.current = undefined;
    s.qa.push({ question: current.question, answer: text });

    if (!s.inFollowup) {
      const followup = await this.deps.generateFollowup(s.goal, current.question, text);
      if (followup) {
        s.inFollowup = true;
        s.current = { id: `${s.questions[s.index].id}-f`, question: followup };
        return { sessionId, done: false, question: s.current };
      }
    }

    s.inFollowup = false;
    s.index += 1;
    if (s.index < s.questions.length) {
      s.current = s.questions[s.index];
      return { sessionId, done: false, question: s.current };
    }
    return this.finish(sessionId, s);
  }

  /** Discard an in-progress interview (e.g. the authoring UI was closed). */
  cancel(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private async finish(sessionId: string, s: Session): Promise<InterviewStep> {
    // On synthesize failure the interview is over — the session is removed
    // either way, so the caller restarts rather than retrying into
    // duplicated state.
    try {
      const { brief, params } = await this.deps.synthesize(s.goal, s.qa);
      return { sessionId, done: true, brief, params };
    } finally {
      this.sessions.delete(sessionId);
    }
  }
}
