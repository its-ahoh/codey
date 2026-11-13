# In-app Agent Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn that fails because Claude Code or Codex is signed out shows a Sign in card in the chat; one click runs the CLI's own login inside Codey and then re-runs the message.

**Architecture:** `packages/core` gets one table (`agent-auth.ts`) that knows, per agent, how to ask "are you signed in?" and which failure text means "sign in again". The gateway calls it only after a failed run and attaches `authRequired` to the response, the persisted message and the stream events. The Mac app's main process runs the CLI's login command in a PTY (`agent-login.ts`), reports progress over IPC, and the renderer shows a card that re-sends the failed message once login succeeds.

**Tech Stack:** TypeScript, Vitest, Electron (main + preload + React renderer), `node-pty` (already bundled).

**Spec:** `docs/superpowers/specs/2026-11-12-agent-sign-in-design.md`

---

## Facts captured on 2026-11-12 (claude 2.1.322, codex-cli 0.167.0)

These are real outputs, taken with a throwaway `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Tests use them verbatim.

| | Signed in | Signed out |
|---|---|---|
| `claude auth status` | exit 0, JSON with `"loggedIn": true` plus `email`, `orgId`, `orgName` | exit 1, JSON `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", ..., "loginExpiresAt": null}` |
| `codex login status` (prints on **stderr**) | exit 0, `Logged in using ChatGPT` | exit 1, `Not logged in` |
| Failed run text | — | claude: `Not logged in · Please run /login` — codex: `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, ...` |

## Where the plan departs from the spec

Read these before starting; each one is deliberate.

1. **Auto-retry adds a second user bubble.** The spec says "without adding a second user bubble", but the existing retry route (`resendMessage` in `codey-mac/src/components/ChatTab.tsx:1754`) appends a new turn on purpose, so the transcript stays an honest record. Auto-retry uses that same route.
2. **`usesOwnLogin` takes only the resolved env**, not `(request, env)`. The env is already built from the request (`applyModelEnv` + `extraEnv`), so the request adds nothing.
3. **Channel hint is one fixed line that names both ways out** (Mac app and CLI command). The gateway has no reliable way to tell whether a Mac app is attached, so it does not try.
4. **Teams keep today's failure behaviour.** There is no "resume a failed step" path in the gateway today. The signed-out worker's message carries `authRequired` and shows the card; after sign-in the card re-sends the user message that started the team run. Other workers are not stopped by this feature.
5. **"Take over in Terminal" uses the spec's fallback**: cancel the hidden login, open a Terminal panel session, type the login command into it.

## File map

| File | New? | Job |
|---|---|---|
| `packages/core/src/agents/agent-auth.ts` | new | Per-agent auth table, `checkAgentAuth`, `authRequiredHint` |
| `packages/core/src/agents/agent-auth.test.ts` | new | Tests for the above |
| `packages/core/src/agents/index.ts` | edit | Export the module; `AgentFactory.checkAuth` |
| `packages/core/src/types/index.ts` | edit | `AgentResponse.authRequired`, `fallback.authRequired` |
| `packages/core/src/types/chat.ts` | edit | `ChatMessage.authRequired`, `fallback.authRequired` |
| `packages/gateway/src/gateway.ts` | edit | Detect in `runWithFallback`; carry on `done`; channel hint |
| `packages/gateway/src/gateway.auth-required.test.ts` | new | Gateway tests |
| `packages/gateway/src/chat-runner.ts` | edit | Event types |
| `packages/gateway/src/bot-message-emitter.ts` | edit | `EndBotMeta.authRequired` |
| `codey-mac/electron/agent-login.ts` | new | PTY login runner |
| `codey-mac/electron/agent-login.test.ts` | new | Tests with a fake PTY |
| `codey-mac/electron/main.ts`, `preload.ts`, `codey-mac/src/codey-api.d.ts` | edit | IPC |
| `codey-mac/src/components/agentSignIn.ts` | new | Shared login store + pure auto-retry rule |
| `codey-mac/src/components/agentSignIn.test.ts` | new | Tests |
| `codey-mac/src/components/AgentSignInCard.tsx` | new | The card |
| `codey-mac/src/hooks/useChats.tsx` | edit | Carry `authRequired` from events into messages |
| `codey-mac/src/components/ChatTab.tsx`, `TurnHeader.tsx`, `AgentsTab.tsx` | edit | Render sites |

## Setup (once)

```bash
source ~/.nvm/nvm.sh && nvm use 24.18.1
npm install
npm run build -w @codey/core && npm run build -w @codey/gateway
```

Node must be ≥ 24.12. The worktree has no `node_modules` yet.

---

### Task 1: Auth table and `checkAgentAuth` in core

**Files:**
- Create: `packages/core/src/agents/agent-auth.ts`
- Create: `packages/core/src/agents/agent-auth.test.ts`
- Modify: `packages/core/src/types/index.ts` (the `AgentResponse` interface, near line 369)
- Modify: `packages/core/src/agents/index.ts` (exports near line 21; `AgentFactory` near line 210)

- [ ] **Step 1: Add the response fields**

In `packages/core/src/types/index.ts`, inside `AgentResponse`, change the `fallback` field and add `authRequired` right after `fallbackFailures`:

```ts
  fallback?: {
    from: string;
    to: string;
    /** Why the primary failed, taken from its error/output. Truncated for
     *  display; the full text stays in the gateway log. */
    reason?: string;
    /** The primary failed because it is signed out. The fallback answered, so
     *  nothing is re-run; the badge only offers Sign in. */
    authRequired?: { agent: CodingAgent };
  };
```

```ts
  /**
   * The run failed because this agent's own login is missing or expired.
   * Never set for an agent running on an API key.
   */
  authRequired?: { agent: CodingAgent };
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/agents/agent-auth.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `npm test -w @codey/core -- agent-auth`
Expected: FAIL — `Cannot find module './agent-auth'`.

- [ ] **Step 4: Write the module**

Create `packages/core/src/agents/agent-auth.ts`:

```ts
/**
 * "Is this agent signed in?" — for the agents that have a login of their own.
 *
 * Codey never reads, stores or moves a token. It asks the CLI's own status
 * command and reads the CLI's own failure text. Both are needed: the status
 * command only reads local state, so a token the server has revoked still
 * reads as signed in, and only the failure text says otherwise.
 *
 * The check runs after a failed run, never before one.
 */
import { execFile } from 'child_process';
import type { AgentRequest, AgentResponse, CodingAgent } from '../types';
import { applyModelEnv, preferLocalBin, withCommonBinPaths } from './env';

export interface AgentAuthSpec {
  /** Name shown to the user. */
  label: string;
  /** Binary to run for the status command. */
  bin(env: NodeJS.ProcessEnv): string;
  /** argv after the binary. */
  statusCommand: string[];
  /** true = signed in, false = signed out, null = could not tell. */
  parseStatus(stdout: string, code: number | null): boolean | null;
  /** Shell command the login runner executes. */
  loginCommand: string;
  /** Failure text that means "sign in again". */
  authErrorPattern: RegExp;
  /** False when the resolved env carries an API key: a bad key is not a login problem. */
  usesOwnLogin(env: NodeJS.ProcessEnv): boolean;
  /** Protocol `applyModelEnv` falls back to for this agent. */
  apiType: 'anthropic' | 'openai';
}

export const AGENT_AUTH: Partial<Record<CodingAgent, AgentAuthSpec>> = {
  'claude-code': {
    label: 'Claude Code',
    bin: env => process.env.CLAUDE_BIN || preferLocalBin('claude', env),
    statusCommand: ['auth', 'status'],
    parseStatus(stdout) {
      try {
        const parsed = JSON.parse(stdout);
        return typeof parsed?.loggedIn === 'boolean' ? parsed.loggedIn : null;
      } catch {
        return null;
      }
    },
    loginCommand: 'claude auth login',
    authErrorPattern: /not logged in|please run \/login|oauth token (has expired|revoked|is invalid)/i,
    usesOwnLogin: env => !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY
      && !env.CLAUDE_CODE_USE_BEDROCK && !env.CLAUDE_CODE_USE_VERTEX,
    apiType: 'anthropic',
  },
  codex: {
    label: 'Codex',
    bin: () => 'codex',
    statusCommand: ['login', 'status'],
    parseStatus(stdout) {
      if (/not logged in/i.test(stdout)) return false;
      if (/^logged in\b/im.test(stdout)) return true;
      return null;
    },
    loginCommand: 'codex login',
    authErrorPattern: /401 unauthorized|missing bearer or basic authentication|not logged in|token (is |has )?expired/i,
    usesOwnLogin: env => !env.OPENAI_API_KEY,
    apiType: 'openai',
  },
};

/** The env the adapter gives the CLI, rebuilt the same way, so config-dir
 *  overrides (CLAUDE_CONFIG_DIR, CODEX_HOME) reach the status command too. */
export function buildAuthEnv(
  agent: CodingAgent,
  request: Pick<AgentRequest, 'model' | 'extraEnv'>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const spec = AGENT_AUTH[agent];
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.CLAUDECODE;
  if (spec) applyModelEnv(env, request.model, spec.apiType);
  if (request.extraEnv) Object.assign(env, request.extraEnv);
  return withCommonBinPaths(env);
}

