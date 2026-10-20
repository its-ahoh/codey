// packages/core/src/playbook-skills.ts
//
// A saved playbook IS an agent skill: Codey writes it as
// `<project>/.codey/skills/playbook-<name>/SKILL.md` and links it into every
// agent's discovery directory. The agent decides when to use it, in whatever
// language the user writes. The SkillStore stays the ledger (versions,
// counters); the SKILL.md is what agents read.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { atomicWrite } from './utils/fs';
import { SkillEntry, SkillStore } from './skill-crystallizer';
import { CODEY_SKILLS_SUBDIR, CODEY_SKILL_DISCOVERY_SUBDIRS, PLAYBOOK_PREFIX, syncCodeyProjectSkills } from './agents/codey-skills';

const execFileAsync = promisify(execFile);

// Every playbook skill name starts with PLAYBOOK_PREFIX, so one fixed
// exclude block covers all of them and a use is easy to spot in tool calls.

const EXCLUDE_BEGIN = '# >>> codey learned skills (local only)';
const EXCLUDE_BLOCK = `${EXCLUDE_BEGIN}
/${CODEY_SKILLS_SUBDIR}/${PLAYBOOK_PREFIX}*
${CODEY_SKILL_DISCOVERY_SUBDIRS.map(d => `/${d}/${PLAYBOOK_PREFIX}*`).join('\n')}
# <<< codey learned skills
`;

export function playbookSkillName(name: string): string {
  return name.startsWith(PLAYBOOK_PREFIX) ? name : `${PLAYBOOK_PREFIX}${name}`;
}

export function playbookSkillDir(workingDir: string, name: string): string {
  return path.join(workingDir, CODEY_SKILLS_SUBDIR, name);
}

