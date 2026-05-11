import { ManagerHistoryEntry } from '../manager';

/** Recorded part of a Manager-driven run, kept while the team is paused. */
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
    }
  | {
      teamName: string;
      task: string;
      mode: 'auto';
      history: ManagerHistoryEntry[];
      lastWorker: string;
      lastOutput: string;
      partsSoFar: PendingPart[];
      seenWorkers: string[];
      step: number;
      askingWorker: string;
      question: string;
      options?: string[];
      askedAt: number;
    };
