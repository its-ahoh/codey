// Pure functions over the gateway's crystallizer SkillStore, extracted so the
// playbooks:* IPC handlers are unit-testable without Electron.
// NOT the same thing as the agent-skill directories behind the skills:* IPC.
import type { SkillStore, SkillEvolutionEvent } from '@codey/core';

export interface PlaybookSummary {
  name: string;
  description: string;
  version: number;
  useCount: number;
  lastUsedAt: number;
  archived: boolean;
  successSignals: { cleanRuns: number; corrections: number };
  canRollback: boolean;
}

export function listPlaybooks(store: SkillStore): PlaybookSummary[] {
  return store.getAll().map(s => ({
    name: s.name,
    description: s.description,
    version: s.version,
    useCount: s.useCount,
    lastUsedAt: s.lastUsedAt,
    archived: s.archived,
    successSignals: s.successSignals,
    canRollback: s.history.length > 0,
  }));
}

export function playbookHistory(store: SkillStore, name: string): SkillEvolutionEvent[] {
  const skill = store.get(name);
  if (!skill) throw new Error(`Playbook not found: ${name}`);
  return [...skill.evolution];
}

export function forgetPlaybook(store: SkillStore, name: string): void {
  if (!store.archive(name)) throw new Error(`Playbook not found: ${name}`);
}

export function restorePlaybook(store: SkillStore, name: string): void {
  if (!store.restore(name)) throw new Error(`Playbook not found: ${name}`);
}

export function rollbackPlaybook(store: SkillStore, name: string): number {
  if (!store.rollback(name)) {
    throw new Error(`Playbook "${name}" has no prior version (or was not found).`);
  }
  return store.get(name)!.version;
}
