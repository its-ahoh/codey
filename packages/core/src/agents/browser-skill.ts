import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEY_GLOBAL_SKILLS_SUBDIR } from './codey-skills';

export const BROWSER_SKILL_NAME = 'browser';

/**
 * The Browser plugin's discovery layer. Every agent Codey runs finds skills
 * through `.claude/skills` or `.agents/skills`, so one markdown file reaches
 * claude-code, codex, opencode and pi alike — including agents with no MCP
 * surface at all. Only the description stays in context; an agent reads the
 * body when a task actually needs the browser.
 *
 * Installing puts it in `~/.codey/skills`, the user's own skill root, so it is
 * an ordinary skill from that moment on: the Skills tab can disable or delete
 * it and those actions hold, because nothing rewrites it behind the user's
 * back. Codey installs and uninstalls only when asked.
 *
 * The skill is discovery only. The capability gate is the environment:
 * `addCodeyBrowserTools` passes `CODEY_BROWSER_*` to task-performing turns
 * only, and the CLI refuses to do anything without them.
 *
 * The text lives in `src/skills/<name>/SKILL.md` rather than a template
 * literal: it is prose an agent reads, and prose is easier to get right when
 * it is written as markdown. `npm run build` copies the directory next to the
 * compiled JS, so this path resolves the same from `src` and from `dist`.
 */
export const BROWSER_SKILL_SOURCE = path.join(
  __dirname, '..', 'skills', BROWSER_SKILL_NAME, 'SKILL.md',
);

/** Skill files are named by convention; a disabled skill keeps the second
 *  name so agents stop scanning it. See the Skills tab's on/off toggle. */
const SKILL_FILE = 'SKILL.md';
const DISABLED_SKILL_FILE = 'SKILL.md.disabled';

/**
 * What the user's copy of the skill is doing right now, read from disk rather
 * than from config: the Plugins tab, the Skills tab and a hand-run `rm` all
 * change the same thing, so the disk is the only state that cannot disagree
 * with itself.
 *
 * - `absent` — not installed; the plugin is off and no agent sees it.
 * - `disabled` — installed but switched off in the Skills tab.
 * - `installed` — active; agents discover it and the capability is on.
 */
export type BrowserSkillState = 'absent' | 'disabled' | 'installed';

export interface BrowserSkillStatus {
  state: BrowserSkillState;
  /** The installed copy differs from the one this build ships. The CLI it
   *  documents ships with the app, so a stale copy can describe commands that
   *  no longer exist. */
  updateAvailable: boolean;
}

let cached: string | undefined;

/** The skill's markdown, read once per process — it ships with the build and
 *  cannot change under a running Codey. */
export function browserSkillMarkdown(): string {
  if (cached === undefined) cached = fs.readFileSync(BROWSER_SKILL_SOURCE, 'utf8');
  return cached;
}

/** Where an installed copy lives: the user's own global skill root. */
export function browserSkillDir(home: string = os.homedir()): string {
  return path.join(path.resolve(home), CODEY_GLOBAL_SKILLS_SUBDIR, BROWSER_SKILL_NAME);
}

export function browserSkillStatus(home: string = os.homedir()): BrowserSkillStatus {
  const dir = browserSkillDir(home);
  for (const [file, state] of [[SKILL_FILE, 'installed'], [DISABLED_SKILL_FILE, 'disabled']] as const) {
    let installed: string;
    try {
      installed = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    return { state, updateAvailable: installed !== browserSkillMarkdown() };
  }
  return { state: 'absent', updateAvailable: false };
}

/** True when agents can both find the skill and be handed the bridge. */
export function isBrowserSkillActive(home: string = os.homedir()): boolean {
  return browserSkillStatus(home).state === 'installed';
}

/**
 * Install (or update) the user's copy. Only ever called for an explicit user
 * action, so it overwrites: pressing Install on an installed-but-stale copy is
 * how the user asks for the current text. A leftover `SKILL.md.disabled` is
 * removed with it — installing means the user wants the skill on, and leaving
 * both files behind would break the Skills tab's toggle.
 */
export async function installBrowserSkill(home: string = os.homedir()): Promise<string> {
  const dir = browserSkillDir(home);
  const file = path.join(dir, SKILL_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, browserSkillMarkdown(), 'utf8');
  await fs.promises.rm(path.join(dir, DISABLED_SKILL_FILE), { force: true });
  return file;
}

/** Remove the user's copy. Uninstalling takes the capability out of every
 *  agent's skill list, not just out of its env. */
export async function uninstallBrowserSkill(home: string = os.homedir()): Promise<boolean> {
  try {
    await fs.promises.rm(browserSkillDir(home), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
