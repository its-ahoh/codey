import * as fs from 'fs';
import { ModelConfig } from '../types';

/**
 * Order nvm's installed node versions newest-first and turn them into bin
 * directories. Split out from the fs read so the ordering is testable.
 *
 * Names that do not parse as `vMAJOR.MINOR.PATCH` are dropped rather than
 * sorted to one end: `~/.nvm/versions/node` also holds alias symlinks, and a
 * non-version entry is not a directory we want on PATH.
 */
export function nvmBinDirs(homedir: string, versions: string[]): string[] {
  const parsed = versions
    .map(name => ({ name, parts: /^v(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((v): v is { name: string; parts: RegExpExecArray } => v.parts !== null)
    .map(v => ({ name: v.name, key: [+v.parts[1], +v.parts[2], +v.parts[3]] }));
  parsed.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
  return parsed.map(v => `${homedir}/.nvm/versions/node/${v.name}/bin`);
}

/**
 * Prepend the bin directories CLIs are usually installed into. A GUI-launched
 * Electron app inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a
 * bare spawn('codex') fails with ENOENT even though the binary is installed.
 * Mutates and returns the given env map.
 *
 * nvm's version bins are APPENDED, not prepended, and every installed version
 * is added rather than just the default one. Both choices are deliberate:
 *
 *   - Appending keeps a terminal-launched gateway behaving exactly as before.
 *     The user's active nvm bin is already first on PATH there, so these
 *     entries only ever come into play as a fallback; prepending could hand a
 *     spawned CLI a different node than the one the user selected.
 *   - Every version, because agent CLIs get npm-installed under whichever node
 *     was active at the time and end up scattered — on this machine pi lives
 *     under v24.18.1 while codex and agent-browser live under v22.17.1. Adding
 *     only nvm's default version would still leave half of them unfindable.
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

  if (homedir) {
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(`${homedir}/.nvm/versions/node`);
    } catch {
      // No nvm installed, or unreadable — nothing to add.
    }
    for (const p of nvmBinDirs(homedir, versions)) {
      const segments = (env.PATH || '').split(':');
      if (!segments.includes(p)) {
        env.PATH = env.PATH ? `${env.PATH}:${p}` : p;
      }
    }
  }

  return env;
}

/**
 * The protocols an 'all' model claims but has no base URL for, and so leaves
 * on the ambient environment. Mirrors the wiring rule in `applyModelEnv` —
 * change one and this goes stale.
 *
 * Only 'all' models can be half-wired: a single-protocol model carries its one
 * endpoint on `baseUrl`, and an absent `baseUrl` there is the ordinary "talk to
 * the official API" case rather than a gap. A model with no credentials at all
 * is likewise opting into the ambient environment on purpose.
 */
export function unwiredAllProtocols(model: ModelConfig | undefined): Array<'anthropic' | 'openai'> {
  if (!model || model.apiType !== 'all' || !model.apiKey) return [];
  const missing: Array<'anthropic' | 'openai'> = [];
  if (!model.anthropicBaseUrl) missing.push('anthropic');
  if (!model.openaiBaseUrl) missing.push('openai');
  return missing;
}

/**
 * Apply model credentials to a child-process env map using the style
 * declared on ModelConfig.apiType. Does not mutate the caller's env.
 *
 * apiType === 'anthropic' → ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 * apiType === 'openai'    → OPENAI_BASE_URL   + OPENAI_API_KEY
 * apiType === 'all'       → both pairs, each with its own base URL
 *
 * If apiType is absent, the caller's adapter-specific default is used.
 *
 * For 'all', a protocol is only wired up when its base URL is known. Injecting
 * a third-party token with no matching base URL would aim it at the real
 * api.anthropic.com / api.openai.com and fail auth in a way that reads like a
 * broken key, so we leave that protocol on the ambient environment instead.
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
  } else if (apiType === 'all') {
    if (model.anthropicBaseUrl) {
      env.ANTHROPIC_BASE_URL = model.anthropicBaseUrl;
      if (model.apiKey) env.ANTHROPIC_AUTH_TOKEN = model.apiKey;
    }
    if (model.openaiBaseUrl) {
      env.OPENAI_BASE_URL = model.openaiBaseUrl;
      if (model.apiKey) env.OPENAI_API_KEY = model.apiKey;
    }
  }
  return env;
}
