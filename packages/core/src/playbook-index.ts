// packages/core/src/playbook-index.ts
//
// Unpromoted playbooks are offered the way agents already discover SKILL.md:
// a short index (name + one-line description) in the prompt, with the full
// procedure in a file the agent reads only when it decides the playbook fits.
// The agent does the matching, so it works in any language the agent reads.
import * as fsp from 'fs/promises';
import * as path from 'path';
import { atomicWrite } from './utils/fs';
import { SkillEntry, SkillStore } from './skill-crystallizer';

/** Bounds the per-turn prompt cost; cleanup keeps the real count small. */
export const PLAYBOOK_INDEX_MAX = 10;

export interface OfferedPlaybook {
  skill: SkillEntry;
  /** Absolute path of the playbook file the index points to. */
  file: string;
}

export function renderPlaybookFile(skill: SkillEntry): string {
  const inputs = skill.parameters?.length
    ? `\n## Inputs\n\n${skill.parameters.map(p =>
      `- «${p.name}» — determine from the task (${p.ext ? `${p.kind}, .${p.ext}` : p.kind})`).join('\n')}\n`
    : '';
  return `# ${skill.name} (v${skill.version})

${skill.description}

## When to use

${skill.whenToUse}

## Steps

${skill.steps}
${inputs}`;
}

/** Write the files for the playbooks worth offering and return them, most
 *  recently used first. Promoted playbooks are left out: they are SKILL.md
 *  files the agent already discovers. A file that cannot be written is
 *  skipped rather than listed with a path that does not exist. */
export async function preparePlaybookIndex(store: SkillStore): Promise<OfferedPlaybook[]> {
  const candidates = store.getActive()
    .filter(s => !s.promotedToSkill)
    .sort((a, b) => (b.lastUsedAt - a.lastUsedAt) || (b.createdAt - a.createdAt))
    .slice(0, PLAYBOOK_INDEX_MAX);
  const offered: OfferedPlaybook[] = [];
  for (const skill of candidates) {
    const file = store.playbookFilePath(skill.name);
    const body = renderPlaybookFile(skill);
    try {
      let current: string | null = null;
      try { current = await fsp.readFile(file, 'utf-8'); } catch { /* not written yet */ }
      if (current !== body) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(file, body);
      }
      offered.push({ skill, file });
    } catch {
      continue;
    }
  }
  return offered;
}

export function withPlaybookIndex(task: string, offered: OfferedPlaybook[]): string {
  if (offered.length === 0) return task;
  const lines = offered.map(({ skill, file }) => `- ${skill.name}: ${skill.description} → ${file}`);
  return `Playbooks learned from earlier runs in this workspace:
${lines.join('\n')}
If one fits the task, read its file before you start and follow it. Otherwise ignore this list. Do not ask the user to choose.

---
User task:
${task}`;
}

/** Playbooks whose file the agent actually opened during the run. Adapters
 *  that report no tool events (opencode, codex) yield none. */
export function playbooksRead(
  // Chat entries carry start/end events; channel records are one per call.
  toolCalls: { type?: string; message?: string; input?: unknown }[] | undefined,
  offered: OfferedPlaybook[],
): SkillEntry[] {
  if (!toolCalls?.length || offered.length === 0) return [];
  const calls = toolCalls
    .filter(c => c.type === undefined || c.type === 'tool_start')
    .map(c => `${c.message ?? ''} ${JSON.stringify(c.input ?? {})}`);
  return offered
    .filter(({ file }) => {
      // Inputs are JSON-encoded, so match the escaped form too.
      const escaped = JSON.stringify(file).slice(1, -1);
      return calls.some(text => text.includes(file) || text.includes(escaped));
    })
    .map(({ skill }) => skill);
}
