import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEY_MANAGED_SKILLS_SUBDIR } from './codey-skills';

export const BROWSER_SKILL_NAME = 'browser';

/**
 * The Browser plugin's discovery layer. Every agent Codey runs finds skills
 * through `.claude/skills` or `.agents/skills`, so one markdown file reaches
 * claude-code, codex, opencode and pi alike — including agents with no MCP
 * surface at all. Only the description stays in context; an agent reads the
 * body when a task actually needs the browser.
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

let cached: string | undefined;

/** The skill's markdown, read once per process — it ships with the build and
 *  cannot change under a running Codey. */
export function browserSkillMarkdown(): string {
  if (cached === undefined) cached = fs.readFileSync(BROWSER_SKILL_SOURCE, 'utf8');
  return cached;
}

function browserSkillDir(home: string): string {
  return path.join(path.resolve(home), CODEY_MANAGED_SKILLS_SUBDIR, BROWSER_SKILL_NAME);
}

/**
 * Write the Browser skill into Codey's managed skill root, overwriting an
 * older copy so a Codey upgrade always ships the current instructions. The
 * managed root is separate from the user's own `~/.codey/skills` so nothing
 * hand-written is ever overwritten or removed.
 */
export async function installBrowserSkill(home: string = os.homedir()): Promise<string> {
  const dir = browserSkillDir(home);
  const file = path.join(dir, 'SKILL.md');
  const markdown = browserSkillMarkdown();
  let current: string | undefined;
  try {
    current = await fs.promises.readFile(file, 'utf8');
  } catch {
    // Missing or unreadable: write it below.
  }
  if (current === markdown) return file;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, markdown, 'utf8');
  return file;
}

/** Remove the managed Browser skill. Turning the plugin off takes the
 *  capability out of every agent's skill list, not just out of its env. */
export async function removeBrowserSkill(home: string = os.homedir()): Promise<boolean> {
  const dir = browserSkillDir(home);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
