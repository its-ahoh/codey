// Pure functions over the gateway's crystallizer SkillStore, extracted so the
// playbooks:* IPC handlers are unit-testable without Electron.
// NOT the same thing as the agent-skill directories behind the skills:* IPC.
import type { SkillStore, SkillEvolutionEvent } from '@codey/core';
import * as fs from 'fs';
import * as path from 'path';

/** A store paired with the workspace it belongs to. The Playbooks tab is a
 *  global view, so every summary and every action carries its workspace. */
export interface WorkspaceStore {
  workspace: string;
  store: SkillStore;
}

export interface PlaybookSummary {
  /** Owning workspace — names are only unique within one. */
  workspace: string;
  name: string;
  description: string;
  version: number;
  useCount: number;
  lastUsedAt: number;
  archived: boolean;
  promotedToSkill: boolean;
  successSignals: { cleanRuns: number; corrections: number };
  canRollback: boolean;
}

/** Aggregate every workspace's playbooks into one list, grouped by workspace
 *  in the order given. Two workspaces may hold same-named playbooks — they are
 *  distinct entries, so consumers must key on (workspace, name). */
export function listPlaybooks(stores: WorkspaceStore[]): PlaybookSummary[] {
  return stores.flatMap(({ workspace, store }) => store.getAll().map(s => ({
    workspace,
    name: s.name,
    description: s.description,
    version: s.version,
    useCount: s.useCount,
    lastUsedAt: s.lastUsedAt,
    archived: s.archived,
    promotedToSkill: s.promotedToSkill === true,
    successSignals: s.successSignals,
    canRollback: s.history.length > 0,
  })));
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

function renderSkill(name: string, description: string, whenToUse: string, steps: string): string {
  return `---
name: ${JSON.stringify(name)}
description: ${JSON.stringify(description)}
---

# ${name}

## When to use

${whenToUse}

## Procedure

${steps}
`;
}

/** Export a crystallized playbook as a project-scoped agent skill, then pin
 *  the source playbook so automatic cleanup cannot archive it. */
export async function promotePlaybook(
  store: SkillStore,
  name: string,
  targetRoot: string,
): Promise<{ name: string; dir: string }> {
  const playbook = store.get(name);
  if (!playbook) throw new Error(`Playbook not found: ${name}`);
  if (playbook.promotedToSkill) throw new Error(`Playbook "${name}" is already a skill.`);
  if (!/^[a-z][a-z0-9-]*$/.test(playbook.name)) {
    throw new Error(`Playbook "${playbook.name}" does not have a valid skill name.`);
  }

  const dir = path.join(targetRoot, playbook.name);
  const skillPath = path.join(dir, 'SKILL.md');
  await fs.promises.mkdir(targetRoot, { recursive: true });
  try {
    await fs.promises.mkdir(dir);
    await fs.promises.writeFile(
      skillPath,
      renderSkill(playbook.name, playbook.description, playbook.whenToUse, playbook.steps),
      { encoding: 'utf-8', flag: 'wx' },
    );
    if (!store.promoteToSkill(name)) throw new Error(`Playbook not found: ${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Skill already exists: ${playbook.name}`);
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { name: playbook.name, dir };
}
