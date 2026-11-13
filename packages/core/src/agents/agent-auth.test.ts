import { describe, expect, it, vi } from 'vitest';
import { AGENT_AUTH, authRequiredHint, buildAuthEnv, checkAgentAuth } from './agent-auth';

const CLAUDE_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', orgName: 'x' });
const CLAUDE_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', loginExpiresAt: null });
const CODEX_401 = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses';

const req = (agent: 'claude-code' | 'codex', extra: object = {}) => ({ prompt: 'hi', agent, ...extra }) as any;
const failed = (error: string) => ({ success: false, output: '', error });
const status = (stdout: string, code: number | null) => vi.fn(async () => ({ stdout, code }));

describe('parseStatus', () => {
  it('reads loggedIn from the claude JSON', () => {
    expect(AGENT_AUTH['claude-code']!.parseStatus(CLAUDE_IN, 0)).toBe(true);
    expect(AGENT_AUTH['claude-code']!.parseStatus(CLAUDE_OUT, 1)).toBe(false);
  });
  it('cannot tell from claude output that is not that JSON', () => {
    expect(AGENT_AUTH['claude-code']!.parseStatus('command not found', 127)).toBeNull();
    expect(AGENT_AUTH['claude-code']!.parseStatus('{"other":1}', 0)).toBeNull();
  });
  it('reads the codex status line', () => {
    expect(AGENT_AUTH.codex!.parseStatus('Logged in using ChatGPT\n', 0)).toBe(true);
    expect(AGENT_AUTH.codex!.parseStatus('Not logged in\n', 1)).toBe(false);
    expect(AGENT_AUTH.codex!.parseStatus('', null)).toBeNull();
  });
});

describe('buildAuthEnv / usesOwnLogin', () => {
  it('an API key on the model is not a login', () => {
    const env = buildAuthEnv('claude-code', req('claude-code', { model: { model: 'm', apiType: 'anthropic', apiKey: 'k' } }), { PATH: '/bin' });
    expect(AGENT_AUTH['claude-code']!.usesOwnLogin(env)).toBe(false);
  });
  it('a base URL with no key still uses the login', () => {
    const env = buildAuthEnv('claude-code', req('claude-code', { model: { model: 'm', apiType: 'anthropic', baseUrl: 'http://proxy' } }), { PATH: '/bin' });
    expect(AGENT_AUTH['claude-code']!.usesOwnLogin(env)).toBe(true);
  });
  it('a key in the agent env settings is not a login', () => {
    const env = buildAuthEnv('codex', req('codex', { extraEnv: { OPENAI_API_KEY: 'k' } }), { PATH: '/bin' });
    expect(AGENT_AUTH.codex!.usesOwnLogin(env)).toBe(false);
  });
  it('keeps config-dir overrides for the status command', () => {
    const env = buildAuthEnv('codex', req('codex', { extraEnv: { CODEX_HOME: '/tmp/x' } }), { PATH: '/bin' });
    expect(env.CODEX_HOME).toBe('/tmp/x');
  });
});

describe('checkAgentAuth', () => {
  const base = { baseEnv: { PATH: '/bin', HOME: '/nonexistent' } };

  it('is unknown for an agent with no spec', async () => {
    const runStatus = status('', 0);
    expect(await checkAgentAuth('pi' as any, req('codex'), failed('boom'), { ...base, runStatus })).toBe('unknown');
    expect(runStatus).not.toHaveBeenCalled();
  });

  it('is ok, without asking the CLI, when an API key is in play', async () => {
    const runStatus = status(CLAUDE_OUT, 1);
    const r = await checkAgentAuth('claude-code', req('claude-code', { model: { model: 'm', apiType: 'anthropic', apiKey: 'k' } }), failed('Not logged in · Please run /login'), { ...base, runStatus });
    expect(r).toBe('ok');
    expect(runStatus).not.toHaveBeenCalled();
  });

  it('is signed-out when the status command says so', async () => {
    expect(await checkAgentAuth('claude-code', req('claude-code'), failed('anything'), { ...base, runStatus: status(CLAUDE_OUT, 1) })).toBe('signed-out');
    expect(await checkAgentAuth('codex', req('codex'), failed('anything'), { ...base, runStatus: status('Not logged in\n', 1) })).toBe('signed-out');
  });

  it('is signed-out when status says signed in but the failure text says sign in again', async () => {
    expect(await checkAgentAuth('claude-code', req('claude-code'), failed('Not logged in · Please run /login'), { ...base, runStatus: status(CLAUDE_IN, 0) })).toBe('signed-out');
    expect(await checkAgentAuth('codex', req('codex'), failed(CODEX_401), { ...base, runStatus: status('Logged in using ChatGPT\n', 0) })).toBe('signed-out');
  });

  it('is ok when signed in and the failure is something else', async () => {
    expect(await checkAgentAuth('claude-code', req('claude-code'), failed('Rate limit reached'), { ...base, runStatus: status(CLAUDE_IN, 0) })).toBe('ok');
  });

  it('does not read the agent\'s own prose as a sign-in failure', async () => {
    const r = { success: false, output: 'The page shows "not logged in" because the session cookie is missing.', error: 'timeout' };
    expect(await checkAgentAuth('claude-code', req('claude-code'), r, { ...base, runStatus: status(CLAUDE_IN, 0) })).toBe('ok');
  });

  it('lets the text decide when the status command cannot be run', async () => {
    const broken = vi.fn(async () => { throw new Error('ENOENT'); });
    expect(await checkAgentAuth('codex', req('codex'), failed(CODEX_401), { ...base, runStatus: broken })).toBe('signed-out');
    expect(await checkAgentAuth('codex', req('codex'), failed('model not found'), { ...base, runStatus: broken })).toBe('unknown');
  });

  it('runs the status command in the run\'s working directory and env', async () => {
    const runStatus = status('Logged in using ChatGPT\n', 0);
    await checkAgentAuth('codex', req('codex', { context: { workingDir: '/work' }, extraEnv: { CODEX_HOME: '/tmp/x' } }), failed('x'), { ...base, runStatus });
    const [bin, args, opts] = runStatus.mock.calls[0] as any[];
    expect(bin).toBe('codex');
    expect(args).toEqual(['login', 'status']);
    expect(opts.cwd).toBe('/work');
    expect(opts.env.CODEX_HOME).toBe('/tmp/x');
    expect(opts.timeoutMs).toBe(10_000);
  });
});

describe('authRequiredHint', () => {
  it('names the agent and both ways to sign in', () => {
    expect(authRequiredHint('claude-code')).toBe('Claude Code is signed out. Open Codey on your Mac and choose Sign in, or run `claude auth login`.');
    expect(authRequiredHint('codex')).toBe('Codex is signed out. Open Codey on your Mac and choose Sign in, or run `codex login`.');
  });
});
