import { ModelConfig } from '../types';

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
