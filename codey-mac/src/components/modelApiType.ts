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
