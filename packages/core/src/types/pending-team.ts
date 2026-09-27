import { AdvisorHistoryEntry } from '../advisor';
import type { BlackboardSnapshot } from '../team-blackboard';
import type { BotAnchor } from '../context';

/** Recorded part of a Advisor-driven run, kept while the team is paused. */
export interface PendingPart {
  step: number;
  bot: string;
  output: string;
  isRevision: boolean;
}

/** State persisted on a Chat while a team run is paused waiting for user input. */
export type PendingTeamState =
  | {
      teamName: string;
      task: string;
      mode: 'sequential';
      teamTurnId: string;
      /** Set for an ad-hoc team built from @mentions, which has no registry entry to look up on resume. */
      members?: string[];
      memberIndex: number;
      carry: string;
      askingBot: string;
      question: string;
      /** Options when bot emitted [ASK_USER:choice]; absent for free-text questions. */
      options?: string[];
      askedAt: number;
      blackboard?: BlackboardSnapshot;
      /** Warm bot sessions captured at pause; rehydrated on resume so the
       *  next step's prompt continues `--resume`-ing instead of re-bootstrapping. */
      botAnchors?: Record<string, BotAnchor>;
    }
  | {
      teamName: string;
      task: string;
      mode: 'auto';
      teamTurnId: string;
      /** Set for an ad-hoc team built from @mentions, which has no registry entry to look up on resume. */
      members?: string[];
      history: AdvisorHistoryEntry[];
      lastBot: string;
      lastOutput: string;
      partsSoFar: PendingPart[];
      seenBots: string[];
      step: number;
      askingBot: string;
      question: string;
      options?: string[];
      askedAt: number;
      blackboard?: BlackboardSnapshot;
      /** Warm bot sessions captured at pause; rehydrated on resume so the
       *  next step's prompt continues `--resume`-ing instead of re-bootstrapping. */
      botAnchors?: Record<string, BotAnchor>;
    }
  | {
      teamName: string;
      task: string;
      mode: 'graph';
      teamTurnId: string;
      graphState: { currentNodeId: string; hops: number; visited: string[]; runStreak?: number };
      results: string[];
      askingBot: string;
      question: string;
      options?: string[];
      askedAt: number;
      blackboard?: BlackboardSnapshot;
      botAnchors?: Record<string, BotAnchor>;
    };
