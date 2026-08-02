import { describe, expect, it } from 'vitest'
import { matchesToolSearch } from './tools-search'

describe('matchesToolSearch', () => {
  it('matches names and descriptions without regard to case', () => {
    expect(matchesToolSearch('GITHUB', 'github-mcp', 'Repository tools')).toBe(true)
    expect(matchesToolSearch('repository', 'github-mcp', 'Repository tools')).toBe(true)
  })

  it('trims the query and ignores missing values', () => {
    expect(matchesToolSearch('  deploy  ', 'release', undefined, 'Deploy to production')).toBe(true)
  })

  it('shows every item for an empty query', () => {
    expect(matchesToolSearch('   ', 'anything')).toBe(true)
  })
})