export type RunStatus = (
  bin: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
) => Promise<{ stdout: string; code: number | null }>;

const runStatusCommand: RunStatus = (bin, args, opts) => new Promise((resolve, reject) => {
  execFile(bin, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8' }, (err, stdout) => {
    // A non-zero exit is an answer ("not logged in" exits 1), not a failure to ask.
    if (err && typeof (err as any).code !== 'number') return reject(err);
    resolve({ stdout: stdout ?? '', code: err ? (err as any).code : 0 });
  });
});

export type AgentAuthState = 'signed-out' | 'ok' | 'unknown';

export async function checkAgentAuth(
  agent: CodingAgent,
  request: Pick<AgentRequest, 'model' | 'extraEnv' | 'context'>,
  response: Pick<AgentResponse, 'error' | 'output'>,
  deps: { runStatus?: RunStatus; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<AgentAuthState> {
  const spec = AGENT_AUTH[agent];
  if (!spec) return 'unknown';
  const env = buildAuthEnv(agent, request, deps.baseEnv);
  if (!spec.usesOwnLogin(env)) return 'ok';

  let signedIn: boolean | null = null;
  try {
    const { stdout, code } = await (deps.runStatus ?? runStatusCommand)(
      spec.bin(env), spec.statusCommand, { env, cwd: request.context?.workingDir, timeoutMs: 10_000 },
    );
    // The output holds the account email and organisation: read one fact, keep nothing.
    signedIn = spec.parseStatus(stdout, code);
  } catch {
    signedIn = null;
  }
  if (signedIn === false) return 'signed-out';
  if (spec.authErrorPattern.test(`${response.error ?? ''}\n${response.output ?? ''}`)) return 'signed-out';
  return signedIn === true ? 'ok' : 'unknown';
}

/** The one line a channel gets: no login can be driven from a phone. */
export function authRequiredHint(agent: CodingAgent): string {
  const spec = AGENT_AUTH[agent];
  if (!spec) return `${agent} is signed out.`;
  return `${spec.label} is signed out. Open Codey on your Mac and choose Sign in, or run \`${spec.loginCommand}\`.`;
}
```

- [ ] **Step 5: Export it and give the factory a `checkAuth`**

In `packages/core/src/agents/index.ts`, next to the existing `export { applyModelEnv, unwiredAllProtocols } from './env';`:

```ts
export { AGENT_AUTH, authRequiredHint, buildAuthEnv, checkAgentAuth } from './agent-auth';
export type { AgentAuthSpec, AgentAuthState } from './agent-auth';
```

Add the import at the top of the same file:

```ts
import { checkAgentAuth, type AgentAuthState } from './agent-auth';
```

Add this method to `AgentFactory`, directly above `async run(`:

```ts
  /**
   * After a failed run: is the agent signed out? Applies the same per-agent
   * env `run` applies, so the status command sees what the CLI saw.
   */
  async checkAuth(agent: CodingAgent, request: AgentRequest, response: AgentResponse): Promise<AgentAuthState> {
    if (isCliDefaultModelConfig(request.model)) request = { ...request, model: undefined };
    if (this.envProvider && !request.extraEnv) {
      const fromCfg = this.envProvider(agent);
      if (fromCfg && Object.keys(fromCfg).length > 0) request = { ...request, extraEnv: fromCfg };
    }
    return checkAgentAuth(agent, request, response);
  }
```

Check that `packages/core/src/index.ts` re-exports `./agents` (it does today for `applyModelEnv`). If it lists names one by one, add the five new names there too.

- [ ] **Step 6: Run the tests and see them pass**

Run: `npm test -w @codey/core -- agent-auth && npm run typecheck -w @codey/core`
Expected: all `agent-auth` tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agents/agent-auth.ts packages/core/src/agents/agent-auth.test.ts packages/core/src/agents/index.ts packages/core/src/types/index.ts
git commit -m "Add a signed-in check for Claude Code and Codex"
```

---

### Task 2: Gateway sets `authRequired` in `runWithFallback`

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (`runWithFallback`, near line 5846)
- Create: `packages/gateway/src/gateway.auth-required.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/gateway.auth-required.test.ts` (same harness style as `gateway.failed-turn.test.ts`):

```ts
import { describe, expect, it, vi } from 'vitest';
import { Codey } from './gateway';

function gatewayWith(opts: {
  responses: Record<string, any>;
  auth: 'signed-out' | 'ok' | 'unknown';
  fallback?: { enabled: boolean; order: Array<{ agent: string }> };
}) {
  const checkAuth = vi.fn(async () => opts.auth);
  const gateway = Object.assign(Object.create(Codey.prototype), {
    getDefaultEffort: () => undefined,
    runAgentWithNetworkRetry: vi.fn(async (agent: string) => ({ ...opts.responses[agent] })),
    configManager: { getFallback: () => opts.fallback ?? { enabled: false, order: [] } },
    resolveFallbackModel: () => ({ model: 'auto' }),
    agentFactory: { checkAuth },
    logger: { error: () => {}, warn: () => {} },
  }) as Codey;
  return { gateway, checkAuth };
}

const run = (gateway: Codey, agent: string, extra: object = {}) =>
  (gateway as any).runWithFallback(agent, { prompt: 'hi', agent, ...extra });

describe('runWithFallback when the agent is signed out', () => {
  it('marks the failed response', async () => {
    const { gateway } = gatewayWith({
      responses: { 'claude-code': { success: false, output: '', error: 'Not logged in · Please run /login' } },
      auth: 'signed-out',
    });
    const res = await run(gateway, 'claude-code');
    expect(res.success).toBe(false);
    expect(res.authRequired).toEqual({ agent: 'claude-code' });
  });

  it('does not mark a failure that is not about sign-in', async () => {
    const { gateway } = gatewayWith({
      responses: { 'claude-code': { success: false, output: '', error: 'Rate limit reached' } },
      auth: 'ok',
    });
    expect((await run(gateway, 'claude-code')).authRequired).toBeUndefined();
  });

  it('never asks when the run succeeded', async () => {
    const { gateway, checkAuth } = gatewayWith({ responses: { codex: { success: true, output: 'ok' } }, auth: 'signed-out' });
    await run(gateway, 'codex');
    expect(checkAuth).not.toHaveBeenCalled();
  });

  it('never asks when the user stopped the turn', async () => {
    const { gateway, checkAuth } = gatewayWith({ responses: { codex: { success: false, output: '', error: 'aborted' } }, auth: 'signed-out' });
    const controller = new AbortController();
    controller.abort();
    const res = await run(gateway, 'codex', { signal: controller.signal });
    expect(checkAuth).not.toHaveBeenCalled();
    expect(res.authRequired).toBeUndefined();
  });

  it('delivers the fallback answer and puts the sign-in on the badge', async () => {
    const { gateway } = gatewayWith({
      responses: {
        'claude-code': { success: false, output: '', error: 'Not logged in · Please run /login' },
        codex: { success: true, output: 'answer' },
      },
      auth: 'signed-out',
      fallback: { enabled: true, order: [{ agent: 'codex' }] },
    });
    const res = await run(gateway, 'claude-code');
    expect(res.output).toBe('answer');
    expect(res.authRequired).toBeUndefined();
    expect(res.fallback.authRequired).toEqual({ agent: 'claude-code' });
  });

  it('keeps the mark when every fallback also fails', async () => {
    const { gateway } = gatewayWith({
      responses: {
        'claude-code': { success: false, output: '', error: 'Not logged in · Please run /login' },
        codex: { success: false, output: '', error: 'boom' },
      },
      auth: 'signed-out',
      fallback: { enabled: true, order: [{ agent: 'codex' }] },
    });
    const res = await run(gateway, 'claude-code');
    expect(res.authRequired).toEqual({ agent: 'claude-code' });
    expect(res.fallbackFailures).toEqual([{ agent: 'codex(auto)', reason: 'boom' }]);
  });

  it('a check that throws changes nothing', async () => {
    const { gateway, checkAuth } = gatewayWith({ responses: { codex: { success: false, output: '', error: 'boom' } }, auth: 'ok' });
    checkAuth.mockRejectedValueOnce(new Error('spawn failed'));
    const res = await run(gateway, 'codex');
    expect(res.error).toBe('boom');
    expect(res.authRequired).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w @codey/gateway -- gateway.auth-required`
Expected: FAIL — `authRequired` is undefined in the first test.

- [ ] **Step 3: Implement**

In `runWithFallback`, right after the line `this.logger.error(\`Agent ${agent} failed: ${response.error || response.output}\`);` add:

```ts
    // Asked only now, after a failure: a signed-in user never pays for it.
    let authRequired: AgentResponse['authRequired'];
    try {
      if (await this.agentFactory.checkAuth(agent, request, response) === 'signed-out') {
        authRequired = { agent };
        response.authRequired = authRequired;
      }
    } catch (err) {
      this.logger.warn(`Sign-in check for ${agent} failed: ${(err as Error).message}`);
    }
```

In the fallback-success branch, replace the line that sets `fallbackResponse.fallback` with:

```ts
        fallbackResponse.fallback = {
          from: fromLabel,
          to: label,
          reason: summarizeFailure(response),
          ...(authRequired ? { authRequired } : {}),
        };
```

Nothing else changes: the two early `return response` lines and the final `{ ...response, fallbackFailures }` already carry `response.authRequired`.

- [ ] **Step 4: Run and see them pass**

Run: `npm test -w @codey/gateway -- gateway.auth-required gateway.failed-turn`
Expected: PASS. If `gateway.failed-turn.test.ts`'s first test now throws on `this.agentFactory` being undefined, that is the `try/catch` doing its job: it must still pass. If its `logger` fake lacks `warn`, it already has one.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/gateway.auth-required.test.ts
git commit -m "Mark a failed run when the agent is signed out"
```

---

### Task 3: Carry `authRequired` on messages and stream events

**Files:**
- Modify: `packages/core/src/types/chat.ts` (`ChatMessage`, near line 146)
- Modify: `packages/gateway/src/chat-runner.ts:60` and `:64`
- Modify: `packages/gateway/src/bot-message-emitter.ts` (`EndBotMeta`, `endBot`)
- Modify: `packages/gateway/src/chats.ts:109`
- Modify: `packages/gateway/src/gateway.ts` (assistant message near line 7238, `done` near line 7327, team failure sites)
- Test: `packages/gateway/src/bot-message-emitter.test.ts` (create if absent)

- [ ] **Step 1: Types**

`packages/core/src/types/chat.ts`, in `ChatMessage`:

```ts
  fallback?: { from: string; to: string; reason?: string; authRequired?: { agent: CodingAgent } };
  /**
   * The turn failed because this agent is signed out. The Mac app shows a
   * Sign in card on the message instead of the raw error.
   */
  authRequired?: { agent: CodingAgent };
```

`packages/gateway/src/chat-runner.ts`: in the `bot_end` and `done` members of `ChatStreamEvent`, replace `fallback?: { from: string; to: string; reason?: string }` with `fallback?: ChatMessage['fallback']` and add `authRequired?: ChatMessage['authRequired']` to both. Import `ChatMessage` from `@codey/core` at the top if it is not imported yet.

- [ ] **Step 2: Write the failing emitter test**

Add to `packages/gateway/src/bot-message-emitter.test.ts` (create the file with these imports if it does not exist):

```ts
import { describe, expect, it, vi } from 'vitest';
import { BotMessageEmitter } from './bot-message-emitter';

describe('endBot with a signed-out agent', () => {
  it('stores authRequired on the message and sends it on bot_end', () => {
    const events: any[] = [];
    const store = { appendMessage: vi.fn(), updateMessage: vi.fn() };
    const emitter = new BotMessageEmitter(e => events.push(e), store, 'chat-1', { teamTurnId: 't1', teamName: 'Team', mode: 'sequential' }, () => 'm1');
    emitter.beginBot({ step: 1, bot: 'coder', agent: 'claude-code' });
    emitter.endBot('failed', { failureReason: 'Not logged in', authRequired: { agent: 'claude-code' } });

    const patch = store.updateMessage.mock.calls.at(-1)![2];
    expect(patch.authRequired).toEqual({ agent: 'claude-code' });
    const end = events.find(e => e.type === 'bot_end');
    expect(end.authRequired).toEqual({ agent: 'claude-code' });
  });
});
```

Run: `npm test -w @codey/gateway -- bot-message-emitter`
Expected: FAIL — `patch.authRequired` is undefined.

- [ ] **Step 3: Emitter**

`packages/gateway/src/bot-message-emitter.ts`:

```ts
export interface EndBotMeta {
  tokens?: number;
  durationSec?: number;
  failureReason?: string;
  nextUserAction?: { text: string; options?: string[] };
  fallback?: ChatMessage['fallback'];
  /** This bot failed because its agent is signed out. */
  authRequired?: ChatMessage['authRequired'];
}
```

In `endBot`, add to the `updateMessage` patch:

```ts
      ...(extra?.authRequired ? { authRequired: extra.authRequired } : {}),
```

and add `authRequired: extra?.authRequired` to the `bot_end` object passed to `this.sink`.

Run: `npm test -w @codey/gateway -- bot-message-emitter` → PASS.

- [ ] **Step 4: Solo chat turn**

`packages/gateway/src/gateway.ts`, in the `assistantMessage` literal near line 7238, after the `failed` line:

```ts
        ...(turnError && singleAgentResponse?.authRequired ? { authRequired: singleAgentResponse.authRequired } : {}),
```

In the `sink({ type: 'done', ...` call near line 7327, add before the closing `})`:

```ts
        ...(assistantMessage.authRequired ? { authRequired: assistantMessage.authRequired } : {}),
```

`packages/gateway/src/chats.ts`, under the `failed` line at 109:

```ts
      ...(message.authRequired ? { authRequired: message.authRequired } : {}),
```

- [ ] **Step 5: Team failure sites**

Every `endBot('failed', …)` call in `gateway.ts` that has the bot's response in scope gains `authRequired`. Apply these exact edits:

- Lines ~4690, ~4802, ~4900: `{ failureReason: response.error ?? 'Bot failed without an error message' }` → `{ failureReason: response.error ?? 'Bot failed without an error message', authRequired: response.authRequired }`
- Line ~5124: `{ failureReason: resp.error ?? 'Bot failed without an error message' }` → `{ failureReason: resp.error ?? 'Bot failed without an error message', authRequired: resp.authRequired }`
- Advisor loop, line ~4256: `onStepDone?.({ step, bot: turnNext, failed: true, error: response.error })` → add `authRequired: response.authRequired`. Add `authRequired?: AgentResponse['authRequired']` to the `onStepDone` parameter type at line ~4094. At line ~5585 change the failed branch to `{ failureReason: d.error ?? 'Bot failed without an error message', authRequired: d.authRequired }`.
- Roundtable, near line 5410: next to `const botFallback = new Map<…>()` add `const botAuth = new Map<string, NonNullable<AgentResponse['authRequired']>>();`. After the bot's `runWithFallback` returns (near line 5453) add `if (!response.success && response.authRequired) botAuth.set(botName, response.authRequired); else botAuth.delete(botName);`. In both `botMsgs.endBot(` calls near lines 5514 and 5527, the failure object becomes `{ failureReason: …, authRequired: botAuth.get(bot) }`.

The two "Bot … was not found" sites (4878, 5102) are not agent failures; leave them.

- [ ] **Step 6: Typecheck, test, commit**

Run: `npm run build -w @codey/core && npm run typecheck -w @codey/gateway && npm test -w @codey/gateway`
Expected: clean, all PASS.

```bash
git add packages/core/src/types/chat.ts packages/gateway/src
git commit -m "Carry the signed-out mark on chat messages and stream events"
```

---

### Task 4: Channels get one line

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (`failedTurnText` near line 216, `formatAgentResponse` near line 2894, `done` near line 7327)
- Test: `packages/gateway/src/gateway.auth-required.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `gateway.auth-required.test.ts`:

```ts
import { channelTextFor } from './gateway';

describe('what a channel is told', () => {
  const hint = 'Claude Code is signed out. Open Codey on your Mac and choose Sign in, or run `claude auth login`.';

  it('gets the one-line hint instead of the raw error', () => {
    expect(channelTextFor('❌ Error: Not logged in · Please run /login', { agent: 'claude-code' })).toBe(hint);
  });
  it('gets the normal text otherwise', () => {
    expect(channelTextFor('hello', undefined)).toBe('hello');
  });
  it('formatAgentResponse uses the hint too', () => {
    const gateway = Object.create(Codey.prototype) as Codey;
    const text = (gateway as any).formatAgentResponse({ success: false, output: '', error: 'x', authRequired: { agent: 'claude-code' } });
    expect(text).toBe(hint);
  });
});
```

Run: `npm test -w @codey/gateway -- gateway.auth-required` → FAIL, `channelTextFor` is not exported.

- [ ] **Step 2: Implement**

Add `authRequiredHint` to the existing `@codey/core` import in `gateway.ts`. Next to `failedTurnText` add:

```ts
/** A channel cannot drive a login, so it gets one line instead of the error. */
export function channelTextFor(output: string, authRequired: AgentResponse['authRequired']): string {
  return authRequired ? authRequiredHint(authRequired.agent) : output;
}
```

In `formatAgentResponse`:

```ts
    if (!response.success) {
      if (response.authRequired) return authRequiredHint(response.authRequired.agent);
      return `❌ Error: ${response.error}`;
    }
```

In the `done` sink call near line 7327, change `channelText: output` to `channelText: channelTextFor(output, assistantMessage.authRequired)`.

`formatAgentResponse` is the channel path (`handleMessage`); `sendToChat` uses `failedTurnText`, so the Mac message keeps the full error for the card's disclosure.

- [ ] **Step 3: Run, commit**

Run: `npm test -w @codey/gateway` → PASS.

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/gateway.auth-required.test.ts
git commit -m "Tell channels where to sign in instead of sending the raw error"
```

---

### Task 5: Login runner in the Mac app

**Files:**
- Create: `codey-mac/electron/agent-login.ts`
- Create: `codey-mac/electron/agent-login.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `codey-mac/electron/agent-login.test.ts`. No test may read `process.platform` (CI also runs on Ubuntu).

```ts
import { describe, expect, it, vi } from 'vitest'
import { AgentLoginRunner, firstUrl, type LoginProgress } from './agent-login'
import type { PtyLike } from './terminal-sessions'

function fakePty() {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  const pty: PtyLike & { emit(d: string): void; exit(code: number): void; killed: boolean } = {
    pid: 1,
    killed: false,
    write: vi.fn(),
    resize: vi.fn(),
    kill() { this.killed = true; onExit({ exitCode: 1 }) },
    onData(l) { onData = l },
    onExit(l) { onExit = l },
    emit(d) { onData(d) },
    exit(code) { onExit({ exitCode: code }) },
  }
  return pty
}

function runner(over: Partial<ConstructorParameters<typeof AgentLoginRunner>[0]> = {}) {
  const ptys: ReturnType<typeof fakePty>[] = []
  const events: LoginProgress[] = []
  const spawn = vi.fn(() => { const p = fakePty(); ptys.push(p); return p })
  const r = new AgentLoginRunner({
    spawn,
    shell: () => '/bin/zsh',
    env: () => ({ PATH: '/bin' }),
    cwd: () => '/tmp',
    checkSignedIn: async () => true,
    emit: e => events.push(e),
    ...over,
  })
  return { r, ptys, events, spawn }
}

describe('firstUrl', () => {
  it('finds an https link in terminal output, without colour codes', () => {
    expect(firstUrl('Open \u001b[4mhttps://claude.ai/oauth/authorize?code=1\u001b[0m to sign in')).toBe('https://claude.ai/oauth/authorize?code=1')
    expect(firstUrl('nothing here')).toBeUndefined()
  })
})

describe('AgentLoginRunner', () => {
  it('runs the CLI login in the login shell and succeeds when status agrees', async () => {
    const { r, ptys, events, spawn } = runner()
    const done = r.login('claude-code')
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-i', '-c', 'claude auth login'], expect.objectContaining({ cwd: '/tmp' }))
    ptys[0].exit(0)
    const result = await done
    expect(result.phase).toBe('succeeded')
    expect(events.map(e => e.phase)).toEqual(['starting', 'succeeded'])
  })

  it('reports the sign-in page when the CLI prints one', async () => {
    const { r, ptys, events } = runner()
    const done = r.login('codex')
    ptys[0].emit('Visit https://auth.openai.com/oauth?x=1 to continue\r\n')
    ptys[0].exit(0)
    await done
    expect(events.find(e => e.phase === 'waiting')?.url).toBe('https://auth.openai.com/oauth?x=1')
  })

  it('fails when the CLI exits clean but is still signed out', async () => {
    const { r, ptys } = runner({ checkSignedIn: async () => false })
    const done = r.login('codex')
    ptys[0].emit('Login cancelled\r\n')
    ptys[0].exit(0)
    const result = await done
    expect(result.phase).toBe('failed')
    expect(result.output).toContain('Login cancelled')
    expect(result.command).toBe('codex login')
  })

  it('succeeds on a non-zero exit when status says signed in', async () => {
    const { r, ptys } = runner({ checkSignedIn: async () => true })
    const done = r.login('codex')
    ptys[0].exit(1)
    expect((await done).phase).toBe('succeeded')
  })

  it('joins a second request for the same agent to the first run', async () => {
    const { r, ptys, spawn } = runner()
    const a = r.login('claude-code')
    const b = r.login('claude-code')
    expect(spawn).toHaveBeenCalledTimes(1)
    ptys[0].exit(0)
    expect((await a).phase).toBe('succeeded')
    expect((await b).phase).toBe('succeeded')
  })

  it('runs different agents side by side', () => {
    const { r, spawn } = runner()
    void r.login('claude-code')
    void r.login('codex')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('cancel kills the process and reports cancelled', async () => {
    const { r, ptys } = runner()
    const done = r.login('claude-code')
    r.cancel('claude-code')
    expect(ptys[0].killed).toBe(true)
    expect((await done).phase).toBe('cancelled')
  })

  it('times out, kills the process and fails', async () => {
    vi.useFakeTimers()
    try {
      const { r, ptys } = runner({ timeoutMs: 1000, checkSignedIn: async () => false })
      const done = r.login('claude-code')
      await vi.advanceTimersByTimeAsync(1001)
      const result = await done
      expect(ptys[0].killed).toBe(true)
      expect(result.phase).toBe('failed')
      expect(result.output).toContain('Timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails for an agent with no login command', async () => {
    const { r, spawn } = runner()
    const result = await r.login('pi')
    expect(result.phase).toBe('failed')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('fails with the command it tried when the shell cannot start', async () => {
    const { r } = runner({ spawn: () => { throw new Error('spawn ENOENT') } })
    const result = await r.login('codex')
    expect(result.phase).toBe('failed')
    expect(result.command).toBe('codex login')
    expect(result.output).toContain('spawn ENOENT')
  })
})
```

Run: `npm test -w codey-mac -- agent-login` → FAIL, module not found.

- [ ] **Step 2: Write the runner**

Create `codey-mac/electron/agent-login.ts`:

```ts
/**
 * Signing an agent CLI in from inside Codey.
 *
 * Codey runs the command the user would type (`claude auth login`,
 * `codex login`) and nothing else: no login protocol of its own, and it never
 * reads, stores or moves a token. The browser page opens exactly as it does
 * from a terminal.
 *
 * Same shell as agent-update.ts (`$SHELL -i -c`), so PATH matches the install
 * probe. It runs in a PTY because a login may prompt, or print a link or a
 * code when it cannot open the browser.
 */
import { AGENT_AUTH } from '@codey/core'
import type { PtyLike, PtySpawn } from './terminal-sessions'
import { tailOutput } from './agent-update'

export type LoginPhase = 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'

export interface LoginProgress {
  agent: string
  phase: LoginPhase
  /** The command that was run, so a failure can name it. */
  command: string
  /** A sign-in page the CLI printed, for an "Open page" link. */
  url?: string
  /** Tail of the output; only on `failed`. */
  output?: string
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g

/** The first https link in terminal output, with colour codes removed. */
export function firstUrl(text: string): string | undefined {
  return text.replace(ANSI, '').match(/https:\/\/[^\s"'<>]+/)?.[0]
}

/** The login command for an agent, or undefined when it has none of its own. */
export function loginCommandFor(agent: string): string | undefined {
  return (AGENT_AUTH as Record<string, { loginCommand: string } | undefined>)[agent]?.loginCommand
}

interface Run { pty: PtyLike; promise: Promise<LoginProgress>; cancelled: boolean }

export class AgentLoginRunner {
  private readonly runs = new Map<string, Run>()

  constructor(private readonly deps: {
    spawn: PtySpawn
    shell: () => string
    /** Process env plus this agent's env settings (CLAUDE_CONFIG_DIR, CODEX_HOME). */
    env: (agent: string) => NodeJS.ProcessEnv
    cwd: () => string
    /** Re-run the status command: true = signed in. */
    checkSignedIn: (agent: string) => Promise<boolean | null>
    emit: (progress: LoginProgress) => void
    timeoutMs?: number
  }) {}

  isRunning(agent: string): boolean {
    return this.runs.has(agent)
  }

  /** At most one login per agent: a second request joins the first. */
  login(agent: string): Promise<LoginProgress> {
    const existing = this.runs.get(agent)
    if (existing) return existing.promise

    const command = loginCommandFor(agent)
    const report = (p: LoginProgress) => { this.deps.emit(p); return p }
    if (!command) {
      return Promise.resolve(report({ agent, phase: 'failed', command: '', output: `${agent} has no sign-in command Codey can run.` }))
    }

    let pty: PtyLike
    try {
      const env = Object.fromEntries(
        Object.entries({ ...this.deps.env(agent), TERM: 'xterm-256color' })
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      pty = this.deps.spawn(this.deps.shell(), ['-i', '-c', command], { name: 'xterm-256color', cols: 100, rows: 30, cwd: this.deps.cwd(), env })
    } catch (err) {
      return Promise.resolve(report({ agent, phase: 'failed', command, output: (err as Error).message }))
    }

    const run: Run = { pty, cancelled: false, promise: undefined as unknown as Promise<LoginProgress> }
    const timeoutMs = this.deps.timeoutMs ?? 300_000
    report({ agent, phase: 'starting', command })

    run.promise = new Promise<LoginProgress>(resolve => {
      let buf = ''
      let url: string | undefined
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try { pty.kill() } catch { /* already gone */ }
      }, timeoutMs)

      pty.onData(data => {
        buf = (buf + data).slice(-20_000)
        if (!url) {
          url = firstUrl(buf)
          if (url) report({ agent, phase: 'waiting', command, url })
        }
      })
      pty.onExit(async () => {
        clearTimeout(timer)
        this.runs.delete(agent)
        if (run.cancelled) return resolve(report({ agent, phase: 'cancelled', command }))
        // The exit code is not the answer: a login can exit 0 after being
        // declined in the browser. The CLI's own status is.
        const signedIn = timedOut ? false : await this.deps.checkSignedIn(agent).catch(() => null)
        if (signedIn) return resolve(report({ agent, phase: 'succeeded', command }))
        const text = buf.replace(ANSI, '')
        const output = tailOutput(timedOut ? `${text}\nTimed out after ${Math.round(timeoutMs / 1000)}s.` : text, 1200)
        resolve(report({ agent, phase: 'failed', command, output }))
      })
    })
    this.runs.set(agent, run)
    return run.promise
  }

  cancel(agent: string): void {
    const run = this.runs.get(agent)
    if (!run) return
    run.cancelled = true
    try { run.pty.kill() } catch { /* already gone */ }
  }

  /** App is quitting: no login may outlive it. */
  cancelAll(): void {
    for (const agent of [...this.runs.keys()]) this.cancel(agent)
  }
}
```

- [ ] **Step 3: Run and see them pass**

Run: `npm test -w codey-mac -- agent-login`
Expected: PASS. If `AGENT_AUTH` does not resolve, rebuild core first: `npm run build -w @codey/core`.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/agent-login.ts codey-mac/electron/agent-login.test.ts
git commit -m "Run an agent CLI's own login from the Mac app"
```

---

### Task 6: IPC — status, login, cancel, take over

**Files:**
- Modify: `codey-mac/electron/agent-login.ts` (add `readAuthStatus`)
- Modify: `codey-mac/electron/agent-login.test.ts`
- Modify: `codey-mac/electron/main.ts` (near the `agents:update` handler, line ~4777)
- Modify: `codey-mac/electron/preload.ts` (`agents` block, line ~213)
- Modify: `codey-mac/src/codey-api.d.ts` (`agents` block, line ~570)

- [ ] **Step 1: Failing test for the status reader**

Append to `agent-login.test.ts`:

```ts
import { EventEmitter } from 'events'
import { readAuthStatus } from './agent-login'

function fakeChild(stdout: string, code: number) {
  const p: any = new EventEmitter()
  p.stdout = new EventEmitter()
  p.kill = vi.fn()
  queueMicrotask(() => { p.stdout.emit('data', Buffer.from(stdout)); p.emit('close', code) })
  return p
}

describe('readAuthStatus', () => {
  const base = { shell: '/bin/zsh', env: { PATH: '/bin' } as NodeJS.ProcessEnv }

  it('asks the CLI through the login shell', async () => {
    const spawn = vi.fn(() => fakeChild('Logged in using ChatGPT\n', 0))
    expect(await readAuthStatus('codex', { ...base, spawn })).toBe('signed-in')
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-i', '-c', 'codex login status'], expect.anything())
  })
  it('reads signed out', async () => {
    const spawn = vi.fn(() => fakeChild('{"loggedIn": false}', 1))
    expect(await readAuthStatus('claude-code', { ...base, spawn })).toBe('signed-out')
  })
  it('ignores shell noise printed before the JSON', async () => {
    const spawn = vi.fn(() => fakeChild('nvm: loaded\n{\n  "loggedIn": true\n}\n', 0))
    expect(await readAuthStatus('claude-code', { ...base, spawn })).toBe('signed-in')
  })
  it('says api-key without running anything when a key is set', async () => {
    const spawn = vi.fn()
    expect(await readAuthStatus('codex', { ...base, spawn, env: { OPENAI_API_KEY: 'k' } })).toBe('api-key')
    expect(await readAuthStatus('codex', { ...base, spawn, modelHasApiKey: true })).toBe('api-key')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('is unknown for an agent with no spec, or output it cannot read', async () => {
    expect(await readAuthStatus('pi', { ...base, spawn: vi.fn() })).toBe('unknown')
    expect(await readAuthStatus('codex', { ...base, spawn: vi.fn(() => fakeChild('zsh: command not found: codex', 127)) })).toBe('unknown')
  })
})
```

Run: `npm test -w codey-mac -- agent-login` → FAIL, `readAuthStatus` is not exported.

- [ ] **Step 2: Implement `readAuthStatus`**

Append to `codey-mac/electron/agent-login.ts`:

```ts
import type { SpawnLike } from './agent-detect'

export type AuthStatus = 'signed-in' | 'signed-out' | 'api-key' | 'unknown'

/**
 * What Settings shows for one agent. Runs the CLI's status command in the
 * login shell. Only the yes/no is kept: the output holds the account email.
 */
export async function readAuthStatus(agent: string, opts: {
  spawn: SpawnLike
  shell: string
  env: NodeJS.ProcessEnv
  /** The agent's default model is bound to an API key. */
  modelHasApiKey?: boolean
  timeoutMs?: number
}): Promise<AuthStatus> {
  const spec = (AGENT_AUTH as Record<string, typeof AGENT_AUTH['codex']>)[agent]
  if (!spec) return 'unknown'
  if (opts.modelHasApiKey || !spec.usesOwnLogin(opts.env)) return 'api-key'

  const command = `${spec.loginCommand.split(' ')[0]} ${spec.statusCommand.join(' ')}`
  const result = await new Promise<{ stdout: string; code: number | null } | null>(resolve => {
    let buf = ''
    let done = false
    const finish = (v: { stdout: string; code: number | null } | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const p = opts.spawn(opts.shell, ['-i', '-c', command], { stdio: ['ignore', 'pipe', 'ignore'], env: opts.env })
    const timer = setTimeout(() => { try { p.kill() } catch { /* already gone */ } finish(null) }, opts.timeoutMs ?? 15_000)
    p.stdout?.on('data', (d: Buffer) => { buf += d.toString() })
    p.on('close', (code: number) => finish({ stdout: buf, code }))
    p.on('error', () => finish(null))
  })
  if (!result) return 'unknown'
  // An interactive shell may print its own lines first; the JSON starts at the first brace.
  const brace = result.stdout.indexOf('{')
  const signedIn = spec.parseStatus(brace >= 0 ? result.stdout.slice(brace) : result.stdout, result.code)
    ?? spec.parseStatus(result.stdout, result.code)
  return signedIn === true ? 'signed-in' : signedIn === false ? 'signed-out' : 'unknown'
}
```

Move the `import type { SpawnLike }` line to the top of the file with the other imports.

Run: `npm test -w codey-mac -- agent-login` → PASS.

- [ ] **Step 3: Wire main**

In `codey-mac/electron/main.ts`, add the import beside the `agent-update` one:

```ts
import { AgentLoginRunner, loginCommandFor, readAuthStatus, type AuthStatus } from './agent-login'
import { AGENT_AUTH } from '@codey/core'
```

(Add `AGENT_AUTH` to an existing `@codey/core` import instead if the linter complains about duplicates.)

Below `agentUpdateStatus` (line ~845) add:

```ts
/** Process env plus the agent's own env settings, as the gateway applies them. */
function agentAuthEnv(agent: string): NodeJS.ProcessEnv {
  const extra = (coreConfigManager?.get()?.agents as Record<string, { env?: Record<string, string> }> | undefined)?.[agent]?.env
  return { ...process.env, ...(extra ?? {}) }
}

/** True when the agent's default model is bound to an API key. */
function agentDefaultModelHasApiKey(agent: string): boolean {
  const entry = coreConfigManager?.getFallback()?.order?.find(e => e.agent === agent)
  const model = entry?.model ? coreConfigManager?.getModel(entry.model) : undefined
  return !!model?.apiKeyRef
}

async function agentAuthStatus(agent: string): Promise<AuthStatus> {
  return readAuthStatus(agent, {
    spawn: (await import('child_process')).spawn,
    shell: process.env.SHELL || '/bin/zsh',
    env: agentAuthEnv(agent),
    modelHasApiKey: agentDefaultModelHasApiKey(agent),
  })
}

const agentLogin = new AgentLoginRunner({
  spawn: (shell, args, options) => pty.spawn(shell, args, options),
  shell: () => process.env.SHELL || '/bin/zsh',
  env: agentAuthEnv,
  cwd: () => os.homedir(),
  checkSignedIn: async agent => (await agentAuthStatus(agent)) === 'signed-in',
  emit: progress => sendToRenderer('agents:loginProgress', progress),
})
```

`pty`, `sendToRenderer` and `coreConfigManager` already exist in this file. If `os` is not imported, use `app.getPath('home')`. If `sendToRenderer` or `coreConfigManager` is declared below this point as a `const`/`let`, move this block below their declarations.

Below the `agents:update` handler add:

```ts
  // Sign-in state for every agent that has a login of its own.
  ipcMain.handle('agents:authStatus', async () =>
    wrap(async () => {
      const agents = Object.keys(AGENT_AUTH)
      const states = await Promise.all(agents.map(agentAuthStatus))
      return Object.fromEntries(agents.map((a, i) => [a, states[i]])) as Record<string, AuthStatus>
    })
  )

  // Resolves when the login ends; progress arrives on agents:loginProgress.
  ipcMain.handle('agents:login', async (_e, agent: string) =>
    wrap(async () => agentLogin.login(agent))
  )

  ipcMain.handle('agents:loginCancel', async (_e, agent: string) =>
    wrap(async () => { agentLogin.cancel(agent) })
  )

  // Hand the login to the user: stop the hidden run and type the same command
  // into a Terminal panel tab they can see and answer.
  ipcMain.handle('agents:loginInTerminal', async (_e, input: { agent: string; chatId: string; cwd: string }) =>
    wrap(async () => {
      const command = loginCommandFor(input.agent)
      if (!command) throw new Error(`${input.agent} has no sign-in command.`)
      agentLogin.cancel(input.agent)
      const opened = await terminalSessions.open(input.chatId, input.cwd, 100, 30)
      terminalSessions.write(opened.sessionId, `${command}\n`)
      sendToRenderer('terminal:agentOpen', { chatId: input.chatId, sessionId: opened.sessionId, cwd: input.cwd })
      return { sessionId: opened.sessionId }
    })
  )
```

Find the app's quit handler (`app.on('before-quit'` or `will-quit`) and add `agentLogin.cancelAll()` there.

Before relying on the `terminal:agentOpen` payload, read lines ~2960–2980 of `main.ts` and send the same fields the existing two callers send.

- [ ] **Step 4: Preload and types**

`codey-mac/electron/preload.ts`, inside `agents: { … }`:

```ts
    authStatus: () => ipcRenderer.invoke('agents:authStatus'),
    login: (agent: string) => ipcRenderer.invoke('agents:login', agent),
    loginCancel: (agent: string) => ipcRenderer.invoke('agents:loginCancel', agent),
    loginInTerminal: (input: { agent: string; chatId: string; cwd: string }) => ipcRenderer.invoke('agents:loginInTerminal', input),
    onLoginProgress: (cb: (progress: { agent: string; phase: string; command: string; url?: string; output?: string }) => void) => {
      const listener = (_e: unknown, progress: any) => cb(progress)
      ipcRenderer.on('agents:loginProgress', listener)
      return () => ipcRenderer.removeListener('agents:loginProgress', listener)
    },
```

`codey-mac/src/codey-api.d.ts`, inside `agents: { … }`:

```ts
        /** Sign-in state of each agent that has its own login. Never includes account details. */
        authStatus: () => Promise<IpcResult<Record<string, 'signed-in' | 'signed-out' | 'api-key' | 'unknown'>>>
        /** Runs the CLI's own login command. Resolves when it ends. */
        login: (agent: string) => Promise<IpcResult<AgentLoginProgress>>
        loginCancel: (agent: string) => Promise<IpcResult<void>>
        /** Stops the hidden login and types the command into a Terminal panel tab. */
        loginInTerminal: (input: { agent: string; chatId: string; cwd: string }) => Promise<IpcResult<{ sessionId: string }>>
        onLoginProgress: (cb: (progress: AgentLoginProgress) => void) => () => void
```

and at the top level of the same `.d.ts`:

```ts
interface AgentLoginProgress {
  agent: string
  phase: 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  command: string
  url?: string
  output?: string
}
```

- [ ] **Step 5: Typecheck, commit**

Run: `npm run typecheck -w codey-mac && npm test -w codey-mac -- agent-login`
(`typecheck` covers test files; `tsconfig.electron.json` alone is not enough.)
Expected: clean, PASS.

```bash
git add codey-mac/electron codey-mac/src/codey-api.d.ts
git commit -m "Expose agent sign-in status and login over IPC"
```

---

### Task 7: Renderer store and the auto-retry rule

**Files:**
- Create: `codey-mac/src/components/agentSignIn.ts`
- Create: `codey-mac/src/components/agentSignIn.test.ts`
- Modify: `codey-mac/src/hooks/useChats.tsx` (action types at lines ~77 and ~98; reducers; `done` and `bot_end` handlers near line 923)
- Modify: `codey-mac/src/hooks/useChats.reducer.test.ts`

- [ ] **Step 1: Failing tests for the pure parts**

Create `codey-mac/src/components/agentSignIn.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cardView, retryPlan, signInReducer, type SignInState } from './agentSignIn'

const idle: SignInState = {}

describe('signInReducer', () => {
  it('tracks one agent through a login', () => {
    let s = signInReducer(idle, { agent: 'codex', phase: 'starting', command: 'codex login' })
    expect(s.codex.phase).toBe('starting')
    s = signInReducer(s, { agent: 'codex', phase: 'waiting', command: 'codex login', url: 'https://x' })
    expect(s.codex.url).toBe('https://x')
    s = signInReducer(s, { agent: 'codex', phase: 'succeeded', command: 'codex login' })
    expect(s.codex.phase).toBe('succeeded')
  })
  it('keeps agents apart', () => {
    const s = signInReducer({ codex: { agent: 'codex', phase: 'waiting', command: 'codex login' } }, { agent: 'claude-code', phase: 'failed', command: 'claude auth login', output: 'no' })
    expect(s.codex.phase).toBe('waiting')
    expect(s['claude-code'].phase).toBe('failed')
  })
  it('a cancelled login goes back to idle', () => {
    const s = signInReducer({ codex: { agent: 'codex', phase: 'waiting', command: 'codex login' } }, { agent: 'codex', phase: 'cancelled', command: 'codex login' })
    expect(s.codex).toBeUndefined()
  })
})

describe('cardView', () => {
  it('is idle with no login in progress', () => {
    expect(cardView(undefined)).toBe('idle')
  })
  it('is running while starting or waiting', () => {
    expect(cardView({ agent: 'codex', phase: 'starting', command: '' })).toBe('running')
    expect(cardView({ agent: 'codex', phase: 'waiting', command: '' })).toBe('running')
  })
  it('passes succeeded and failed through', () => {
    expect(cardView({ agent: 'codex', phase: 'succeeded', command: '' })).toBe('succeeded')
    expect(cardView({ agent: 'codex', phase: 'failed', command: '' })).toBe('failed')
  })
})

describe('retryPlan', () => {
  const user = (id: string, content = 'do it') => ({ id, role: 'user' as const, content, timestamp: 1 })
  const failed = (id: string) => ({ id, role: 'assistant' as const, content: 'x', timestamp: 2, failed: true, authRequired: { agent: 'codex' as const } })

  it('re-sends the user message right before the failed one', () => {
    const messages = [user('u1', 'first'), failed('a1')]
    expect(retryPlan(messages, 'a1', { busy: false })).toEqual({ kind: 'auto', userMessageId: 'u1' })
  })
  it('asks the user instead when they have sent something since', () => {
    const messages = [user('u1'), failed('a1'), user('u2')]
    expect(retryPlan(messages, 'a1', { busy: false })).toEqual({ kind: 'manual', userMessageId: 'u1' })
  })
  it('asks the user instead when the chat is busy', () => {
    expect(retryPlan([user('u1'), failed('a1')], 'a1', { busy: true })).toEqual({ kind: 'manual', userMessageId: 'u1' })
  })
  it('finds the user message behind a team of bot messages', () => {
    const bot = { id: 'b1', role: 'assistant' as const, content: '', timestamp: 2, bot: 'a', teamTurnId: 't' }
    expect(retryPlan([user('u1'), bot, { ...failed('a1'), bot: 'b', teamTurnId: 't' }], 'a1', { busy: false })).toEqual({ kind: 'auto', userMessageId: 'u1' })
  })
  it('has nothing to do when there is no user message to re-send', () => {
    expect(retryPlan([failed('a1')], 'a1', { busy: false })).toEqual({ kind: 'none' })
  })
})
```

Run: `npm test -w codey-mac -- agentSignIn` → FAIL, module not found.

- [ ] **Step 2: Write the store**

Create `codey-mac/src/components/agentSignIn.ts` (the shape follows `agentUpdates.ts`: one module-level store, read with `useSyncExternalStore`):

```ts
import { useEffect, useSyncExternalStore } from 'react'
import type { ChatMessage } from '@codey/core'

/**
 * Sign-in state, shared by every card and the Agents tab.
 *
 * It is keyed by agent, not by message: three failed chats waiting on Claude
 * Code are waiting on one login, and all three cards must move together.
 */

export type LoginProgress = {
  agent: string
  phase: 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  command: string
  url?: string
  output?: string
}

export type SignInState = Record<string, LoginProgress>

export function signInReducer(state: SignInState, progress: LoginProgress): SignInState {
  if (progress.phase === 'cancelled') {
    const { [progress.agent]: _gone, ...rest } = state
    return rest
  }
  // The page link arrives once; later events for the same run must not drop it.
  const url = progress.url ?? (progress.phase === 'waiting' ? state[progress.agent]?.url : undefined)
  return { ...state, [progress.agent]: { ...progress, ...(url ? { url } : {}) } }
}

export type CardView = 'idle' | 'running' | 'succeeded' | 'failed'

export function cardView(progress: LoginProgress | undefined): CardView {
  if (!progress) return 'idle'
  if (progress.phase === 'starting' || progress.phase === 'waiting') return 'running'
  return progress.phase === 'succeeded' ? 'succeeded' : progress.phase === 'failed' ? 'failed' : 'idle'
}

export type RetryPlan =
  | { kind: 'auto'; userMessageId: string }
  | { kind: 'manual'; userMessageId: string }
  | { kind: 'none' }

/**
 * What to do with the failed turn once sign-in succeeds. Re-send on our own
 * only when nothing has happened since: a newer user message or a running
 * turn means the user has moved on, and they get a button instead.
 */
export function retryPlan(
  messages: Array<Pick<ChatMessage, 'id' | 'role'>>,
  failedMessageId: string,
  opts: { busy: boolean },
): RetryPlan {
  const index = messages.findIndex(m => m.id === failedMessageId)
  if (index < 0) return { kind: 'none' }
  let userMessageId: string | undefined
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { userMessageId = messages[i].id; break }
  }
  if (!userMessageId) return { kind: 'none' }
  const newerUser = messages.slice(index + 1).some(m => m.role === 'user')
  return { kind: opts.busy || newerUser ? 'manual' : 'auto', userMessageId }
}

let snapshot: SignInState = {}
const listeners = new Set<() => void>()
let unsubscribeIpc: (() => void) | null = null

const publish = (next: SignInState) => {
  snapshot = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  if (!unsubscribeIpc) {
    unsubscribeIpc = window.codey.agents.onLoginProgress(p => publish(signInReducer(snapshot, p)))
  }
  return () => { listeners.delete(l) }
}

export function useAgentSignIn(agent: string): LoginProgress | undefined {
  return useSyncExternalStore(subscribe, () => snapshot)[agent]
}

/** Start (or join) the login. Progress arrives through the store. */
export function startSignIn(agent: string): void {
  void window.codey.agents.login(agent)
}

export function cancelSignIn(agent: string): void {
  void window.codey.agents.loginCancel(agent)
}

/** Forget a finished result, so a card on a later failure starts at idle. */
export function clearSignIn(agent: string): void {
  if (!snapshot[agent]) return
  const { [agent]: _gone, ...rest } = snapshot
  publish(rest)
}

type AuthStatus = 'signed-in' | 'signed-out' | 'api-key' | 'unknown'
let authSnapshot: Record<string, AuthStatus> | null = null
const authListeners = new Set<() => void>()

export async function refreshAuthStatus(): Promise<void> {
  try {
    const r = await window.codey.agents.authStatus()
    if (r.ok) {
      authSnapshot = r.data
      for (const l of authListeners) l()
    }
  } catch { /* a status line is not worth an error banner */ }
}

/** Sign-in state per agent for Settings; null until the first answer. */
export function useAuthStatus(enabled: boolean): Record<string, AuthStatus> | null {
  useEffect(() => { if (enabled) void refreshAuthStatus() }, [enabled])
  return useSyncExternalStore(
    l => { authListeners.add(l); return () => { authListeners.delete(l) } },
    () => authSnapshot,
  )
}
```

Run: `npm test -w codey-mac -- agentSignIn` → PASS.

- [ ] **Step 3: Carry `authRequired` through `useChats`**

In `codey-mac/src/hooks/useChats.tsx`:

1. The `completeSend` action type (line ~77): add `authRequired?: ChatMessage['authRequired']`.
2. The `botEnd` action type (line ~98): add `authRequired?: ChatMessage['authRequired']`.
3. In the `completeSend` reducer case (line ~556): wherever the assistant message is built or patched with `fallback: action.fallback`, add on the next line `...(action.authRequired ? { authRequired: action.authRequired, failed: true } : {}),`. There are two such places (the team footer branch and the solo branch); do both.
4. In the `botEnd` reducer case: where the message is patched with `fallback`, add `...(action.authRequired ? { authRequired: action.authRequired } : {}),`.
5. In the `done` event handler (line ~923): add `authRequired: ev.authRequired,` to the dispatched `completeSend`.
6. In the `bot_end` event handler: add `authRequired: ev.authRequired,` to the dispatched `botEnd`.

- [ ] **Step 4: Reducer test**

Add to `codey-mac/src/hooks/useChats.reducer.test.ts`, using the file's existing helpers for building a state with one in-flight chat (copy the setup of the nearest existing `completeSend` test):

```ts
  it('keeps the signed-out mark on a failed turn', () => {
    const next = reducer(stateWithPendingAssistant('chat-1', 'a1'), {
      type: 'completeSend', chatId: 'chat-1', assistantMessageId: 'a1',
      content: '❌ Error: Not logged in · Please run /login',
      authRequired: { agent: 'claude-code' },
    })
    const message = next.chats['chat-1'].messages.find(m => m.id === 'a1')!
    expect(message.authRequired).toEqual({ agent: 'claude-code' })
    expect(message.failed).toBe(true)
  })
```

`stateWithPendingAssistant` stands for whatever that file already uses to build this state; if it has no such helper, inline the same literal the neighbouring `completeSend` test uses.

- [ ] **Step 5: Run, commit**

Run: `npm run typecheck -w codey-mac && npm test -w codey-mac -- agentSignIn useChats.reducer`
Expected: PASS.

```bash
git add codey-mac/src/components/agentSignIn.ts codey-mac/src/components/agentSignIn.test.ts codey-mac/src/hooks
git commit -m "Track agent sign-in in the renderer and decide when to re-run"
```

---

### Task 8: The Sign in card in chat

**Files:**
- Create: `codey-mac/src/components/AgentSignInCard.tsx`
- Modify: `codey-mac/src/components/ChatTab.tsx` (message body near line 2250; `resendMessage` near line 1757)

- [ ] **Step 1: Write the card**

Create `codey-mac/src/components/AgentSignInCard.tsx`. Use the colour tokens and button styles `BotInteractionCard.tsx` uses (open it and reuse its `C` import and its primary/secondary button styles; do not invent new colours).

```tsx
import React, { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@codey/core'
import { cancelSignIn, cardView, clearSignIn, retryPlan, startSignIn, useAgentSignIn, type RetryPlan } from './agentSignIn'

const LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export const AgentSignInCard: React.FC<{
  chatId: string
  /** Working directory of the chat, for "Take over in Terminal". */
  cwd?: string
  message: ChatMessage
  messages: ChatMessage[]
  busy: boolean
  /** Re-send a past user message through the normal retry route. */
  onRerun: (userMessageId: string) => void
}> = ({ chatId, cwd, message, messages, busy, onRerun }) => {
  const agent = message.authRequired!.agent
  const name = LABEL[agent] ?? agent
  const progress = useAgentSignIn(agent)
  const view = cardView(progress)
  const [showError, setShowError] = useState(false)
  const [manual, setManual] = useState<RetryPlan | null>(null)
  // One re-run per card, even if the store publishes `succeeded` twice.
  const handled = useRef(false)
  // Only the card that was on screen when the login was started re-runs on its
  // own: a card rendered later from history must not fire on an old success.
  const armed = useRef(false)

  useEffect(() => {
    if (view === 'running') armed.current = true
    if (view !== 'succeeded' || handled.current || !armed.current) return
    handled.current = true
    const plan = retryPlan(messages, message.id, { busy })
    if (plan.kind === 'auto') onRerun(plan.userMessageId)
    else setManual(plan)
  }, [view, messages, message.id, busy, onRerun])

  const signIn = () => { armed.current = true; clearSignIn(agent); startSignIn(agent) }
  const takeOver = () => { if (cwd) void window.codey.agents.loginInTerminal({ agent, chatId, cwd }) }

  return (
    <div role="group" aria-label={`${name} sign-in`} style={styles.card}>
      {view === 'idle' && (
        <div style={styles.row}>
          <span>{name} is signed out.</span>
          <button style={styles.primary} onClick={signIn}>Sign in</button>
        </div>
      )}
      {view === 'running' && (
        <div style={styles.row}>
          <span>Waiting for sign-in in your browser…</span>
          {progress?.url && <a href={progress.url} target="_blank" rel="noreferrer" style={styles.link}>Open page</a>}
          {cwd && <button style={styles.secondary} onClick={takeOver}>Take over in Terminal</button>}
          <button style={styles.secondary} onClick={() => cancelSignIn(agent)}>Cancel</button>
        </div>
      )}
      {view === 'succeeded' && (
        <div style={styles.row}>
          <span>{manual?.kind === 'manual' ? 'Signed in.' : manual?.kind === 'none' ? 'Signed in.' : 'Signed in. Running your message again…'}</span>
          {manual?.kind === 'manual' && (
            <button style={styles.primary} disabled={busy} onClick={() => { onRerun(manual.userMessageId); setManual({ kind: 'none' }) }}>Run again</button>
          )}
        </div>
      )}
      {view === 'failed' && (
        <div>
          <div style={styles.row}>
            <span>Sign-in did not finish{progress?.command ? ` (${progress.command})` : ''}.</span>
            <button style={styles.primary} onClick={signIn}>Try again</button>
          </div>
          {progress?.output && <pre style={styles.output}>{progress.output}</pre>}
        </div>
      )}
      <button style={styles.disclosure} aria-expanded={showError} onClick={() => setShowError(v => !v)}>
        {showError ? 'Hide error' : 'Show error'}
      </button>
      {showError && <pre style={styles.output}>{message.content}</pre>}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--codey-border)', fontSize: 13 },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  primary: { padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13 },
  secondary: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--codey-border)', background: 'transparent', cursor: 'pointer', fontSize: 13 },
  link: { fontSize: 13 },
  disclosure: { alignSelf: 'flex-start', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontSize: 12, opacity: 0.7 },
  output: { margin: 0, padding: 8, borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' },
}
```

After pasting, replace the `var(--codey-border)` placeholders and bare button colours with the exact tokens `BotInteractionCard.tsx` uses for its border, primary button and secondary button, so the card matches. That is a style swap only; do not change structure.

- [ ] **Step 2: Render it in `ChatTab.tsx`**

Import it next to the `BotInteractionCard` import (line 2):

```tsx
import { AgentSignInCard } from './AgentSignInCard'
```

Add a helper beside `resendMessage` (line ~1757):

```tsx
  const rerunUserMessage = (userMessageId: string) => {
    const original = chat.messages.find(m => m.id === userMessageId)
    if (original) void resendMessage(original.content, original.attachments, original.taskId)
  }
```

In the message render, find where an assistant message's body (its `Markdown`) is rendered for a normal turn, near line 2250 where `msg.botInteraction && <BotInteractionCard …/>` sits. Wrap the body so a signed-out message shows the card instead of its text:

```tsx
              {msg.authRequired
                ? (
                  <AgentSignInCard
                    chatId={chat.id}
                    cwd={chatWorkingDir}
                    message={msg}
                    messages={chat.messages}
                    busy={!canResend}
                    onRerun={rerunUserMessage}
                  />
                )
                : (/* the existing body element, unchanged */)}
```

`chatWorkingDir` stands for the value this file already passes to the Terminal panel as its `cwd` — search `ChatTab.tsx` for `cwd=` on `<TerminalPanel` and use that same expression.

The same message renderer is used for team bot bubbles; confirm by checking that a message with `bot` set goes through this branch. If bot bubbles have their own body render, add the same `msg.authRequired ? <AgentSignInCard …/> : …` there.

- [ ] **Step 3: Typecheck and run the suite**

Run: `npm run typecheck -w codey-mac && npm test -w codey-mac`
Expected: clean, PASS.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/AgentSignInCard.tsx codey-mac/src/components/ChatTab.tsx
git commit -m "Show a Sign in card on a turn that failed signed out"
```

---

### Task 9: Sign in on the fallback badge

**Files:**
- Modify: `codey-mac/src/components/TurnHeader.tsx` (`FallbackWarning`, line ~158)

- [ ] **Step 1: Widen the prop and add the button**

Change the `fallback` prop type of `FallbackWarning` from `{ from: string; to: string; reason?: string }` to `NonNullable<ChatMessage['fallback']>` (import `ChatMessage` from `@codey/core` if this file does not already). Do the same for the `fallback` field in `turnHeaderModel.ts`'s meta type if it is declared inline there.

Inside the popover, directly under the error text block, add:

```tsx
            {fallback.authRequired && (
              <FallbackSignIn agent={fallback.authRequired.agent} />
            )}
```

and add this component at the bottom of the file:

```tsx
/** The primary agent was signed out and a fallback answered. Nothing is
 *  re-run — the question has its answer — this only fixes the next turn. */
const FallbackSignIn: React.FC<{ agent: string }> = ({ agent }) => {
  const progress = useAgentSignIn(agent)
  const view = cardView(progress)
  if (view === 'succeeded') return <div style={styles.fallbackErrorLabel}>Signed in.</div>
  return (
    <button
      style={styles.fallbackButton}
      disabled={view === 'running'}
      onClick={() => { clearSignIn(agent); startSignIn(agent) }}
    >
      {view === 'running' ? 'Waiting for sign-in…' : view === 'failed' ? 'Try sign-in again' : 'Sign in'}
    </button>
  )
}
```

with the import:

```tsx
import { cardView, clearSignIn, startSignIn, useAgentSignIn } from './agentSignIn'
```

`styles.fallbackButton` and `styles.fallbackErrorLabel` already exist in this file. If `fallbackButton` carries the opacity/hover behaviour of the warning icon, define `fallbackSignIn` in the same `styles` object as a copy of the "ask agent" button's style in this popover and use that instead.

- [ ] **Step 2: Typecheck, test, commit**

Run: `npm run typecheck -w codey-mac && npm test -w codey-mac -- TurnHeader turnHeaderModel`
Expected: clean, PASS.

```bash
git add codey-mac/src/components/TurnHeader.tsx codey-mac/src/components/turnHeaderModel.ts
git commit -m "Offer Sign in on the fallback badge when the primary was signed out"
```

---

### Task 10: Settings → Agents

**Files:**
- Modify: `codey-mac/src/components/AgentsTab.tsx` (row render near line 235)

- [ ] **Step 1: Add status and button to each row**

Imports:

```tsx
import { cardView, clearSignIn, refreshAuthStatus, startSignIn, useAgentSignIn, useAuthStatus } from './agentSignIn'
```

In the component body, next to `useAgentUpdates`:

```tsx
  const authStatus = useAuthStatus(isGatewayRunning)
```

Add a row component at the bottom of the file:

```tsx
const AUTH_TEXT = { 'signed-in': 'Signed in', 'signed-out': 'Signed out', 'api-key': 'Using API key' } as const

/** Sign-in state for one agent, with a button when it is signed out. */
const AgentAuthBadge: React.FC<{ agent: string; status?: 'signed-in' | 'signed-out' | 'api-key' | 'unknown' }> = ({ agent, status }) => {
  const progress = useAgentSignIn(agent)
  const view = cardView(progress)
  // The row must show the new state without a manual Recheck.
  useEffect(() => { if (view === 'succeeded' || view === 'failed') void refreshAuthStatus() }, [view])
  if (!status || status === 'unknown') return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span>{view === 'running' ? 'Waiting for sign-in…' : AUTH_TEXT[status]}</span>
      {status === 'signed-out' && view !== 'running' && (
        <button aria-label={`Sign in to ${agent}`} onClick={() => { clearSignIn(agent); startSignIn(agent) }}>
          {view === 'failed' ? 'Try again' : 'Sign in'}
        </button>
      )}
    </span>
  )
}
```

In the row, beside the version text and before the `status?.installed && offersUpdate(a)` button (line ~235):

```tsx
                {status?.installed && <AgentAuthBadge agent={a} status={authStatus?.[a]} />}
```

Give the `<span>` and `<button>` the same text and button styles the neighbouring version label and Update button use (copy their `style=` props).

Find the existing "Recheck" handler in this file (it calls `checkInstalled(true)` or `refreshAgentUpdates(true)`) and add `void refreshAuthStatus()` to it.

- [ ] **Step 2: Typecheck, test, commit**

Run: `npm run typecheck -w codey-mac && npm test -w codey-mac`
Expected: clean, PASS.

```bash
git add codey-mac/src/components/AgentsTab.tsx
git commit -m "Show sign-in state and a Sign in button in Settings → Agents"
```

---

### Task 11: Whole-repo check and the manual pass

- [ ] **Step 1: Everything green**

```bash
npm run build -w @codey/core && npm run build -w @codey/gateway
npm run typecheck -w @codey/core && npm run typecheck -w @codey/gateway && npm run typecheck -w codey-mac
npm test
npm run lint
```

Expected: all clean. `npm run lint` flags non-English characters in source: the `·` in the test string `Not logged in · Please run /login` and the `…` in UI text may trip it. If they do, write them as `·` and `…` in the source.

- [ ] **Step 2: Update the spec**

In `docs/superpowers/specs/2026-11-12-agent-sign-in-design.md`: change `Status:` to `implemented, real expired login not yet verified`, replace the sentence about `codex login status` not being observed with the captured outputs from the table at the top of this plan, and add the five departures listed under "Where the plan departs from the spec".

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers
git commit -m "Record the agent sign-in plan and what changed from the design"
```

- [ ] **Step 4: Manual pass (needs a human; do not claim it was done otherwise)**

A signed-out agent without signing the developer out:

1. Settings → Agents → Codex → Environment: add `CODEX_HOME=/tmp/codey-signin-test` (an empty folder).
2. Settings → Agents shows Codex as "Signed out" with a Sign in button.
3. Send a message to Codex in a chat. Expect the Sign in card, not the raw 401.
4. Click Sign in. The browser opens. Finish the login.
5. Expect "Signed in. Running your message again…", then a new turn with the answer.
6. Repeat step 3 from Telegram: expect the one-line hint.
7. Remove the `CODEX_HOME` line and delete `/tmp/codey-signin-test`.

Launch the built app with a clean environment (`env -i HOME=$HOME open -a Codey`), never with plain `open` from an agent shell: that inherits an nvm PATH and picks up an old `claude`.
