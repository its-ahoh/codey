import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiServer } from './health';

/**
 * `/voice/polish` has one job beyond calling the cleanup: it must always
 * answer with usable text. Every case below is a way cleanup can not happen,
 * and each one has to come back as the transcript the helper already had.
 */
describe('POST /voice/polish', () => {
  let server: ApiServer;
  let port: number;
  let polish: { enabled?: boolean } | undefined;
  let realPlatform: PropertyDescriptor | undefined;

  const fakeStatus = () => ({
    status: 'healthy' as const,
    uptime: 1,
    timestamp: 'now',
    channels: { telegram: false, discord: false, imessage: false },
    stats: { messagesProcessed: 0, activeConversations: 0, errors: 0 },
  });

  const fakeConfigManager = () => ({
    get: () => ({ gateway: { port: 0 }, channels: {}, apiKeys: [], voice: { polish } }),
    getApiBindHost: () => '127.0.0.1',
    getApiAllowedOrigins: () => [],
    update: () => { /* no-op */ },
    getResolvedVoiceConfig: () => undefined,
  }) as any;

  const post = async (body: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}/voice/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  const spoken = 'so um I I want to add a button here right';

  beforeEach(async () => {
    // `/voice/*` answers 501 off macOS, and CI runs on Linux. The endpoint's
    // behaviour is platform-independent and worth covering on every runner,
    // so the platform is stubbed rather than the suite skipped.
    realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    polish = { enabled: true };
    server = new ApiServer(0, fakeStatus, fakeConfigManager());
    await server.start();
    port = (server as any).server.address().port;
  });

  afterEach(async () => {
    await server.stop();
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  });

  it('is not served at all off macOS', async () => {
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
    if (process.platform === 'darwin') return;
    expect((await post({ text: spoken })).status).toBe(501);
  });

  it('returns the cleaned text when the runner produces one', async () => {
    server.setVoicePolishRunner(async () => 'So I want to add a button here.');
    const res = await post({ text: spoken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'So I want to add a button here.', changed: true });
  });

  it('returns the transcript when no runner is wired', async () => {
    const res = await post({ text: spoken });
    expect(res.body).toEqual({ text: spoken, changed: false });
  });

  it('returns the transcript when cleanup is switched off', async () => {
    polish = { enabled: false };
    server.setVoicePolishRunner(async () => 'should never be used');
    expect((await post({ text: spoken })).body).toEqual({ text: spoken, changed: false });
  });

  it('returns the transcript when the config has no polish section at all', async () => {
    polish = undefined;
    server.setVoicePolishRunner(async () => 'should never be used');
    expect((await post({ text: spoken })).body).toEqual({ text: spoken, changed: false });
  });

  it('returns the transcript when the runner declined', async () => {
    server.setVoicePolishRunner(async () => null);
    expect((await post({ text: spoken })).body).toEqual({ text: spoken, changed: false });
  });

  it('returns the transcript when the runner threw', async () => {
    server.setVoicePolishRunner(async () => { throw new Error('model exploded'); });
    expect((await post({ text: spoken })).body).toEqual({ text: spoken, changed: false });
  });

  it('does not call the runner for text too short to be worth it', async () => {
    let called = false;
    server.setVoicePolishRunner(async () => { called = true; return 'nope'; });
    expect((await post({ text: 'undo' })).body).toEqual({ text: 'undo', changed: false });
    expect(called).toBe(false);
  });

  it('handles an empty transcript without reaching the runner', async () => {
    let called = false;
    server.setVoicePolishRunner(async () => { called = true; return 'nope'; });
    expect((await post({ text: '' })).body).toEqual({ text: '', changed: false });
    expect(called).toBe(false);
  });

  it('rejects a malformed body rather than guessing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/voice/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
