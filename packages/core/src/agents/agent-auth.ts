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
  execFile(bin, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
    // A non-zero exit is an answer ("not logged in" exits 1), not a failure to ask.
    if (err && typeof (err as any).code !== 'number') return reject(err);
    // codex prints its status line on stderr; claude prints JSON on stdout.
    resolve({ stdout: stdout?.trim() ? stdout : (stderr ?? ''), code: err ? (err as any).code : 0 });
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
