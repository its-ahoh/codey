import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CODEY_INSTALL_MARKER } from './browser-skill';
import {
  PSTACK_UPSTREAM_SOURCE,
  checkSkillPackUpdate,
  installSkillPack,
  listSkillPacks,
  migrateLegacyPstack,
  parseSkillPackSource,
  readSkillPackManifest,
  setSkillPackEnabled,
  skillPackId,
  skillPackManifestPath,
  uninstallSkillPack,
} from './skill-pack';

let home: string;
let work: string;
const root = () => path.join(home, '.codey', 'skills');

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} does a thing, described well enough to trigger.\n---\n\nBody of ${name}.\n`;

type Files = Record<string, string>;
const PACK: Files = {
  'skills/alpha/SKILL.md': skillMd('alpha'),
  'skills/alpha/playbooks/one.md': 'playbook one',
  'skills/beta/SKILL.md': skillMd('beta'),
  // A folder without SKILL.md is not a skill and must not be installed.
  'skills/notes/README.md': 'not a skill',
  'README.md': 'a pack',
};

function writeFiles(dir: string, files: Files) {
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
}

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' }).toString().trim();

/** A git repository holding `files`; returns its file:// URL. */
function makeRepo(name: string, files: Files): string {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, files);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return `file://${dir}`;
}

