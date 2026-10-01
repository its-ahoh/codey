import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEY_SKILLS_REPO, CODEY_SKILLS_REPO_REF, CODEY_SKILLS_REPO_URL, CODEY_INSTALL_MARKER, type BrowserSkillStatus } from './browser-skill';
import { CODEY_GLOBAL_SKILLS_SUBDIR } from './codey-skills';

/**
 * A skill pack is a plugin made of many skills: every directory under one
 * folder of the skills repository, installed side by side into
 * `~/.codey/skills/<name>` so each agent discovers them one level deep, the only
 * depth every agent scans.
 *
 * pstack is the one pack today. Its skills carry extra files beside SKILL.md
 * (`poteto-mode` has 44 playbooks), so an install downloads whole folders, not
 * one markdown file the way the Browser plugin does.
 *
 * A manifest outside the skills root records which names the pack owns and the
 * version it installed. It is what Uninstall deletes and what Update compares;
 * without it, a pack's 47 directories would be indistinguishable from skills
 * the user wrote.
 */
export const PSTACK_PACK_ID = 'pstack';
/** The repository folder whose subdirectories are pstack's skills. */
export const PSTACK_REPO_DIR = 'skills';

const SKILL_FILE = 'SKILL.md';
const DISABLED_SKILL_FILE = 'SKILL.md.disabled';
const DOWNLOAD_CONCURRENCY = 8;

export interface SkillPackManifest {
  /** Tree hash of the pack's repository folder — the pack's version. */
  hash: string;
  /** Skill directory names the pack installed. */
  skills: string[];
  from: string;
  installedAt: string;
}

export type SkillPackInstallResult =
  | { installed: true; skills: string[]; file: string; source: 'repository' }
  /** Refused: these names already exist and Codey did not write them. `dir`
   *  is the first one, for callers that show a single path. */
  | { installed: false; conflict: 'user-copy'; dir: string; names: string[] };

interface TreeEntry { path: string; type: string; sha: string }

function skillsRoot(home: string): string {
  return path.join(path.resolve(home), CODEY_GLOBAL_SKILLS_SUBDIR);
}

export function skillPackManifestPath(id: string = PSTACK_PACK_ID, home: string = os.homedir()): string {
  return path.join(path.resolve(home), '.codey', 'plugins', `${id}.json`);
}

export function readSkillPackManifest(id: string = PSTACK_PACK_ID, home: string = os.homedir()): SkillPackManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(skillPackManifestPath(id, home), 'utf8')) as Partial<SkillPackManifest>;
    if (typeof parsed.hash !== 'string' || !Array.isArray(parsed.skills)) return undefined;
    const skills = parsed.skills.filter((name): name is string => typeof name === 'string' && isSafeSkillName(name));
    return { hash: parsed.hash, skills, from: String(parsed.from ?? ''), installedAt: String(parsed.installedAt ?? '') };
  } catch {
    return undefined;
  }
}

/** A directory name that cannot climb out of the skills root. */
function isSafeSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/** The SKILL.md (or disabled copy) in a directory, if any. */
function readSkillFile(dir: string): string | undefined {
  for (const file of [SKILL_FILE, DISABLED_SKILL_FILE]) {
    try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { /* next */ }
  }
  return undefined;
}

/** True when a directory holds something Codey did not write. */
function isUserOwned(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const text = readSkillFile(dir);
  return text === undefined || !text.includes(CODEY_INSTALL_MARKER);
}

export function skillPackStatus(id: string = PSTACK_PACK_ID, home: string = os.homedir()): BrowserSkillStatus {
  const base = { dir: skillsRoot(home), sourceUrl: `${CODEY_SKILLS_REPO_URL}/tree/${CODEY_SKILLS_REPO_REF}/${PSTACK_REPO_DIR}` };
  const manifest = readSkillPackManifest(id, home);
  if (!manifest) return { ...base, state: 'absent' };
  const anyActive = manifest.skills.some(name => fs.existsSync(path.join(base.dir, name, SKILL_FILE)));
  return { ...base, state: anyActive ? 'installed' : 'disabled', origin: 'codey', hash: manifest.hash };
}

