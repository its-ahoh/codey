// Claude Code hides its multi-agent "Agent Teams" mode behind an experimental
// env flag (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, equivalent to the CLI's
// `--agent-teams`). The gateway already forwards each agent's configured env
// to the spawned CLI, so the switch in Agents settings is just a nicer face on
// that one variable — these helpers keep it out of the raw env editor so the
// same key can't be edited from two places at once.
export const AGENT_TEAMS_ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'

// The agent slot whose CLI understands the flag. Other agents never show it.
export const AGENT_TEAMS_AGENT = 'claude-code'

type Env = Record<string, string>

// Claude Code treats the variable as set/unset, but a user who typed it by
// hand may well have written `0` or `false` — read those as off.
export function isAgentTeamsOn(env: Env | undefined): boolean {
  const v = (env ?? {})[AGENT_TEAMS_ENV_KEY]
  if (v === undefined) return false
  const t = v.trim().toLowerCase()
  return t !== '' && t !== '0' && t !== 'false'
}

// Off removes the key rather than writing `0`, so turning the switch off
// leaves the env exactly as it was before it was ever turned on.
export function setAgentTeams(env: Env | undefined, on: boolean): Env {
  const next = { ...(env ?? {}) }
  if (on) next[AGENT_TEAMS_ENV_KEY] = '1'
  else delete next[AGENT_TEAMS_ENV_KEY]
  return next
}

// What the raw env editor should show: everything except the switch's key.
export function envWithoutAgentTeams(env: Env | undefined): Env {
  const next = { ...(env ?? {}) }
  delete next[AGENT_TEAMS_ENV_KEY]
  return next
}

// The env editor only ever sees the filtered rows, so committing its result
// verbatim would silently clear the flag. Carry the previous value across.
export function mergeEnvKeepingAgentTeams(prev: Env | undefined, edited: Env): Env {
  const next = envWithoutAgentTeams(edited)
  const flag = (prev ?? {})[AGENT_TEAMS_ENV_KEY]
  if (flag !== undefined) next[AGENT_TEAMS_ENV_KEY] = flag
  return next
}
