/**
 * Protocol compatibility between models and agents, for the renderer.
 *
 * Mirrors `ApiType` / `modelFitsApiType` in @codey/core — kept local because
 * the renderer must not pull in the core package (it reaches for Node
 * builtins, which blanks the packaged window).
 */

export type ApiType = 'anthropic' | 'openai' | 'all'

/**
 * The protocol each agent's CLI authenticates against. 'all' marks a
 * provider-agnostic CLI (it picks the provider from the model name), so it
 * accepts models of either protocol.
 */
export const AGENT_API_TYPE: Record<string, ApiType> = {
  'claude-code': 'anthropic',
  'opencode': 'all',
  'codex': 'openai',
  'pi': 'all',
}

export const AGENT_NAMES = ['claude-code', 'opencode', 'codex', 'pi'] as const

/**
 * True when a model can drive an agent that speaks `want`. An 'all' model
 * (third-party provider exposing both protocols) fits every agent, and an
 * 'all' agent (provider-agnostic CLI) accepts every model; an undefined
 * `want` means the agent declares no protocol, so anything goes.
 */
export function modelFitsApiType(modelApiType: ApiType, want?: ApiType): boolean {
  if (!want || want === 'all') return true
  return modelApiType === 'all' || modelApiType === want
}

/** Convenience wrapper keyed by agent name. */
export function modelFitsAgent(modelApiType: ApiType, agent?: string): boolean {
  return modelFitsApiType(modelApiType, agent ? AGENT_API_TYPE[agent] : undefined)
}

/** The base URLs an API key entry defines, as far as this check cares. */
export interface KeyEndpoints {
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
}

/**
 * Which protocols an 'all' model promises that its bound key cannot deliver.
 *
 * An 'all' model claims both endpoints, but `applyModelEnv` wires each protocol
 * up only when the key defines that protocol's base URL — the other half is
 * silently left on the ambient environment, so the spawned CLI aims a
 * third-party token at the real api.anthropic.com / api.openai.com and fails in
 * a way that reads like a broken key. Naming the missing halves before the
 * model is saved is the only place that mismatch is visible.
 *
 * Only meaningful for 'all'. A single-protocol model with no base URL is the
 * ordinary "talk to the official endpoint" case, and a model bound to no key at
 * all is explicitly opting into the ambient environment.
 */
export function missingAllEndpoints(apiType: ApiType, key?: KeyEndpoints): ApiType[] {
  if (apiType !== 'all' || !key) return []
  const missing: ApiType[] = []
  if (!key.anthropicBaseUrl?.trim()) missing.push('anthropic')
  if (!key.openaiBaseUrl?.trim()) missing.push('openai')
  return missing
}

/**
 * Agents that speak `protocol` and nothing else — the ones with no other
 * protocol to fall back on when its endpoint is missing. An 'all' agent is
 * excluded: it can still run on whichever protocol did get wired up.
 */
export function agentsPinnedTo(protocol: ApiType): string[] {
  return AGENT_NAMES.filter(a => AGENT_API_TYPE[a] === protocol)
}
