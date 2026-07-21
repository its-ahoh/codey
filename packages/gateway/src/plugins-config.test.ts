import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from './config';

describe('plugins config', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-plugins-cfg-'));
    file = path.join(dir, 'gateway.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to no plugins enabled', () => {
    const mgr = new ConfigManager(file);
    expect(mgr.isPluginEnabled('browser')).toBe(false);
  });

  it('persists plugin enablement through update()', () => {
    const mgr = new ConfigManager(file);
    mgr.update({ plugins: { browser: { enabled: true } } });
    expect(mgr.isPluginEnabled('browser')).toBe(true);

    const reloaded = new ConfigManager(file);
    expect(reloaded.isPluginEnabled('browser')).toBe(true);
  });

  it('coerces non-boolean enabled values to false on load', () => {
    fs.writeFileSync(file, JSON.stringify({ plugins: { browser: { enabled: 'yes' } } }));
    const mgr = new ConfigManager(file);
    expect(mgr.isPluginEnabled('browser')).toBe(false);
  });

  it('merges plugins updates without clobbering other plugin entries', () => {
    const mgr = new ConfigManager(file);
    mgr.update({ plugins: { browser: { enabled: true } } });
    mgr.update({ plugins: {} });
    expect(mgr.isPluginEnabled('browser')).toBe(true);
  });
});
