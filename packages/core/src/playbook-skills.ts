// packages/core/src/playbook-skills.ts
//
// A saved playbook IS an agent skill: Codey writes it as
// `<root>/.codey/skills/playbook-<name>/SKILL.md` and links it into every
// agent's discovery directory. `root` is the workspace checkout for a project
// playbook and the user's home directory for a global one — the layout below
// it is the same, only the sync differs. The agent decides when to use it, in whatever
// language the user writes. The SkillStore stays the ledger (versions,
// counters); the SKILL.md is what agents read.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { atomicWrite } from './utils/fs';
import { SkillEntry, SkillStore } from './skill-crystallizer';
import { ProcedureInput, TraceStep, clusterProcedures } from './playbook-induction';
import { CODEY_SKILLS_SUBDIR, CODEY_SKILL_DISCOVERY_SUBDIRS, PLAYBOOK_PREFIX, syncCodeyGlobalSkills, syncCodeyProjectSkills } from './agents/codey-skills';

const execFileAsync = promisify(execFile);

// Every playbook skill name starts with PLAYBOOK_PREFIX, so one fixed
// exclude block covers all of them and a use is easy to spot in tool calls.

const EXCLUDE_BEGIN = '# >>> codey learned skills (local only)';
const EXCLUDE_BLOCK = `${EXCLUDE_BEGIN}
/${CODEY_SKILLS_SUBDIR}/${PLAYBOOK_PREFIX}*
${CODEY_SKILL_DISCOVERY_SUBDIRS.map(d => `/${d}/${PLAYBOOK_PREFIX}*`).join('\n')}
# <<< codey learned skills
`;

/** Where a playbook applies: its own workspace, or every project. */
export type PlaybookScope = 'project' | 'global';

/** A ledger paired with where its SKILL.md files live. */
export interface PlaybookHome {
  scope: PlaybookScope;
  store: SkillStore;
  /** Workspace checkout (project) or the user's home directory (global). */
  root: string;
}

function syncScope(root: string, scope: PlaybookScope) {
  return scope === 'global' ? syncCodeyGlobalSkills(root) : syncCodeyProjectSkills(root);
}

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

/** Write (or rewrite) a playbook's SKILL.md and expose it to every agent.
 *  Only a project skill needs the git exclude; a global one lives in home. */
export async function writePlaybookSkill(
  store: SkillStore, skill: SkillEntry, root: string, scope: PlaybookScope = 'project',
): Promise<void> {
  const file = skillFile(root, skill.name);
  const body = renderPlaybookSkill(skill);
  if (scope === 'project') await ensureLocalExclude(store, root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, body);
  store.setSkillHash(skill.name, hashOf(body));
  await syncScope(root, scope);
}

/** Remove a playbook's SKILL.md; the sync drops the links that pointed at it. */
export async function removePlaybookSkill(root: string, name: string, scope: PlaybookScope = 'project'): Promise<void> {
  await fsp.rm(playbookSkillDir(root, name), { recursive: true, force: true });
  await syncScope(root, scope);
}

/** Move a playbook between scopes, keeping its history and counters. Refuses
 *  when the target already has that name, in its ledger or on disk. */
export async function movePlaybookSkill(from: PlaybookHome, to: PlaybookHome, name: string): Promise<void> {
  const skill = from.store.get(name);
  if (!skill) throw new Error(`Playbook not found: ${name}`);
  if (to.store.get(name) || await playbookNameTaken(to.root, name)) {
    throw new Error(`A skill named "${name}" already exists there. Rename one of them first.`);
  }
  // Fold a pending hand edit into the history before the file moves.
  await absorbPlaybookEdit(from.store, name, from.root);
  to.store.adopt({ ...skill, skillHash: undefined });
  from.store.remove(name);
  await removePlaybookSkill(from.root, name, from.scope);
  const moved = to.store.get(name)!;
  if (!moved.archived) await writePlaybookSkill(to.store, moved, to.root, to.scope);
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
export async function reconcilePlaybookSkills(
  store: SkillStore, workingDir: string, scope: PlaybookScope = 'project',
): Promise<string[]> {
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
      await writePlaybookSkill(store, skill, workingDir, scope);
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

/** Code-side evidence for a playbook's scope, checked in order before the
 *  namer's own guess. `crossWorkspace` is true when the same procedure also
 *  recurs in another workspace's runs. */
export function suggestPlaybookScope(input: {
  members: { steps?: TraceStep[] }[];
  crossWorkspace: boolean;
  aiScope?: PlaybookScope;
}): PlaybookScope {
  if (input.crossWorkspace) return 'global';
  const steps = input.members.flatMap(m => m.steps ?? []);
  const shapes = steps.flatMap(step => Object.values(step.args));
  if (shapes.some(shape => shape.kind === 'path' && shape.inProject === true)) return 'project';
  const browserOnly = steps.length > 0 && steps.every(step => /(^|__)browser/i.test(step.tool));
  const webOnly = shapes.some(shape => shape.kind === 'url') && !shapes.some(shape => shape.kind === 'path');
  if (browserOnly || webOnly) return 'global';
  return input.aiScope ?? 'project';
}

/** True when the procedure of `members` also recurs among another
 *  workspace's recent runs — the strongest sign it is not project-bound.
 *  `ownRecent` (this workspace's recent runs) is clustered alongside, so a
 *  tool's rarity is judged against ordinary activity rather than against
 *  the procedure's own runs alone. */
export function recursInOtherWorkspaces(
  members: ProcedureInput[], ownRecent: ProcedureInput[], others: ProcedureInput[][],
): boolean {
  const own = new Set(members.map(m => m.runId));
  const context = [...members, ...ownRecent.filter(t => !own.has(t.runId))];
  return others.some(other => {
    if (other.length === 0) return false;
    const foreign = new Set(other.map(o => o.runId));
    return clusterProcedures([...context, ...other], { minMembers: 2 }).clusters
      .some(c => c.runIds.some(id => own.has(id)) && c.runIds.some(id => foreign.has(id)));
  });
}
