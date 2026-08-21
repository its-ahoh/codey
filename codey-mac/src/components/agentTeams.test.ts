import { describe, expect, it } from 'vitest'
import {
  AGENT_TEAMS_ENV_KEY,
  envWithoutAgentTeams,
  isAgentTeamsOn,
  mergeEnvKeepingAgentTeams,
  setAgentTeams,
} from './agentTeams'

describe('isAgentTeamsOn', () => {
  it('is off when unset or empty', () => {
    expect(isAgentTeamsOn(undefined)).toBe(false)
    expect(isAgentTeamsOn({})).toBe(false)
    expect(isAgentTeamsOn({ [AGENT_TEAMS_ENV_KEY]: '' })).toBe(false)
  })
  it('reads hand-written falsey values as off', () => {
    expect(isAgentTeamsOn({ [AGENT_TEAMS_ENV_KEY]: '0' })).toBe(false)
    expect(isAgentTeamsOn({ [AGENT_TEAMS_ENV_KEY]: 'False' })).toBe(false)
  })
  it('is on for 1 or any other value', () => {
    expect(isAgentTeamsOn({ [AGENT_TEAMS_ENV_KEY]: '1' })).toBe(true)
    expect(isAgentTeamsOn({ [AGENT_TEAMS_ENV_KEY]: 'true' })).toBe(true)
  })
})

describe('setAgentTeams', () => {
  it('writes 1 when turned on and keeps other vars', () => {
    expect(setAgentTeams({ FOO: 'bar' }, true)).toEqual({ FOO: 'bar', [AGENT_TEAMS_ENV_KEY]: '1' })
  })
  it('removes the key when turned off rather than writing 0', () => {
    expect(setAgentTeams({ FOO: 'bar', [AGENT_TEAMS_ENV_KEY]: '1' }, false)).toEqual({ FOO: 'bar' })
  })
  it('does not mutate the input', () => {
    const env = { [AGENT_TEAMS_ENV_KEY]: '1' }
    setAgentTeams(env, false)
    expect(env).toEqual({ [AGENT_TEAMS_ENV_KEY]: '1' })
  })
})

describe('env editor round-trip', () => {
  it('hides the flag from the editor', () => {
    expect(envWithoutAgentTeams({ FOO: 'bar', [AGENT_TEAMS_ENV_KEY]: '1' })).toEqual({ FOO: 'bar' })
  })
  it('keeps the flag when the editor commits without it', () => {
    const prev = { FOO: 'bar', [AGENT_TEAMS_ENV_KEY]: '1' }
    expect(mergeEnvKeepingAgentTeams(prev, { FOO: 'baz' })).toEqual({ FOO: 'baz', [AGENT_TEAMS_ENV_KEY]: '1' })
  })
  it('leaves the flag absent when it was never set', () => {
    expect(mergeEnvKeepingAgentTeams({ FOO: 'bar' }, { FOO: 'baz' })).toEqual({ FOO: 'baz' })
  })
  it('ignores a stale copy typed into the editor', () => {
    const prev = { [AGENT_TEAMS_ENV_KEY]: '1' }
    expect(mergeEnvKeepingAgentTeams(prev, { [AGENT_TEAMS_ENV_KEY]: '0' })).toEqual({ [AGENT_TEAMS_ENV_KEY]: '1' })
  })
})