function skillFile(workingDir: string, name: string): string {
  return path.join(playbookSkillDir(workingDir, name), 'SKILL.md');
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function describe(skill: SkillEntry): string {
  // Agents choose a skill by its description, so it carries "when" as well.
  return skill.whenToUse ? `${skill.description} ${skill.whenToUse}` : skill.description;
}

export function renderPlaybookSkill(skill: SkillEntry): string {
  const inputs = skill.parameters?.length
    ? `## Inputs

${skill.parameters.map(p => `- «${p.name}» — determine from the task (${p.ext ? `${p.kind}, .${p.ext}` : p.kind})`).join('\n')}

`
    : '';
  return `---
name: ${JSON.stringify(skill.name)}
description: ${JSON.stringify(describe(skill))}
---

# ${skill.name} (v${skill.version})

<!-- Learned by Codey from earlier runs. Hand edits are kept as a new version. -->

## When to use

${skill.whenToUse}

${inputs}## Steps

${skill.steps}
`;
}

/** Read back what the user changed: the frontmatter description and the
 *  "When to use" / "Steps" sections. Without a Steps heading the whole body
 *  is taken as the steps. */
export function parsePlaybookSkill(text: string): { description?: string; whenToUse?: string; steps: string } {
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const body = front ? text.slice(front[0].length) : text;
  let description: string | undefined;
  const line = front?.[1].split('\n').find(l => l.startsWith('description:'));
  if (line) {
    const raw = line.slice('description:'.length).trim();
    try { description = JSON.parse(raw); } catch { description = raw.replace(/^['"]|['"]$/g, ''); }
  }
  const section = (heading: string): string | undefined => {
    const match = new RegExp(`^## ${heading}\\s*$`, 'm').exec(body);
    if (!match) return undefined;
    const rest = body.slice(match.index + match[0].length);
    const next = /^## /m.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).trim();
  };
  const whenToUse = section('When to use');
  const steps = section('Steps') ?? body.replace(/^# .*\n/, '').trim();
  if (description && whenToUse && description.endsWith(` ${whenToUse}`)) {
    description = description.slice(0, -(whenToUse.length + 1));
  }
  return { description, whenToUse, steps };
}

/** True when a skill of this name already exists that Codey does not own,
 *  so saving would shadow or overwrite the user's own skill. */
export async function playbookNameTaken(workingDir: string, name: string): Promise<boolean> {
  const candidates = [
    playbookSkillDir(workingDir, name),
    ...CODEY_SKILL_DISCOVERY_SUBDIRS.map(d => path.join(workingDir, d, name)),
  ];
  for (const candidate of candidates) {
    try { await fsp.lstat(candidate); return true; } catch { /* free */ }
  }
  return false;
}

/** Keep learned project skills out of `git status` with a local-only exclude
 *  block. Written once per working directory; if the user later removes it,
 *  the ledger remembers and it is not added back. */
export async function ensureLocalExclude(store: SkillStore, workingDir: string): Promise<void> {
  if (store.hasLocalExclude(workingDir)) return;
  let excludePath: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: workingDir });
    excludePath = path.resolve(workingDir, stdout.trim());
  } catch {
    return; // Not a git repository: nothing to keep out of it.
  }
  let current = '';
  try { current = await fsp.readFile(excludePath, 'utf-8'); } catch { /* created below */ }
  if (!current.includes(EXCLUDE_BEGIN)) {
    await fsp.mkdir(path.dirname(excludePath), { recursive: true });
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    await fsp.writeFile(excludePath, `${current}${separator}${EXCLUDE_BLOCK}`);
  }
  store.recordLocalExclude(workingDir);
}

/** Write (or rewrite) a playbook's SKILL.md and expose it to every agent. */
export async function writePlaybookSkill(store: SkillStore, skill: SkillEntry, workingDir: string): Promise<void> {
  const file = skillFile(workingDir, skill.name);
  const body = renderPlaybookSkill(skill);
  await ensureLocalExclude(store, workingDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, body);
  store.setSkillHash(skill.name, hashOf(body));
  await syncCodeyProjectSkills(workingDir);
}

/** Remove a playbook's SKILL.md; the sync drops the links that pointed at it. */
export async function removePlaybookSkill(workingDir: string, name: string): Promise<void> {
  await fsp.rm(playbookSkillDir(workingDir, name), { recursive: true, force: true });
  await syncCodeyProjectSkills(workingDir);
}

/** If the user edited the SKILL.md since Codey last wrote it, keep that edit
 *  as the next version so evolution continues from it. Returns true when an
 *  edit was absorbed. */
export async function absorbPlaybookEdit(store: SkillStore, name: string, workingDir: string): Promise<boolean> {
  const skill = store.get(name);
  if (!skill?.skillHash) return false;
  let text: string;
  try { text = await fsp.readFile(skillFile(workingDir, name), 'utf-8'); } catch { return false; }
  const hash = hashOf(text);
  if (hash === skill.skillHash) return false;
  const edited = parsePlaybookSkill(text);
  if (edited.whenToUse) skill.whenToUse = edited.whenToUse;
  store.absorbEdit(name, edited.steps || skill.steps, edited.description);
  store.setSkillHash(name, hash);
  return true;
}

/** Bring the ledger and the files in line: older saved playbooks get the
 *  prefix and a SKILL.md, and an active playbook whose file went missing is
 *  written again. Legacy hand-promoted playbooks are left alone. */
export async function reconcilePlaybookSkills(store: SkillStore, workingDir: string): Promise<string[]> {
  const written: string[] = [];
  for (const skill of store.getActive()) {
    if (skill.promotedToSkill) continue;
    if (!skill.name.startsWith(PLAYBOOK_PREFIX)) {
      const renamed = playbookSkillName(skill.name);
      if (store.get(renamed) || await playbookNameTaken(workingDir, renamed)) continue;
      store.rename(skill.name, renamed);
    }
    try {
      await fsp.access(skillFile(workingDir, skill.name));
    } catch {
      await writePlaybookSkill(store, skill, workingDir);
      written.push(skill.name);
    }
  }
  return written;
}

/** Playbook skills the agent used this run: a Skill tool call naming it, or a
 *  read of its SKILL.md. Matched as a whole name so `playbook-x` does not hit
 *  `playbook-x-y`. Adapters that report no tool events yield none. */
export function playbookSkillsUsed(
  // Chat entries carry start/end events; channel records are one per call.
  toolCalls: { type?: string; message?: string; input?: unknown }[] | undefined,
  skills: SkillEntry[],
): SkillEntry[] {
  if (!toolCalls?.length) return [];
  const calls = toolCalls
    .filter(c => c.type === undefined || c.type === 'tool_start')
    .map(c => `${c.message ?? ''} ${JSON.stringify(c.input ?? {})}`);
  return skills.filter(skill => {
    if (!skill.name.startsWith(PLAYBOOK_PREFIX)) return false;
    const whole = new RegExp(`(^|[^a-z0-9-])${skill.name}([^a-z0-9-]|$)`);
    return calls.some(text => whole.test(text));
  });
}
