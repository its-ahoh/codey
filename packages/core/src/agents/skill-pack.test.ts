import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CODEY_INSTALL_MARKER } from './browser-skill';
import {
  checkSkillPackUpdate,
  installSkillPack,
  readSkillPackManifest,
  setSkillPackEnabled,
  skillPackManifestPath,
  skillPackStatus,
  uninstallSkillPack,
} from './skill-pack';

let home: string;
const root = () => path.join(home, '.codey', 'skills');

const PACK_SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} does a thing, described well enough to trigger.\n---\n\nBody of ${name}.\n`;

/** A published pack: path -> contents, under `skills/`. */
type Files = Record<string, string>;
const PACK: Files = {
  'skills/alpha/SKILL.md': skillMd('alpha'),
  'skills/alpha/playbooks/one.md': 'playbook one',
  'skills/beta/SKILL.md': skillMd('beta'),
  // A folder without SKILL.md is not a skill and must not be installed.
  'skills/notes/README.md': 'not a skill',
  // Plugins live beside the pack and are not part of it.
  'plugins/browser/SKILL.md': skillMd('browser'),
};

function treeFor(files: Files, packSha: string) {
  const entries: Array<{ path: string; type: string; sha: string }> = [];
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    entries.push({ path: file, type: 'blob', sha: 'f'.repeat(40) });
  }
  for (const dir of dirs) entries.push({ path: dir, type: 'tree', sha: dir === 'skills' ? packSha : 'c'.repeat(40) });
  return { tree: entries, truncated: false };
}

function serve(files: Files, { packSha = PACK_SHA, fail }: { packSha?: string; fail?: string } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(treeFor(files, packSha)));
    const repoPath = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\//, ''));
    if (fail && repoPath === fail) return new Response('gone', { status: 500 });
    const body = files[repoPath];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skill-pack-'));
  vi.stubGlobal('fetch', serve(PACK));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('installSkillPack', () => {
  it('installs every skill folder flat, with its extra files, and records a manifest', async () => {
    const result = await installSkillPack(home, { today: '2026-09-30' });
    expect(result).toMatchObject({ installed: true, skills: ['alpha', 'beta'] });

    expect(fs.readFileSync(path.join(root(), 'alpha', 'playbooks', 'one.md'), 'utf8')).toBe('playbook one');
    const alpha = fs.readFileSync(path.join(root(), 'alpha', 'SKILL.md'), 'utf8');
    expect(alpha.startsWith('---\nname: alpha\n')).toBe(true);
    expect(alpha).toContain(`${CODEY_INSTALL_MARKER} alpha `);
    expect(alpha).toContain('(pstack) on 2026-09-30');

    expect(fs.existsSync(path.join(root(), 'notes'))).toBe(false);
    expect(fs.existsSync(path.join(root(), 'browser'))).toBe(false);
    expect(readSkillPackManifest(undefined, home)).toMatchObject({ hash: PACK_SHA, skills: ['alpha', 'beta'] });
    expect(skillPackStatus(undefined, home)).toMatchObject({ state: 'installed', origin: 'codey', hash: PACK_SHA });
  });

  it('refuses, writing nothing, when a name belongs to a skill the user wrote', async () => {
    fs.mkdirSync(path.join(root(), 'beta'), { recursive: true });
    fs.writeFileSync(path.join(root(), 'beta', 'SKILL.md'), 'my own beta');

    const result = await installSkillPack(home);
    expect(result).toMatchObject({ installed: false, conflict: 'user-copy', names: ['beta'] });
    expect(fs.existsSync(path.join(root(), 'alpha'))).toBe(false);
    expect(fs.readFileSync(path.join(root(), 'beta', 'SKILL.md'), 'utf8')).toBe('my own beta');
    expect(fs.existsSync(skillPackManifestPath(undefined, home))).toBe(false);
  });

  it('replaces the user copy only when forced', async () => {
    fs.mkdirSync(path.join(root(), 'beta'), { recursive: true });
    fs.writeFileSync(path.join(root(), 'beta', 'SKILL.md'), 'my own beta');
    await installSkillPack(home, { force: true });
    expect(fs.readFileSync(path.join(root(), 'beta', 'SKILL.md'), 'utf8')).toContain('name: beta');
  });

  it('leaves no partial pack when a download fails', async () => {
    vi.stubGlobal('fetch', serve(PACK, { fail: 'skills/beta/SKILL.md' }));
    await expect(installSkillPack(home)).rejects.toThrow(/returned 500/);
    expect(fs.existsSync(path.join(root(), 'alpha'))).toBe(false);
    expect(fs.existsSync(skillPackManifestPath(undefined, home))).toBe(false);
    // The staging directory is cleaned up too.
    expect(fs.readdirSync(path.dirname(skillPackManifestPath(undefined, home)))).toEqual([]);
  });

  it('rejects a SKILL.md that does not name its own folder', async () => {
    vi.stubGlobal('fetch', serve({ ...PACK, 'skills/beta/SKILL.md': skillMd('gamma') }));
    await expect(installSkillPack(home)).rejects.toThrow(/is not the beta skill/);
  });

  it('on update, drops skills the pack no longer publishes but keeps user skills', async () => {
    await installSkillPack(home);
    fs.mkdirSync(path.join(root(), 'mine'), { recursive: true });
    fs.writeFileSync(path.join(root(), 'mine', 'SKILL.md'), 'mine');

    const { 'skills/beta/SKILL.md': _gone, ...withoutBeta } = PACK;
    vi.stubGlobal('fetch', serve(withoutBeta, { packSha: NEXT_SHA }));
    await installSkillPack(home);

    expect(fs.existsSync(path.join(root(), 'beta'))).toBe(false);
    expect(fs.existsSync(path.join(root(), 'mine', 'SKILL.md'))).toBe(true);
    expect(readSkillPackManifest(undefined, home)).toMatchObject({ hash: NEXT_SHA, skills: ['alpha'] });
  });

  it('ignores tree paths that would escape the skill directory', async () => {
    vi.stubGlobal('fetch', serve({ ...PACK, 'skills/alpha/../../evil.md': 'x', 'skills/../outside/SKILL.md': 'x' }));
    await installSkillPack(home);
    // Search the whole home: an escaped write lands wherever `..` points.
    const everywhere = (fs.readdirSync(home, { recursive: true }) as string[]).map(String);
    expect(everywhere.filter(p => p.endsWith('evil.md') || p.split(path.sep).includes('outside'))).toEqual([]);
  });
});

describe('enable, uninstall and update', () => {
  it('turns every skill off and back on', async () => {
    await installSkillPack(home);
    await setSkillPackEnabled(false, home);
    expect(fs.existsSync(path.join(root(), 'alpha', 'SKILL.md.disabled'))).toBe(true);
    expect(skillPackStatus(undefined, home).state).toBe('disabled');
    await setSkillPackEnabled(true, home);
    expect(fs.existsSync(path.join(root(), 'beta', 'SKILL.md'))).toBe(true);
    expect(skillPackStatus(undefined, home).state).toBe('installed');
  });

  it('uninstalls only what it installed', async () => {
    await installSkillPack(home);
    fs.mkdirSync(path.join(root(), 'mine'), { recursive: true });
    fs.writeFileSync(path.join(root(), 'mine', 'SKILL.md'), 'mine');

    expect(await uninstallSkillPack(home)).toEqual({ removed: true });
    expect(fs.existsSync(path.join(root(), 'alpha'))).toBe(false);
    expect(fs.existsSync(path.join(root(), 'mine'))).toBe(true);
    expect(skillPackStatus(undefined, home).state).toBe('absent');
  });

  it('asks before deleting a name the user has since replaced', async () => {
    await installSkillPack(home);
    fs.writeFileSync(path.join(root(), 'alpha', 'SKILL.md'), 'rewritten by hand');
    expect(await uninstallSkillPack(home)).toMatchObject({ removed: false, conflict: 'user-copy', names: ['alpha'] });
    expect(await uninstallSkillPack(home, { force: true })).toEqual({ removed: true });
  });

  it('reports an update when the published folder moves', async () => {
    await installSkillPack(home);
    expect(await checkSkillPackUpdate(home)).toMatchObject({ needsUpdate: false });
    vi.stubGlobal('fetch', serve(PACK, { packSha: NEXT_SHA }));
    expect(await checkSkillPackUpdate(home)).toMatchObject({ recorded: PACK_SHA, current: NEXT_SHA, needsUpdate: true });
  });
});