async function fetchTree(timeoutMs: number): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${CODEY_SKILLS_REPO}/git/trees/${CODEY_SKILLS_REPO_REF}?recursive=1`;
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'codey' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const body = await response.json() as { tree?: unknown; truncated?: unknown };
  // A truncated tree would install a partial pack and call it complete.
  if (body.truncated === true) throw new Error('The skills repository tree is too large to read in one request');
  if (!Array.isArray(body.tree)) throw new Error(`${url} returned no tree`);
  return body.tree.filter((e): e is TreeEntry =>
    typeof e?.path === 'string' && typeof e?.type === 'string' && typeof e?.sha === 'string');
}

/** The pack's version and its files, grouped by skill. */
function packContents(tree: TreeEntry[], repoDir: string): { hash: string; skills: Map<string, string[]>; folderHash: Map<string, string> } {
  const root = tree.find(e => e.path === repoDir && e.type === 'tree');
  if (!root || !/^[0-9a-f]{40}$/.test(root.sha)) throw new Error(`no ${repoDir} folder in the skills repository`);
  const skills = new Map<string, string[]>();
  const folderHash = new Map<string, string>();
  for (const entry of tree) {
    if (!entry.path.startsWith(`${repoDir}/`)) continue;
    const rest = entry.path.slice(repoDir.length + 1);
    const [name, ...inner] = rest.split('/');
    if (!isSafeSkillName(name)) continue;
    if (inner.length === 0) {
      if (entry.type === 'tree') folderHash.set(name, entry.sha);
      continue;
    }
    if (entry.type !== 'blob') continue;
    // Refuse paths a malicious tree could use to escape the skill directory.
    if (inner.some(part => part === '' || part === '.' || part === '..')) continue;
    const files = skills.get(name) ?? [];
    files.push(inner.join('/'));
    skills.set(name, files);
  }
  for (const [name, files] of skills) {
    if (!files.includes(SKILL_FILE)) skills.delete(name);
  }
  if (skills.size === 0) throw new Error(`${repoDir} in the skills repository holds no skills`);
  return { hash: root.sha, skills, folderHash };
}

function rawUrl(repoPath: string): string {
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${CODEY_SKILLS_REPO}/${CODEY_SKILLS_REPO_REF}/${encoded}`;
}

async function download(repoPath: string, timeoutMs: number): Promise<Buffer> {
  const url = rawUrl(repoPath);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** A SKILL.md download that is the skill we asked for, not a proxy's page. */
function isPublishedSkill(text: string, name: string): boolean {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (!frontmatter) return false;
  return new RegExp(`^name:[ \t]*${name}[ \t]*$`, 'm').test(frontmatter)
    && /^description:[ \t]*\S/m.test(frontmatter);
}

function stamp(markdown: string, name: string, hash: string | undefined, pack: string, today: string): string {
  const line = `${CODEY_INSTALL_MARKER} ${name}${hash ? ` ${hash}` : ''} from ${CODEY_SKILLS_REPO} (${pack}) on ${today}. `
    + 'Manage it in Tools -> Plugins; edits here are replaced by the next update. -->';
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(markdown);
  if (!frontmatter) return `${line}\n\n${markdown}`;
  return `${markdown.slice(0, frontmatter[0].length)}\n${line}\n\n${markdown.slice(frontmatter[0].length).replace(/^\n+/, '')}`;
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run));
}

/**
 * Install (or update) every skill in the pack. Downloads everything into a
 * staging directory first and only then swaps it into place, so a dropped
 * connection leaves the previous install — or nothing — rather than half a
 * pack. There is no bundled fallback: the pack is too large to ship in the app.
 *
 * Refuses, writing nothing, when any name is taken by a skill Codey did not
 * write; `force` is the caller's confirmation to replace them.
 */