function commit(url: string, files: Files, remove: string[] = []) {
  const dir = url.replace('file://', '');
  for (const file of remove) fs.rmSync(path.join(dir, file), { recursive: true, force: true });
  writeFiles(dir, files);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'next');
  return gitIn(dir, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skill-pack-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skill-pack-src-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('parseSkillPackSource', () => {
  it('splits a GitHub folder link into repository, branch and folder', () => {
    expect(parseSkillPackSource('https://github.com/cursor/plugins/tree/main/pstack/')).toEqual({
      kind: 'git',
      url: 'https://github.com/cursor/plugins.git',
      ref: 'main',
      subdir: 'pstack',
      source: PSTACK_UPSTREAM_SOURCE,
    });
  });

  it('reads paths as local folders and everything else as a clone URL', () => {
    expect(parseSkillPackSource('~/packs/mine', '/Users/me')).toMatchObject({ kind: 'local', dir: '/Users/me/packs/mine' });
    expect(parseSkillPackSource('git@github.com:me/pack.git')).toMatchObject({ kind: 'git', url: 'git@github.com:me/pack.git' });
    expect(() => parseSkillPackSource('--upload-pack=evil')).toThrow(/Not a git URL/);
    expect(() => parseSkillPackSource('https://github.com/o/r/tree/main/../x')).toThrow(/Not a folder/);
  });

  it('names a pack after its folder, or its repository', () => {
    expect(skillPackId(parseSkillPackSource(PSTACK_UPSTREAM_SOURCE))).toBe('pstack');
    expect(skillPackId(parseSkillPackSource('git@github.com:me/My_Pack.git'))).toBe('my_pack');
    expect(skillPackId(parseSkillPackSource('/tmp/superpowers/skills'))).toBe('superpowers');
  });
});

describe('installSkillPack', () => {
  it('installs every skill flat into the shared root, with its extra files, and records a manifest', async () => {
    const url = makeRepo('pack', PACK);
    const result = await installSkillPack(url, home, { today: '2026-10-21' });
    expect(result).toMatchObject({ installed: true, id: 'pack', skills: ['alpha', 'beta'], dir: root() });

    expect(fs.readFileSync(path.join(root(), 'alpha', 'playbooks', 'one.md'), 'utf8')).toBe('playbook one');
    const alpha = fs.readFileSync(path.join(root(), 'alpha', 'SKILL.md'), 'utf8');
    expect(alpha.startsWith('---\nname: alpha\n')).toBe(true);
    expect(alpha).toContain(`${CODEY_INSTALL_MARKER} alpha from ${url} (pack) on 2026-10-21`);
    expect(fs.existsSync(path.join(root(), 'notes'))).toBe(false);
    expect(fs.existsSync(path.join(root(), 'skills'))).toBe(false);
    // Nothing of the clone is left behind.
    expect(fs.readdirSync(path.join(home, '.codey', 'skill-packs'))).toEqual(['pack.json']);

    expect(readSkillPackManifest('pack', home)).toMatchObject({ source: url, skills: ['alpha', 'beta'] });
    expect(readSkillPackManifest('pack', home)?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(listSkillPacks(home)).toEqual([expect.objectContaining({ id: 'pack', state: 'installed', dir: root() })]);
  });

  it('takes a pack from a folder inside a repository, the way pstack is published', async () => {
    const url = makeRepo('plugins', {
      'pstack/skills/poteto-mode/SKILL.md': skillMd('poteto-mode'),
      'other/skills/unrelated/SKILL.md': skillMd('unrelated'),
    });
    // The repository root holds packs, not skills; it is the folder that counts.
    await expect(installSkillPack(url, home)).rejects.toThrow(/No skills found/);
    const folder = path.join(url.replace('file://', ''), 'pstack');
    expect(await installSkillPack(folder, home)).toMatchObject({ installed: true, id: 'pstack', skills: ['poteto-mode'] });
    expect(fs.existsSync(path.join(root(), 'unrelated'))).toBe(false);
  });

  it('installs a local folder whose children are skills', async () => {
    writeFiles(path.join(work, 'mine'), { 'one/SKILL.md': skillMd('one'), 'two/SKILL.md': skillMd('two') });
    expect(await installSkillPack(path.join(work, 'mine'), home)).toMatchObject({ installed: true, id: 'mine', skills: ['one', 'two'] });
    expect(readSkillPackManifest('mine', home)).toMatchObject({ source: path.join(work, 'mine') });
    expect(readSkillPackManifest('mine', home)?.commit).toBeUndefined();
  });

  it('installs a folder that is one skill as a plain skill, not a pack', async () => {
    writeFiles(path.join(work, 'solo'), { 'SKILL.md': skillMd('solo'), 'notes.md': 'extra' });
    expect(await installSkillPack(path.join(work, 'solo'), home)).toMatchObject({ installed: true, id: 'solo', skills: ['solo'], single: true });
    expect(fs.readFileSync(path.join(root(), 'solo', 'SKILL.md'), 'utf8')).toBe(skillMd('solo'));
    expect(fs.existsSync(path.join(root(), 'solo', 'notes.md'))).toBe(true);
    expect(readSkillPackManifest('solo', home)).toBeUndefined();
    expect(listSkillPacks(home)).toEqual([]);
  });

  it('asks before replacing an existing skill with a single one', async () => {
    writeFiles(path.join(root(), 'solo'), { 'SKILL.md': 'mine' });
    writeFiles(path.join(work, 'solo'), { 'SKILL.md': skillMd('solo') });
    expect(await installSkillPack(path.join(work, 'solo'), home)).toMatchObject({ installed: false, conflict: 'user-copy', names: ['solo'] });
    expect(fs.readFileSync(path.join(root(), 'solo', 'SKILL.md'), 'utf8')).toBe('mine');
    await installSkillPack(path.join(work, 'solo'), home, { force: true });
    expect(fs.readFileSync(path.join(root(), 'solo', 'SKILL.md'), 'utf8')).toBe(skillMd('solo'));
  });

  it('installs a git repository that is one skill, leaving .git behind', async () => {
    const url = makeRepo('one-skill', { 'SKILL.md': skillMd('one-skill') });
    expect(await installSkillPack(url, home)).toMatchObject({ installed: true, id: 'one-skill', single: true });
    expect(fs.existsSync(path.join(root(), 'one-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root(), 'one-skill', '.git'))).toBe(false);
  });

  it('refuses, writing nothing, when a name belongs to a skill the pack does not own', async () => {
    const url = makeRepo('pack', PACK);
    fs.mkdirSync(path.join(root(), 'beta'), { recursive: true });
    fs.writeFileSync(path.join(root(), 'beta', 'SKILL.md'), 'my own beta');

    expect(await installSkillPack(url, home)).toMatchObject({ installed: false, conflict: 'user-copy', id: 'pack', names: ['beta'] });
    expect(fs.existsSync(path.join(root(), 'alpha'))).toBe(false);
    expect(fs.readFileSync(path.join(root(), 'beta', 'SKILL.md'), 'utf8')).toBe('my own beta');
    expect(fs.existsSync(skillPackManifestPath('pack', home))).toBe(false);

    await installSkillPack(url, home, { force: true });
    expect(fs.readFileSync(path.join(root(), 'beta', 'SKILL.md'), 'utf8')).toContain('name: beta');
  });

  it('will not let one pack overwrite another pack, or a Codey plugin, of the same name', async () => {
    writeFiles(path.join(work, 'a'), { 'browser/SKILL.md': skillMd('browser') });
    fs.mkdirSync(path.join(root(), 'browser'), { recursive: true });
    fs.writeFileSync(path.join(root(), 'browser', 'SKILL.md'), `${CODEY_INSTALL_MARKER} browser -->`);
    expect(await installSkillPack(path.join(work, 'a'), home)).toMatchObject({ installed: false, names: ['browser'] });
  });

  it('never writes through a symlink in a pack, and copies no links', async () => {
    const outside = path.join(work, 'zshrc');
    fs.writeFileSync(outside, 'export SAFE=1\n');
    const dir = path.join(work, 'evil');
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-q', '-b', 'main');
    writeFiles(dir, { 'skills/good/SKILL.md': skillMd('good') });
    fs.mkdirSync(path.join(dir, 'skills', 'trap'), { recursive: true });
    // A committed symlink survives the clone, exactly as an attacker would ship it.
    fs.symlinkSync(outside, path.join(dir, 'skills', 'trap', 'SKILL.md'));
    fs.symlinkSync(outside, path.join(dir, 'skills', 'good', 'notes.md'));
    fs.symlinkSync('/', path.join(dir, 'skills', 'good', 'root'));
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'trap');

    expect(await installSkillPack(`file://${dir}`, home)).toMatchObject({ installed: true, skills: ['good'] });
    expect(fs.readFileSync(outside, 'utf8')).toBe('export SAFE=1\n');
    expect(fs.existsSync(path.join(root(), 'trap'))).toBe(false);
    expect(fs.readdirSync(path.join(root(), 'good'))).toEqual(['SKILL.md']);
    expect(fs.lstatSync(path.join(root(), 'good', 'SKILL.md')).isFile()).toBe(true);
  });

  it('asks before an update replaces a pack skill the user rewrote as their own', async () => {
    const url = makeRepo('pack', PACK);
    await installSkillPack(url, home);
    fs.writeFileSync(path.join(root(), 'alpha', 'SKILL.md'), 'my own alpha');
    expect(await installSkillPack(url, home)).toMatchObject({ installed: false, conflict: 'user-copy', names: ['alpha'] });
    expect(fs.readFileSync(path.join(root(), 'alpha', 'SKILL.md'), 'utf8')).toBe('my own alpha');
  });

  it('refuses a second source under a name already taken', async () => {
    writeFiles(path.join(work, 'x', 'pack'), { 'one/SKILL.md': skillMd('one') });
    await installSkillPack(makeRepo('pack', PACK), home);
    await expect(installSkillPack(path.join(work, 'x', 'pack'), home)).rejects.toThrow(/already installed from/);
  });

  it('leaves nothing behind when the clone fails', async () => {
    await expect(installSkillPack(`file://${work}/missing`, home)).rejects.toThrow();
    expect(fs.existsSync(root())).toBe(false);
    expect(fs.readdirSync(path.join(home, '.codey', 'skill-packs'))).toEqual([]);
  });

  it('on update, drops skills the pack no longer publishes but keeps user skills', async () => {
    const url = makeRepo('pack', PACK);
    await installSkillPack(url, home);
    writeFiles(root(), { 'mine/SKILL.md': 'mine' });

    const next = commit(url, {}, ['skills/beta']);
    await installSkillPack(url, home);

    expect(fs.existsSync(path.join(root(), 'beta'))).toBe(false);
    expect(fs.existsSync(path.join(root(), 'mine', 'SKILL.md'))).toBe(true);
    expect(readSkillPackManifest('pack', home)).toMatchObject({ commit: next, skills: ['alpha'] });
  });
});

describe('enable, uninstall and update', () => {
  it('turns every skill off and back on', async () => {
    await installSkillPack(makeRepo('pack', PACK), home);
    await setSkillPackEnabled('pack', false, home);
    expect(fs.existsSync(path.join(root(), 'alpha', 'SKILL.md.disabled'))).toBe(true);
    expect(listSkillPacks(home)[0].state).toBe('disabled');
    await setSkillPackEnabled('pack', true, home);
    expect(fs.existsSync(path.join(root(), 'beta', 'SKILL.md'))).toBe(true);
    expect(listSkillPacks(home)[0].state).toBe('installed');
  });

  it('keeps a disabled pack disabled through an update, new skills included', async () => {
    const url = makeRepo('pack', PACK);
    await installSkillPack(url, home);
    await setSkillPackEnabled('pack', false, home);
    commit(url, { 'skills/gamma/SKILL.md': skillMd('gamma') });
    await installSkillPack(url, home);
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(fs.existsSync(path.join(root(), name, 'SKILL.md'))).toBe(false);
      expect(fs.readFileSync(path.join(root(), name, 'SKILL.md.disabled'), 'utf8')).toContain(`name: ${name}`);
    }
  });

  it('keeps one skill turned off in the Skills tab off through an update', async () => {
    const url = makeRepo('pack', PACK);
    await installSkillPack(url, home);
    fs.renameSync(path.join(root(), 'beta', 'SKILL.md'), path.join(root(), 'beta', 'SKILL.md.disabled'));
    await installSkillPack(url, home);
    expect(fs.existsSync(path.join(root(), 'alpha', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root(), 'beta', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(root(), 'beta', 'SKILL.md.disabled'))).toBe(true);
  });

  it('uninstalls only what it installed', async () => {
    await installSkillPack(makeRepo('pack', PACK), home);
    writeFiles(root(), { 'mine/SKILL.md': 'mine' });

    expect(await uninstallSkillPack('pack', home)).toEqual({ removed: true });
    expect(fs.existsSync(path.join(root(), 'alpha'))).toBe(false);
    expect(fs.existsSync(path.join(root(), 'mine'))).toBe(true);
    expect(listSkillPacks(home)).toEqual([]);
  });

  it('asks before deleting a name the user has since replaced', async () => {
    await installSkillPack(makeRepo('pack', PACK), home);
    fs.writeFileSync(path.join(root(), 'alpha', 'SKILL.md'), 'rewritten by hand');
    expect(await uninstallSkillPack('pack', home)).toMatchObject({ removed: false, conflict: 'user-copy', names: ['alpha'] });
    expect(await uninstallSkillPack('pack', home, { force: true })).toEqual({ removed: true });
  });

  it('reports an update when the source moves, and none for a local folder', async () => {
    const url = makeRepo('pack', PACK);
    await installSkillPack(url, home);
    expect(await checkSkillPackUpdate('pack', home)).toMatchObject({ needsUpdate: false });
    const next = commit(url, { 'skills/alpha/extra.md': 'more' });
    expect(await checkSkillPackUpdate('pack', home)).toMatchObject({ current: next, needsUpdate: true });

    writeFiles(path.join(work, 'mine'), { 'one/SKILL.md': skillMd('one') });
    await installSkillPack(path.join(work, 'mine'), home);
    expect(await checkSkillPackUpdate('mine', home)).toEqual({ needsUpdate: null });
  });
});

describe('migrateLegacyPstack', () => {
  const legacy = () => path.join(home, '.codey', 'plugins', 'pstack.json');
  const installLegacy = () => {
    writeFiles(root(), {
      'poteto-mode/SKILL.md': `${skillMd('poteto-mode')}${CODEY_INSTALL_MARKER} poteto-mode -->`,
      'tdd/SKILL.md.disabled': `${skillMd('tdd')}${CODEY_INSTALL_MARKER} tdd -->`,
    });
    writeFiles(path.join(home, '.codey', 'plugins'), {
      'pstack.json': JSON.stringify({ hash: 'a'.repeat(40), skills: ['poteto-mode', 'tdd'], from: 'its-ahoh/codey-skills', installedAt: '2026-09-30' }),
    });
  };

  it('turns the old Plugins record into a pstack pack, touching no skill', async () => {
    installLegacy();
    expect(await migrateLegacyPstack(home)).toBe(true);

    expect(fs.existsSync(legacy())).toBe(false);
    expect(readSkillPackManifest('pstack', home)).toEqual({
      id: 'pstack', source: PSTACK_UPSTREAM_SOURCE, skills: ['poteto-mode', 'tdd'], installedAt: '2026-09-30',
    });
    expect(fs.existsSync(path.join(root(), 'poteto-mode', 'SKILL.md'))).toBe(true);
    // A skill the user turned off stays off.
    expect(fs.existsSync(path.join(root(), 'tdd', 'SKILL.md.disabled'))).toBe(true);
    expect(listSkillPacks(home)).toEqual([expect.objectContaining({ id: 'pstack', state: 'installed' })]);
  });

  it('is a no-op when there is nothing to migrate, and safe to run twice', async () => {
    expect(await migrateLegacyPstack(home)).toBe(false);
    installLegacy();
    await migrateLegacyPstack(home);
    const first = fs.readFileSync(skillPackManifestPath('pstack', home), 'utf8');
    expect(await migrateLegacyPstack(home)).toBe(false);
    expect(fs.readFileSync(skillPackManifestPath('pstack', home), 'utf8')).toBe(first);
  });

  it('offers an update, since the installed commit of upstream is unknown', async () => {
    installLegacy();
    await migrateLegacyPstack(home);
    expect(readSkillPackManifest('pstack', home)?.commit).toBeUndefined();
  });
});
