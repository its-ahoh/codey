import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codeyHome, codeyTmpDir, codeyTmpFile, pruneCodeyTmp } from './codey-paths';

describe('codey-paths', () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.CODEY_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-paths-'));
    process.env.CODEY_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CODEY_HOME;
    else process.env.CODEY_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('honours CODEY_HOME', () => {
    expect(codeyHome()).toBe(home);
  });

  it('falls back to ~/.codey without the override', () => {
    delete process.env.CODEY_HOME;
    expect(codeyHome()).toBe(path.join(os.homedir(), '.codey'));
  });

  it('creates tmp/ on first use', () => {
    const dir = codeyTmpDir();
    expect(dir).toBe(path.join(home, 'tmp'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('builds a file path inside tmp/', () => {
    expect(codeyTmpFile('capture.wav')).toBe(path.join(home, 'tmp', 'capture.wav'));
  });

  it('sweeps files older than the cutoff and keeps fresh ones', () => {
    const dir = codeyTmpDir();
    const stale = path.join(dir, 'stale.txt');
    const fresh = path.join(dir, 'fresh.txt');
    fs.writeFileSync(stale, 'old');
    fs.writeFileSync(fresh, 'new');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

    pruneCodeyTmp();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('sweeps stale directories too — a killed spawn leaves its config dir behind', () => {
    const dir = codeyTmpDir();
    const stale = path.join(dir, 'mcp-abc123');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'mcp.json'), '{}');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

    pruneCodeyTmp();

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('keeps a directory that is still fresh', () => {
    const dir = codeyTmpDir();
    const fresh = path.join(dir, 'mcp-live');
    fs.mkdirSync(fresh);

    pruneCodeyTmp();

    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('does not throw when tmp/ does not exist yet', () => {
    expect(() => pruneCodeyTmp()).not.toThrow();
  });
});
