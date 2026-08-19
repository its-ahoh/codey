import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEY_GLOBAL_SKILLS_SUBDIR } from './codey-skills';

export const BROWSER_SKILL_NAME = 'browser';

/**
 * Where Codey's skills are published. Installing pulls from here, so the text
 * can be corrected and read by anyone without shipping a new app build.
 */
export const CODEY_SKILLS_REPO_URL = 'https://github.com/its-ahoh/codey-skills';
/** The ref installs pull from. A branch keeps fixes flowing; pin a tag here if
 *  a skill ever needs to be held back from the published tip. */
export const CODEY_SKILLS_REPO_REF = 'main';

/** Raw URL of one published skill's markdown. */
export function codeySkillDownloadUrl(name: string, ref: string = CODEY_SKILLS_REPO_REF): string {
  const repo = CODEY_SKILLS_REPO_URL.replace('https://github.com/', '');
  return `https://raw.githubusercontent.com/${repo}/${ref}/skills/${name}/SKILL.md`;
}

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
 * A copy also ships with the build, at `src/skills/<name>/SKILL.md` (the build
 * copies it next to the compiled JS, so the path resolves the same from `src`
 * and `dist`). It is the fallback when the repository cannot be reached, which
 * keeps Install working offline and on a locked-down network.
 */
export const BROWSER_SKILL_SOURCE = path.join(
  __dirname, '..', 'skills', BROWSER_SKILL_NAME, 'SKILL.md',
);

/** Skill files are named by convention; a disabled skill keeps the second
 *  name so agents stop scanning it. See the Skills tab's on/off toggle. */
const SKILL_FILE = 'SKILL.md';
const DISABLED_SKILL_FILE = 'SKILL.md.disabled';

/**
 * An install stamps the file with where the text came from. Two jobs: it
 * answers "which version of this text does the user actually have" when an
 * agent runs a command the CLI does not have, and it is how Codey recognises
 * its own copy. Anything without the stamp is treated as the user's, and is
 * not overwritten or deleted without confirmation.
 *
 * It sits after the frontmatter (agents parse that from the first byte) and is
 * an HTML comment, so it renders as nothing and reads as nothing.
 */
export const CODEY_INSTALL_MARKER = '<!-- Installed by Codey from';

function stamp(markdown: string, from: string, today: string): string {
  const line = `${CODEY_INSTALL_MARKER} ${from} on ${today}. `
    + 'Manage it in Tools -> Plugins; edits here are replaced by the next update. -->';
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(markdown);
  if (!frontmatter) return `${line}\n\n${markdown}`;
  const head = markdown.slice(0, frontmatter[0].length);
  const body = markdown.slice(frontmatter[0].length).replace(/^\n+/, '');
  return `${head}\n${line}\n\n${body}`;
}

/** True for a file an install wrote. */
export function isCodeyInstalledSkill(markdown: string): boolean {
  return markdown.includes(CODEY_INSTALL_MARKER);
}

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
  /** Where an installed copy lives, so the UI can point at it whether or not
   *  it is installed yet. */
  dir: string;
  /** Who wrote the copy that is there: `codey` if it carries the stamp an
   *  install leaves, `user` for anything else — a hand-written skill of the
   *  same name, or one from before stamping. Codey overwrites its own copy
   *  freely and asks before touching the user's. */
  origin?: 'codey' | 'user';
  /** Where Install pulls from. */
  sourceUrl: string;
}

/** Which copy an install actually wrote. `bundled` means the repository could
 *  not be used, and `reason` says why. */
export type BrowserSkillInstallResult =
  | { installed: true; file: string; source: 'repository' | 'bundled'; reason?: string }
  /** Refused: a skill of this name is already there and Codey did not write
   *  it. The caller confirms with `force` — never silently. */
  | { installed: false; conflict: 'user-copy'; dir: string };

let cached: string | undefined;

/** The skill's markdown as it ships with this build — the fallback copy, read
 *  once per process, since it cannot change under a running Codey. */
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
  const base = { dir, sourceUrl: CODEY_SKILLS_REPO_URL };
  for (const [file, state] of [[SKILL_FILE, 'installed'], [DISABLED_SKILL_FILE, 'disabled']] as const) {
    let installed: string;
    try {
      installed = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    return { ...base, state, origin: isCodeyInstalledSkill(installed) ? 'codey' : 'user' };
  }
  return { ...base, state: 'absent' };
}

