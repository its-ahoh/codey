import { ModelConfig } from '../types';

/**
 * Prepend the bin directories CLIs are usually installed into. A GUI-launched
 * Electron app inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a
 * bare spawn('codex') fails with ENOENT even though the binary is installed.
 * Mutates and returns the given env map.
 */
export function withCommonBinPaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const homedir = env.HOME || process.env.HOME || '';
  const extraPaths = [
    homedir ? `${homedir}/.local/bin` : '',
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);
  for (const p of extraPaths) {
    const segments = (env.PATH || '').split(':');
    if (!segments.includes(p)) {
      env.PATH = env.PATH ? `${p}:${env.PATH}` : p;
    }
  }
  return env;
}

/**
 * Apply model credentials to a child-process env map using the style
 * declared on ModelConfig.apiType. Does not mutate the caller's env.
 *
 * apiType === 'anthropic' → ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 * apiType === 'openai'    → OPENAI_BASE_URL   + OPENAI_API_KEY
 *
 * If apiType is absent, the caller's adapter-specific default is used.
 */
export function applyModelEnv(
  env: NodeJS.ProcessEnv,
  model: ModelConfig | undefined,
  fallbackApiType: 'anthropic' | 'openai',
): NodeJS.ProcessEnv {
  if (!model) return env;
  const apiType = model.apiType ?? fallbackApiType;
  if (apiType === 'anthropic') {
    if (model.apiKey) env.ANTHROPIC_AUTH_TOKEN = model.apiKey;
    if (model.baseUrl) env.ANTHROPIC_BASE_URL = model.baseUrl;
  } else if (apiType === 'openai') {
    if (model.apiKey) env.OPENAI_API_KEY = model.apiKey;
    if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
  }
  return env;
}
