import { AdvisorHistoryEntry } from '../advisor';
import type { BlackboardSnapshot } from '../team-blackboard';
import type { WorkerAnchor } from '../context';

/** Recorded part of a Advisor-driven run, kept while the team is paused. */
export interface PendingPart {
  step: number;
  worker: string;
  output: string;
  isRevision: boolean;
}

/** State persisted on a Chat while a team run is paused waiting for user input. */
export type PendingTeamState =
  | {
      teamName: string;
      task: string;
      mode: 'sequential';
      memberIndex: number;
      carry: string;
      askingWorker: string;
      question: string;
      /** Options when worker emitted [ASK_USER:choice]; absent for free-text questions. */
      options?: string[];
      askedAt: number;
      blackboard?: BlackboardSnapshot;
      /** Warm worker sessions captured at pause; rehydrated on resume so the
       *  next step's prompt continues `--resume`-ing instead of re-bootstrapping. */
      workerAnchors?: Record<string, WorkerAnchor>;
    }
  | {
      teamName: string;
      task: string;
      mode: 'auto';
      history: AdvisorHistoryEntry[];
      lastWorker: string;
      lastOutput: string;
      partsSoFar: PendingPart[];
      seenWorkers: string[];
      step: number;
      askingWorker: string;
      question: string;
      options?: string[];
      askedAt: number;
      blackboard?: BlackboardSnapshot;
      /** Warm worker sessions captured at pause; rehydrated on resume so the
       *  next step's prompt continues `--resume`-ing instead of re-bootstrapping. */
      workerAnchors?: Record<string, WorkerAnchor>;
    }
  | {
      teamName: string;
      task: string;
      mode: 'graph';
      graphState: { currentNodeId: string; hops: number; visited: string[] };
      results: string[];
      askingWorker: string;
      question: string;
      options?: string[];
      askedAt: number;
      blackboard?: BlackboardSnapshot;
      workerAnchors?: Record<string, WorkerAnchor>;
    };