export async function installSkillPack(
  home: string = os.homedir(),
  { id = PSTACK_PACK_ID, repoDir = PSTACK_REPO_DIR, force = false, timeoutMs = 15000, today = new Date().toISOString().slice(0, 10) }: {
    id?: string; repoDir?: string; force?: boolean; timeoutMs?: number; today?: string;
  } = {},
): Promise<SkillPackInstallResult> {
  const root = skillsRoot(home);
  const tree = await fetchTree(timeoutMs);
  const { hash, skills, folderHash } = packContents(tree, repoDir);
  const names = [...skills.keys()].sort();

  const taken = names.filter(name => isUserOwned(path.join(root, name)));
  if (taken.length && !force) {
    return { installed: false, conflict: 'user-copy', dir: path.join(root, taken[0]), names: taken };
  }

  const manifestFile = skillPackManifestPath(id, home);
  const staging = path.join(path.dirname(manifestFile), `.${id}-staging-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(staging, { recursive: true });
  try {
    const files = names.flatMap(name => skills.get(name)!.map(file => ({ name, file })));
    await inBatches(files, DOWNLOAD_CONCURRENCY, async ({ name, file }) => {
      let bytes = await download(`${repoDir}/${name}/${file}`, timeoutMs);
      if (file === SKILL_FILE) {
        const text = bytes.toString('utf8');
        if (!isPublishedSkill(text, name)) throw new Error(`${repoDir}/${name}/${SKILL_FILE} is not the ${name} skill`);
        bytes = Buffer.from(stamp(text, name, folderHash.get(name), id, today), 'utf8');
      }
      const target = path.join(staging, name, file);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, bytes);
    });

    await fs.promises.mkdir(root, { recursive: true });
    for (const name of names) {
      const dest = path.join(root, name);
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.rename(path.join(staging, name), dest);
    }
    // Skills the previous install had but the pack no longer publishes.
    for (const name of readSkillPackManifest(id, home)?.skills ?? []) {
      if (skills.has(name)) continue;
      const dir = path.join(root, name);
      if (!isUserOwned(dir)) await fs.promises.rm(dir, { recursive: true, force: true });
    }
    const manifest: SkillPackManifest = { hash, skills: names, from: CODEY_SKILLS_REPO, installedAt: today };
    await fs.promises.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  return { installed: true, skills: names, file: manifestFile, source: 'repository' };
}

/** Turn every skill in the pack on or off, the way the Skills tab does one. */
export async function setSkillPackEnabled(
  enabled: boolean,
  home: string = os.homedir(),
  { id = PSTACK_PACK_ID }: { id?: string } = {},
): Promise<void> {
  const manifest = readSkillPackManifest(id, home);
  if (!manifest) throw new Error(`Plugin ${id} is not installed`);
  const root = skillsRoot(home);
  for (const name of manifest.skills) {
    const dir = path.join(root, name);
    const [from, to] = enabled ? [DISABLED_SKILL_FILE, SKILL_FILE] : [SKILL_FILE, DISABLED_SKILL_FILE];
    if (fs.existsSync(path.join(dir, to)) || !fs.existsSync(path.join(dir, from))) continue;
    await fs.promises.rename(path.join(dir, from), path.join(dir, to));
  }
}

/**
 * Remove every skill the pack installed, then its manifest. A name the user
 * has since replaced with their own skill is kept unless `force`.
 */
export async function uninstallSkillPack(
  home: string = os.homedir(),
  { id = PSTACK_PACK_ID, force = false }: { id?: string; force?: boolean } = {},
): Promise<{ removed: boolean; conflict?: 'user-copy'; names?: string[] }> {
  const manifest = readSkillPackManifest(id, home);
  if (!manifest) return { removed: false };
  const root = skillsRoot(home);
  const taken = manifest.skills.filter(name => isUserOwned(path.join(root, name)));
  if (taken.length && !force) return { removed: false, conflict: 'user-copy', names: taken };
  for (const name of manifest.skills) await fs.promises.rm(path.join(root, name), { recursive: true, force: true });
  await fs.promises.rm(skillPackManifestPath(id, home), { force: true });
  return { removed: true };
}

/** Compare the installed pack against the published folder. Throws offline. */
export async function checkSkillPackUpdate(
  home: string = os.homedir(),
  { id = PSTACK_PACK_ID, repoDir = PSTACK_REPO_DIR, timeoutMs = 5000 }: { id?: string; repoDir?: string; timeoutMs?: number } = {},
): Promise<{ recorded?: string; current: string; needsUpdate: boolean }> {
  const tree = await fetchTree(timeoutMs);
  const root = tree.find(e => e.path === repoDir && e.type === 'tree');
  if (!root) throw new Error(`no ${repoDir} folder in the skills repository`);
  const recorded = readSkillPackManifest(id, home)?.hash;
  return { recorded, current: root.sha, needsUpdate: recorded !== undefined && recorded !== root.sha };
}
