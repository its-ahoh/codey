// Pure functions over the gateway's crystallizer SkillStore, extracted so the
// playbooks:* IPC handlers are unit-testable without Electron.
// NOT the same thing as the agent-skill directories behind the skills:* IPC.
import type { SkillStore, SkillEvolutionEvent } from '@codey/core';

/** Stands in for a workspace name for the global playbook ledger. Not a
 *  valid directory name on every platform, so no real workspace can clash. */
export const GLOBAL_PLAYBOOKS = '*';

/** A store paired with the workspace it belongs to. The Playbooks tab is a
 *  global view, so every summary and every action carries its workspace. */
export interface WorkspaceStore {
  workspace: string;
  store: SkillStore;
  /** 'global' for the ledger keyed GLOBAL_PLAYBOOKS; workspaces are 'project'. */
  scope?: 'project' | 'global';
}

export interface PlaybookSummary {
  /** Owning workspace — names are only unique within one. GLOBAL_PLAYBOOKS
   *  for a global playbook. */
  workspace: string;
  scope: 'project' | 'global';
  name: string;
  description: string;
  version: number;
  useCount: number;
  lastUsedAt: number;
  archived: boolean;
  promotedToSkill: boolean;
  editedByUser: boolean;
  successSignals: { cleanRuns: number; corrections: number };
  canRollback: boolean;
}

export interface PlaybookDetail {
  name: string;
  description: string;
  whenToUse: string;
  steps: string;
  version: number;
}

/** Aggregate every workspace's playbooks into one list, grouped by workspace
 *  in the order given. Two workspaces may hold same-named playbooks — they are
 *  distinct entries, so consumers must key on (workspace, name). */
export function listPlaybooks(stores: WorkspaceStore[]): PlaybookSummary[] {
  return stores.flatMap(({ workspace, store, scope }) => store.getAll().map(s => ({
    workspace,
    scope: scope ?? 'project',
    name: s.name,
    description: s.description,
    version: s.version,
    useCount: s.useCount,
    lastUsedAt: s.lastUsedAt,
    archived: s.archived,
    promotedToSkill: s.promotedToSkill === true,
    editedByUser: s.editedByUser === true,
    successSignals: s.successSignals,
    canRollback: s.history.length > 0,
  })));
}

export function playbookHistory(store: SkillStore, name: string): SkillEvolutionEvent[] {
  const skill = store.get(name);
  if (!skill) throw new Error(`Playbook not found: ${name}`);
  return [...skill.evolution];
}

/** Return the complete current version without exposing the store's mutable
 * internal SkillEntry (including rollback and provenance bookkeeping). */
export function playbookDetail(store: SkillStore, name: string): PlaybookDetail {
  const skill = store.get(name);
  if (!skill) throw new Error(`Playbook not found: ${name}`);
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    steps: skill.steps,
    version: skill.version,
  };
}

export function archivePlaybook(store: SkillStore, name: string): void {
  if (!store.archive(name)) throw new Error(`Playbook not found: ${name}`);
}

export function restorePlaybook(store: SkillStore, name: string): void {
  if (!store.restore(name)) throw new Error(`Playbook not found: ${name}`);
}

export function deletePlaybook(store: SkillStore, name: string): void {
  if (!store.remove(name)) throw new Error(`Playbook not found: ${name}`);
}

export function rollbackPlaybook(store: SkillStore, name: string): number {
  if (!store.rollback(name)) {
    throw new Error(`Playbook "${name}" has no prior version (or was not found).`);
  }
  return store.get(name)!.version;
}
