// Pure functions over the gateway's crystallizer SkillStore, extracted so the
// learnedSkills:* IPC handlers are unit-testable without Electron.
// NOT the same thing as the agent-skill directories behind the skills:* IPC.
import type { SkillStore, SkillEvolutionEvent } from '@codey/core';

export interface LearnedSkillSummary {
  name: string;
  description: string;
  version: number;
  useCount: number;
  lastUsedAt: number;
  archived: boolean;
  successSignals: { cleanRuns: number; corrections: number };
  canRollback: boolean;
}

export function listLearnedSkills(store: SkillStore): LearnedSkillSummary[] {
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

export function learnedSkillHistory(store: SkillStore, name: string): SkillEvolutionEvent[] {
  const skill = store.get(name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  return [...skill.evolution];
}

export function forgetLearnedSkill(store: SkillStore, name: string): void {
  if (!store.archive(name)) throw new Error(`Skill not found: ${name}`);
}

export function restoreLearnedSkill(store: SkillStore, name: string): void {
  if (!store.restore(name)) throw new Error(`Skill not found: ${name}`);
}

export function rollbackLearnedSkill(store: SkillStore, name: string): number {
  if (!store.rollback(name)) {
    throw new Error(`Skill "${name}" has no prior version (or was not found).`);
  }
  return store.get(name)!.version;
}
