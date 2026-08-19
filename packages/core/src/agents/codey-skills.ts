import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The project-owned source of truth for skills managed by Codey. */
export const CODEY_SKILLS_SUBDIR = path.join('.codey', 'skills');

/**
 * The user-owned source of truth for skills managed by Codey (`~/.codey/skills`).
 * Global skills follow the user across every workspace; project skills stay
 * with the repository that needs them.
 */
export const CODEY_GLOBAL_SKILLS_SUBDIR = CODEY_SKILLS_SUBDIR;

/**
 * Skills Codey itself ships and owns (`~/.codey/managed-skills`), kept apart
 * from the user's own `~/.codey/skills` so a plugin can rewrite or delete its
 * skill without ever touching a hand-written one.
 */
export const CODEY_MANAGED_SKILLS_SUBDIR = path.join('.codey', 'managed-skills');

/**
 * The smallest set of skill roots covering every agent Codey runs.
 * Claude Code uses its own directory; Codex, OpenCode, and pi all understand
 * the cross-agent `.agents/skills` convention. The same two conventions apply
 * at project level and under the home directory.
 */
export const CODEY_SKILL_DISCOVERY_SUBDIRS = [
  path.join('.claude', 'skills'),
  path.join('.agents', 'skills'),
] as const;

export interface CodeySkillSyncResult {
  sourceRoot: string;
  linked: string[];
  existing: string[];
  conflicts: string[];
  removed: string[];
}

function isDirectory(entryPath: string): boolean {
  try { return fs.statSync(entryPath).isDirectory(); } catch { return false; }
}

function pointsTo(linkPath: string, sourcePath: string): boolean {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
    const target = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), target) === path.resolve(sourcePath);
  } catch {
    return false;
  }
}

/**
 * Make every top-level Codey skill/collection under `sourceRoot` visible
 * through the native discovery directories below `discoveryBase`.
 *
 * Links are created per top-level entry instead of replacing an agent's whole
 * skills directory, so hand-written/native skills remain untouched. Existing
 * names are never overwritten. Relative links keep working when a project is
 * moved as a unit (Windows junctions require an absolute target).
 */
async function linkCodeySkills(sourceRoot: string, discoveryBase: string): Promise<CodeySkillSyncResult> {
  const result: CodeySkillSyncResult = { sourceRoot, linked: [], existing: [], conflicts: [], removed: [] };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  const sources = entries
    .filter(entry => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(sourceRoot, entry.name))))
    .map(entry => ({ name: entry.name, dir: path.join(sourceRoot, entry.name) }));

  for (const discoverySubdir of CODEY_SKILL_DISCOVERY_SUBDIRS) {
    const discoveryRoot = path.join(discoveryBase, discoverySubdir);
    await fs.promises.mkdir(discoveryRoot, { recursive: true });

    // Remove only broken links whose declared target is inside Codey's own
    // source root. Native links and real directories are never touched.
    const discoveryEntries = await fs.promises.readdir(discoveryRoot, { withFileTypes: true });
    for (const entry of discoveryEntries) {
      if (!entry.isSymbolicLink()) continue;
      const linkPath = path.join(discoveryRoot, entry.name);
      let target: string;
      try {
        target = path.resolve(discoveryRoot, await fs.promises.readlink(linkPath));
      } catch {
        continue;
      }
      const belongsToCodey = target.startsWith(`${sourceRoot}${path.sep}`);
      if (belongsToCodey && !fs.existsSync(target)) {
        await fs.promises.unlink(linkPath);
        result.removed.push(linkPath);
      }
    }

    for (const source of sources) {
      const linkPath = path.join(discoveryRoot, source.name);
      if (pointsTo(linkPath, source.dir)) {
        result.existing.push(linkPath);
        continue;
      }
      try {
        await fs.promises.lstat(linkPath);
        result.conflicts.push(linkPath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const target = process.platform === 'win32'
        ? source.dir
        : path.relative(discoveryRoot, source.dir);
      await fs.promises.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      result.linked.push(linkPath);
    }
  }

  return result;
}

/**
 * Expose `<project>/.codey/skills` through the project-level directories
 * watched by the supported coding agents.
 */
export async function syncCodeyProjectSkills(workingDir: string): Promise<CodeySkillSyncResult> {
  const projectRoot = path.resolve(workingDir);
  return linkCodeySkills(path.join(projectRoot, CODEY_SKILLS_SUBDIR), projectRoot);
}

/**
 * Expose `~/.codey/skills` through the user-level directories watched by the
 * supported coding agents, so a global Codey skill is available in every
 * project without being copied into any of them.
 */
export async function syncCodeyGlobalSkills(home: string = os.homedir()): Promise<CodeySkillSyncResult> {
  const homeRoot = path.resolve(home);
  return linkCodeySkills(path.join(homeRoot, CODEY_GLOBAL_SKILLS_SUBDIR), homeRoot);
}

/**
 * Expose `~/.codey/managed-skills` the same way. A managed skill appears and
 * disappears with the plugin that owns it; the links it leaves behind are
 * cleaned up on the next sync because they point back into this root.
 */
export async function syncCodeyManagedSkills(home: string = os.homedir()): Promise<CodeySkillSyncResult> {
  const homeRoot = path.resolve(home);
  return linkCodeySkills(path.join(homeRoot, CODEY_MANAGED_SKILLS_SUBDIR), homeRoot);
}