/** True when agents can both find the skill and be handed the bridge. */
export function isBrowserSkillActive(home: string = os.homedir()): boolean {
  return browserSkillStatus(home).state === 'installed';
}

/**
 * Reject a download that is not the skill we asked for. A raw URL can answer
 * with a redirect page, a proxy's login form or someone else's file, and
 * writing that into the user's skill root would hand every agent whatever it
 * said. Frontmatter naming this skill is the cheap check that it is ours.
 */
function isPublishedSkill(text: string, name: string): boolean {
  return new RegExp(`^---\\nname: ${name}\\ndescription: \\S`).test(text) && text.length > 400;
}

async function downloadBrowserSkill(timeoutMs: number): Promise<{ text: string; from: string }> {
  const url = codeySkillDownloadUrl(BROWSER_SKILL_NAME);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const text = await response.text();
  if (!isPublishedSkill(text, BROWSER_SKILL_NAME)) {
    throw new Error(`${url} did not return the ${BROWSER_SKILL_NAME} skill`);
  }
  // The raw host answers with the blob's hash as its ETag, so the stamp can
  // name the exact bytes without a second request for the commit. It may be
  // weak (`W/"..."`, when the body was compressed); the hash is the same.
  const version = response.headers.get('etag')?.replace(/^W\//, '').replace(/[^\w]/g, '')
    || CODEY_SKILLS_REPO_REF;
  const repo = CODEY_SKILLS_REPO_URL.replace('https://github.com/', '');
  return { text, from: `${repo}@${version.slice(0, 12)}` };
}

/**
 * Install (or update) the user's copy, pulled from the skills repository and
 * falling back to the copy bundled with this build.
 *
 * Overwrites Codey's own copy without ceremony — pressing Install or Update is
 * how the user asks for the published text. Refuses when the file there is not
 * one Codey wrote: a hand-written skill of the same name is the user's work,
 * and replacing it silently is not a thing an install may do. `force` is the
 * caller's confirmation.
 *
 * A leftover `SKILL.md.disabled` is removed on success — installing means the
 * user wants the skill on, and leaving both files behind would break the
 * Skills tab's toggle.
 */
export async function installBrowserSkill(
  home: string = os.homedir(),
  { force = false, timeoutMs = 10000, today = new Date().toISOString().slice(0, 10) }: {
    force?: boolean; timeoutMs?: number; today?: string;
  } = {},
): Promise<BrowserSkillInstallResult> {
  const dir = browserSkillDir(home);
  const existing = browserSkillStatus(home);
  if (!force && existing.origin === 'user') return { installed: false, conflict: 'user-copy', dir };

  let markdown: string;
  let source: 'repository' | 'bundled' = 'repository';
  let from = 'the copy bundled with the app';
  let reason: string | undefined;
  try {
    const downloaded = await downloadBrowserSkill(timeoutMs);
    markdown = downloaded.text;
    from = downloaded.from;
  } catch (error) {
    markdown = browserSkillMarkdown();
    source = 'bundled';
    reason = error instanceof Error ? error.message : String(error);
  }

  const file = path.join(dir, SKILL_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, stamp(markdown, from, today), 'utf8');
  await fs.promises.rm(path.join(dir, DISABLED_SKILL_FILE), { force: true });
  return { installed: true, file, source, reason };
}

/**
 * Remove the user's copy. Uninstalling takes the capability out of every
 * agent's skill list, not just out of its env.
 *
 * Like install, this deletes what Codey wrote and asks first about anything
 * else: the directory may hold a skill the user wrote, and there is no undo.
 */
export async function uninstallBrowserSkill(
  home: string = os.homedir(),
  { force = false }: { force?: boolean } = {},
): Promise<{ removed: boolean; conflict?: 'user-copy' }> {
  const dir = browserSkillDir(home);
  const existing = browserSkillStatus(home);
  if (!force && existing.origin === 'user') return { removed: false, conflict: 'user-copy' };
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}
