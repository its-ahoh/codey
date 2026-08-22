import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiTokenStore, TOKEN_PREFIX } from './api-tokens';

describe('ApiTokenStore', () => {
  let dir: string;
  let file: string;
  let store: ApiTokenStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-tokens-'));
    file = path.join(dir, 'api-tokens.json');
    store = new ApiTokenStore(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CODEY_API_TOKEN;
  });

  it('returns the plaintext exactly once and never stores it', () => {
    const { token, record } = store.create('my-script');

    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(record.name).toBe('my-script');

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain(token);
    // The secret part alone must not leak either.
    expect(raw).not.toContain(token.slice(TOKEN_PREFIX.length));
    expect(JSON.parse(raw).tokens[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates the file with 0600 permissions', () => {
    store.create('a');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions that were widened behind its back', () => {
    store.create('a');
    fs.chmodSync(file, 0o644);

    const reopened = new ApiTokenStore(file);
    expect(reopened.list()).toHaveLength(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('verifies a real token and rejects everything else', () => {
    const { token, record } = store.create('a');

    expect(store.verify(token)?.id).toBe(record.id);
    expect(store.verify(token + 'x')).toBeNull();
    expect(store.verify('')).toBeNull();
    expect(store.verify(undefined)).toBeNull();
  });

  it('verifies against a store reloaded from disk', () => {
    const { token } = store.create('a');
    expect(new ApiTokenStore(file).verify(token)).not.toBeNull();
  });

  it('records lastUsedAt on a successful verify', () => {
    const { token } = store.create('a');
    expect(store.list()[0].lastUsedAt).toBeUndefined();

    store.verify(token);
    expect(store.list()[0].lastUsedAt).toBeGreaterThan(0);
  });

  it('rejects a revoked token', () => {
    const { token, record } = store.create('a');
    expect(store.revoke(record.id)).toBe(true);
    expect(store.verify(token)).toBeNull();
    expect(store.revoke(record.id)).toBe(false);
  });

  it('list() never exposes hashes', () => {
    store.create('a');
    expect(store.list()[0]).not.toHaveProperty('hash');
  });

  it('accepts CODEY_API_TOKEN as an extra valid token', () => {
    process.env.CODEY_API_TOKEN = 'from-the-environment';
    expect(store.verify('from-the-environment')?.id).toBe('env');
    expect(store.verify('something-else')).toBeNull();
  });

  it('has no valid tokens when the file is missing and no env var is set', () => {
    expect(store.list()).toEqual([]);
    expect(store.verify('anything')).toBeNull();
    expect(store.isEmpty()).toBe(true);
  });

  it('survives a corrupt file instead of throwing', () => {
    fs.writeFileSync(file, 'not json at all');
    const reopened = new ApiTokenStore(file);
    expect(reopened.list()).toEqual([]);
    expect(reopened.verify('anything')).toBeNull();
  });

  it('issues distinct tokens', () => {
    const a = store.create('a').token;
    const b = store.create('b').token;
    expect(a).not.toBe(b);
    expect(store.list()).toHaveLength(2);
  });
});
