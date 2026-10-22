import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { CODEY_INSTALL_MARKER } from './browser-skill';
import { CODEY_GLOBAL_SKILLS_SUBDIR } from './codey-skills';

const execFileAsync = promisify(execFile);

/**
 * A skill pack is a set of skills the user imports in one step — a git
 * repository, a GitHub folder link, or a local folder whose subdirectories
 * each hold a SKILL.md. pstack is the usual example. Every skill is installed
 * side by side into `~/.codey/skills/<name>`, the shared root every agent
 * discovers one level deep, so the whole pack reaches every agent at once.
 *
 * A manifest outside the skills root records which names the pack owns, where
 * it came from and which commit it installed. It is what Uninstall deletes and
 * what Update compares; without it, a pack's directories would be
 * indistinguishable from skills the user wrote.
 *
 * Codey ships no pack of its own. The user picks the source.
 */
const SKILL_FILE = 'SKILL.md';
const DISABLED_SKILL_FILE = 'SKILL.md.disabled';
const GIT_TIMEOUT_MS = 120_000;

/** Where pstack lived before Codey stopped publishing a copy of it. A legacy
 *  install is migrated to a pack pointing here so Update keeps working. */
export const PSTACK_UPSTREAM_SOURCE = 'https://github.com/cursor/plugins/tree/main/pstack';

export interface SkillPackManifest {
  id: string;
  /** What the user typed, normalized: a git URL, a GitHub folder link, or an
   *  absolute local path. Update installs from it again. */
  source: string;
  /** Commit the pack was installed from; absent for a local folder or a
   *  migrated install whose commit is unknown. */
  commit?: string;
  /** Skill directory names the pack installed. */
  skills: string[];
  installedAt: string;
}

export interface SkillPackInfo extends SkillPackManifest {
  /** 'disabled' when every skill in the pack is turned off. */
  state: 'installed' | 'disabled';
  /** The shared skills root the pack's skills live in. */
  dir: string;
}

export type SkillPackInstallResult =
  /** `single` is set when the source was one skill, not a pack: it is copied
   *  in as a plain skill with no manifest, so it never shows up as a pack. */
  | { installed: true; id: string; skills: string[]; dir: string; single?: true }
  /** Refused: these names already exist and the pack did not write them. */
  | { installed: false; conflict: 'user-copy'; id: string; dir: string; names: string[] };

export type SkillPackSource =
  | { kind: 'git'; url: string; ref?: string; subdir?: string; source: string }
  | { kind: 'local'; dir: string; source: string };

function skillsRoot(home: string): string {
  return path.join(path.resolve(home), CODEY_GLOBAL_SKILLS_SUBDIR);
}

function packsDir(home: string): string {
  return path.join(path.resolve(home), '.codey', 'skill-packs');
}

/** A directory name that cannot climb out of the skills root. */
function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

export function skillPackManifestPath(id: string, home: string = os.homedir()): string {
  return path.join(packsDir(home), `${id}.json`);
}

export function readSkillPackManifest(id: string, home: string = os.homedir()): SkillPackManifest | undefined {
  if (!isSafeName(id)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(skillPackManifestPath(id, home), 'utf8')) as Partial<SkillPackManifest>;
    if (typeof parsed.source !== 'string' || !Array.isArray(parsed.skills)) return undefined;
    const skills = parsed.skills.filter((name): name is string => typeof name === 'string' && isSafeName(name));
    return {
      id,
      source: parsed.source,
      ...(typeof parsed.commit === 'string' ? { commit: parsed.commit } : {}),
      skills,
      installedAt: String(parsed.installedAt ?? ''),
    };
  } catch {
    return undefined;
  }
}

function packState(manifest: SkillPackManifest, home: string): SkillPackInfo['state'] {
  const root = skillsRoot(home);
  return manifest.skills.some(name => fs.existsSync(path.join(root, name, SKILL_FILE))) ? 'installed' : 'disabled';
}

