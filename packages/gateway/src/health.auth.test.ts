import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiServer } from './health';
import { ApiTokenStore } from './api-tokens';

/**
 * Covers the P1 security change: `/config` used to be world-readable to anyone
 * who could reach the port, and the port was bound on every interface.
 */
describe('ApiServer auth', () => {
  let dir: string;
  let store: ApiTokenStore;
  let server: ApiServer;
  let port: number;
  let apiSettings: { bindHost?: string; allowedOrigins?: string[] };

  const fakeStatus = () => ({
    status: 'healthy' as const,
    uptime: 1,
    timestamp: 'now',
    channels: { telegram: false, discord: false, imessage: false },
    stats: { messagesProcessed: 0, activeConversations: 0, errors: 0 },
  });

  // Minimal stand-in: the server only needs these three methods.
  const fakeConfigManager = () => ({
    get: () => ({ gateway: { port: 0 }, apiKeys: [{ name: 'anthropic', apiKey: 'sk-super-secret' }] }),
    getApiBindHost: () => apiSettings.bindHost ?? '127.0.0.1',
    getApiAllowedOrigins: () => apiSettings.allowedOrigins ?? [],
    update: () => { /* no-op */ },
    getResolvedVoiceConfig: () => undefined,
  }) as any;

  async function listenOnFreePort(): Promise<void> {
    // Port 0 lets the OS pick; read back what it chose.
    server = new ApiServer(0, fakeStatus, fakeConfigManager(), undefined, undefined, undefined, undefined, store);
    await server.start();
    port = (server as any).server.address().port;
  }

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  // fetch().json() is typed `unknown`; these are our own responses.
  const json = async (res: Response): Promise<any> => res.json();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-health-'));
    store = new ApiTokenStore(path.join(dir, 'api-tokens.json'));
    apiSettings = {};
    await listenOnFreePort();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves /health without a token', async () => {
    const res = await fetch(url('/health'));
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe('healthy');
  });

  it('rejects /config with no token', async () => {
    const res = await fetch(url('/config'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.text()).not.toContain('sk-super-secret');
  });

  it('rejects /config with a wrong token', async () => {
    store.create('real');
    const res = await fetch(url('/config'), { headers: { Authorization: 'Bearer codey_nope' } });
    expect(res.status).toBe(401);
  });

  it('serves /config with a valid token', async () => {
    const { token } = store.create('real');
    const res = await fetch(url('/config'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await json(res)).apiKeys[0].apiKey).toBe('sk-super-secret');
  });

  it('rejects POST /config with no token', async () => {
    const res = await fetch(url('/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts a token minted after the server booted', async () => {
    // The CLI runs in another process, so the server must re-read the store.
    const { token } = store.create('later');
    const res = await fetch(url('/config'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it('rejects a revoked token', async () => {
    const { token, record } = store.create('a');
    expect((await fetch(url('/config'), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);

    store.revoke(record.id);
    expect((await fetch(url('/config'), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('refuses a browser origin on /config even with a valid token', async () => {
    const { token } = store.create('a');
    const res = await fetch(url('/config'), {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('allows a configured origin', async () => {
    apiSettings.allowedOrigins = ['https://app.example'];
    const { token } = store.create('a');
    const res = await fetch(url('/config'), {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://app.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  it('never sends a wildcard CORS header', async () => {
    const res = await fetch(url('/health'), { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('404s unknown /v1 routes only after authenticating', async () => {
    expect((await fetch(url('/v1/prompt'), { method: 'POST' })).status).toBe(401);

    const { token } = store.create('a');
    const res = await fetch(url('/v1/prompt'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('binds loopback by default', async () => {
    expect((server as any).server.address().address).toBe('127.0.0.1');
  });
});