export function listSkillPacks(home: string = os.homedir()): SkillPackInfo[] {
  let files: string[];
  try { files = fs.readdirSync(packsDir(home)); } catch { return []; }
  return files
    .filter(file => file.endsWith('.json'))
    .map(file => readSkillPackManifest(file.slice(0, -'.json'.length), home))
    .filter((manifest): manifest is SkillPackManifest => manifest !== undefined)
    .map(manifest => ({ ...manifest, state: packState(manifest, home), dir: skillsRoot(home) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** lstat, not stat: a symlink is reported as itself, never as its target. */
function lexists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

function isRegularFile(target: string): boolean {
  try { return fs.lstatSync(target).isFile(); } catch { return false; }
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

/**
 * Read what the user typed. A path is a local folder; a GitHub `tree` link
 * names a folder inside a repository (pstack lives in one); anything else is
 * handed to git as a clone URL.
 */
export function parseSkillPackSource(input: string, home: string = os.homedir()): SkillPackSource {
  const text = input.trim();
  if (!text) throw new Error('Enter a git URL, a GitHub folder link, or a local folder');
  if (text === '~' || text.startsWith('~/') || text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) {
    const dir = path.resolve(text === '~' ? home : text.startsWith('~/') ? path.join(home, text.slice(2)) : text);
    return { kind: 'local', dir, source: dir };
  }
  const tree = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+?))?\/?$/.exec(text);
  if (tree) {
    const [, owner, repo, ref, subdir] = tree;
    if (subdir?.split('/').some(part => part === '..' || part === '.')) throw new Error(`Not a folder inside the repository: ${subdir}`);
    return {
      kind: 'git',
      url: `https://github.com/${owner}/${repo}.git`,
      ref,
      ...(subdir ? { subdir } : {}),
      source: `https://github.com/${owner}/${repo}/tree/${ref}${subdir ? `/${subdir}` : ''}`,
    };
  }
  if (text.startsWith('-')) throw new Error(`Not a git URL: ${text}`);
  return { kind: 'git', url: text, source: text.replace(/\/+$/, '') };
}

/** The pack's name: the folder it was taken from, or the repository's. */
export function skillPackId(source: SkillPackSource): string {
  const segments = (source.kind === 'local' ? source.dir : source.subdir ?? source.url.replace(/[:]/g, '/'))
    .split('/')
    .map(part => part.replace(/\.git$/, ''))
    .filter(Boolean);
  // A generic `skills` folder says nothing about the pack; its parent does.
  let base = segments.pop() ?? '';
  if (base === 'skills' && segments.length) base = segments.pop()!;
  const id = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '');
  if (!id || !isSafeName(id)) throw new Error('Could not name this skill pack from its source');
  return id;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    // A private repository must fail, not wait for a password nobody can type.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/** Skill folders inside a pack root: its `skills/` folder when it has one,
 *  otherwise its own children. */
function findPackSkills(root: string): Map<string, string> {
  const scan = (dir: string): Map<string, string> => {
    const found = new Map<string, string>();
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeName(entry.name)) continue;
      const skillDir = path.join(dir, entry.name);
      // A symlinked SKILL.md could point anywhere, and stamping it would
      // write there. Only a real file makes a folder a skill.
      if (isRegularFile(path.join(skillDir, SKILL_FILE))) found.set(entry.name, skillDir);
    }
    return found;
  };
  const nested = scan(path.join(root, 'skills'));
  const skills = nested.size ? nested : scan(root);
  if (skills.size === 0) throw new Error(`No skills found in ${root}: expected folders that each hold a ${SKILL_FILE}`);
  return skills;
}

/** A single skill keeps the name of the folder (or repository) it came from. */
function singleSkillName(source: SkillPackSource): string {
  const from = source.kind === 'local' ? source.dir : source.subdir ?? source.url.replace(/[:]/g, '/');
  const name = from.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? '';
  if (!isSafeName(name)) throw new Error(`Could not name this skill from its source: ${source.source}`);
  return name;
}

function stamp(markdown: string, name: string, source: string, pack: string, today: string): string {
  const line = `${CODEY_INSTALL_MARKER} ${name} from ${source} (${pack}) on ${today}. `
    + 'Manage it in Tools -> Skills; edits here are replaced by the next update. -->';
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  if (!frontmatter) return `${line}\n\n${markdown}`;
  return `${markdown.slice(0, frontmatter[0].length)}\n${line}\n\n${markdown.slice(frontmatter[0].length).replace(/^\n+/, '')}`;
}

/**
 * Install whatever the source holds: one skill when its root has a SKILL.md,
 * otherwise a pack of skills. The user never has to say which.
 *
 * Install (or update) every skill in a pack. The source is cloned or read into
 * a staging directory first and only then swapped into place, so a failed
 * clone leaves the previous install — or nothing — rather than half a pack.
 *
 * Refuses, writing nothing, when any name is taken by a skill the pack does
 * not already own; `force` is the caller's confirmation to replace them.
 */
export async function installSkillPack(
  input: string,
  home: string = os.homedir(),
  { force = false, today = new Date().toISOString().slice(0, 10) }: { force?: boolean; today?: string } = {},
): Promise<SkillPackInstallResult> {
  const source = parseSkillPackSource(input, home);
  const id = skillPackId(source);
  const root = skillsRoot(home);
  const previous = readSkillPackManifest(id, home);

  await fs.promises.mkdir(packsDir(home), { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(packsDir(home), `.${id}-staging-`));
  try {
    let packRoot: string;
    let commit: string | undefined;
    if (source.kind === 'git') {
      const checkout = path.join(staging, 'repo');
      await git(['clone', '--depth', '1', ...(source.ref ? ['--branch', source.ref] : []), '--', source.url, checkout]);
      commit = await git(['rev-parse', 'HEAD'], checkout);
      packRoot = source.subdir ? path.join(checkout, ...source.subdir.split('/')) : checkout;
    } else {
      packRoot = source.dir;
    }
    if (!fs.existsSync(packRoot) || !fs.statSync(packRoot).isDirectory()) throw new Error(`Not a folder: ${packRoot}`);

    if (isRegularFile(path.join(packRoot, SKILL_FILE))) {
      // An installed pack whose source turned into one skill would leave its
      // manifest pointing at skills that no longer come from it.
      if (previous?.source === source.source) throw new Error(`"${id}" is installed as a skill pack, but its source is now a single skill. Remove the pack first.`);
      const name = singleSkillName(source);
      const dest = path.join(root, name);
      if (lexists(dest) && !force) {
        return { installed: false, conflict: 'user-copy', id: name, dir: dest, names: [name] };
      }
      const out = path.join(staging, 'out');
      await fs.promises.cp(packRoot, out, {
        recursive: true,
        filter: from => !fs.lstatSync(from).isSymbolicLink() && path.basename(from) !== '.git',
      });
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.rename(out, dest);
      return { installed: true, id: name, skills: [name], dir: dest, single: true };
    }

    if (previous && previous.source !== source.source) {
      throw new Error(`A skill pack named "${id}" is already installed from ${previous.source}. Remove it first.`);
    }
    const found = findPackSkills(packRoot);
    const names = [...found.keys()].sort();
    // A name is the pack's to replace only if the pack installed it and the
    // user has not since put their own skill there.
    const taken = names.filter(name => {
      const dir = path.join(root, name);
      return lexists(dir) && (!previous?.skills.includes(name) || isUserOwned(dir));
    });
    if (taken.length && !force) {
      return { installed: false, conflict: 'user-copy', id, dir: path.join(root, taken[0]), names: taken };
    }

    // An update keeps what the user turned off: a skill disabled on its own,
    // or, when the whole pack is off, every skill including new ones.
    const packOff = previous !== undefined && packState(previous, home) === 'disabled';
    const disabled = new Set(names.filter(name => previous?.skills.includes(name)
      ? fs.existsSync(path.join(root, name, DISABLED_SKILL_FILE)) && !fs.existsSync(path.join(root, name, SKILL_FILE))
      : packOff));

    const out = path.join(staging, 'out');
    for (const name of names) {
      const dest = path.join(out, name);
      // Symlinks are dropped: a pack's link can point anywhere on this Mac,
      // and an installed skill must hold only its own files.
      await fs.promises.cp(found.get(name)!, dest, {
        recursive: true,
        filter: from => !fs.lstatSync(from).isSymbolicLink(),
      });
      await fs.promises.rm(path.join(dest, DISABLED_SKILL_FILE), { force: true });
      const text = await fs.promises.readFile(path.join(found.get(name)!, SKILL_FILE), 'utf8');
      // Written fresh ('wx' refuses an existing path), never through a link.
      await fs.promises.rm(path.join(dest, SKILL_FILE), { force: true });
      await fs.promises.writeFile(path.join(dest, SKILL_FILE), stamp(text, name, source.source, id, today), { encoding: 'utf8', flag: 'wx' });
      if (disabled.has(name)) await fs.promises.rename(path.join(dest, SKILL_FILE), path.join(dest, DISABLED_SKILL_FILE));
    }

    await fs.promises.mkdir(root, { recursive: true });
    for (const name of names) {
      const dest = path.join(root, name);
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.rename(path.join(out, name), dest);
    }
    // Skills the previous install had but the pack no longer publishes.
    for (const name of previous?.skills ?? []) {
      if (found.has(name)) continue;
      const dir = path.join(root, name);
      if (!isUserOwned(dir)) await fs.promises.rm(dir, { recursive: true, force: true });
    }
    const manifest: Omit<SkillPackManifest, 'id'> = { source: source.source, ...(commit ? { commit } : {}), skills: names, installedAt: today };
    await fs.promises.writeFile(skillPackManifestPath(id, home), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { installed: true, id, skills: names, dir: root };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

/** Turn every skill in the pack on or off, the way the Skills tab does one. */
export async function setSkillPackEnabled(id: string, enabled: boolean, home: string = os.homedir()): Promise<void> {
  const manifest = readSkillPackManifest(id, home);
  if (!manifest) throw new Error(`Skill pack ${id} is not installed`);
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
  id: string,
  home: string = os.homedir(),
  { force = false }: { force?: boolean } = {},
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

/**
 * Compare the installed commit against the source's tip. A local folder has
 * no tip (`needsUpdate: null`); an install with no recorded commit always has
 * one to take. Throws when the remote cannot be reached.
 */
export async function checkSkillPackUpdate(
  id: string,
  home: string = os.homedir(),
): Promise<{ recorded?: string; current?: string; needsUpdate: boolean | null }> {
  const manifest = readSkillPackManifest(id, home);
  if (!manifest) throw new Error(`Skill pack ${id} is not installed`);
  const source = parseSkillPackSource(manifest.source, home);
  if (source.kind === 'local') return { needsUpdate: null };
  const listed = await git(['ls-remote', '--', source.url, source.ref ?? 'HEAD']);
  const current = /^([0-9a-f]{40})\s/m.exec(listed)?.[1];
  if (!current) throw new Error(`${source.url} has no ${source.ref ?? 'HEAD'}`);
  return { recorded: manifest.commit, current, needsUpdate: manifest.commit !== current };
}

/**
 * Codey used to publish its own copy of pstack and install it from the
 * Plugins tab, recording `~/.codey/plugins/pstack.json`. Turn that record into
 * an ordinary pack pointing at pstack's upstream, so the installed skills keep
 * working untouched and Update, disable and Remove move to the Skills tab.
 * Safe to run on every launch.
 */
export async function migrateLegacyPstack(home: string = os.homedir()): Promise<boolean> {
  const legacy = path.join(path.resolve(home), '.codey', 'plugins', 'pstack.json');
  let parsed: { skills?: unknown; installedAt?: unknown };
  try {
    parsed = JSON.parse(await fs.promises.readFile(legacy, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    parsed = {};
  }
  if (!readSkillPackManifest('pstack', home)) {
    const skills = Array.isArray(parsed.skills)
      ? parsed.skills.filter((name): name is string => typeof name === 'string' && isSafeName(name))
      : [];
    const manifest: Omit<SkillPackManifest, 'id'> = {
      source: PSTACK_UPSTREAM_SOURCE,
      skills,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
    };
    await fs.promises.mkdir(packsDir(home), { recursive: true });
    const target = skillPackManifestPath('pstack', home);
    await fs.promises.writeFile(`${target}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await fs.promises.rename(`${target}.tmp`, target);
  }
  await fs.promises.rm(legacy, { force: true });
  return true;
}
