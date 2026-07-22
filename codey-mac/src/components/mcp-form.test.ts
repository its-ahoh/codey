import { describe, expect, it } from 'vitest'
import { parseArgsLine, parseEnvLines } from './mcp-form'

describe('parseEnvLines', () => {
  it('parses KEY=VALUE lines, skipping blanks and trimming', () => {
    expect(parseEnvLines('A=1\n\n  B = two words \nC=x=y')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x=y',
    })
  })

  it('returns empty for empty input', () => {
    expect(parseEnvLines('')).toEqual({})
    expect(parseEnvLines('  \n ')).toEqual({})
  })

  it('throws on lines without a key', () => {
    expect(() => parseEnvLines('novalue')).toThrow(/KEY=VALUE/)
    expect(() => parseEnvLines('=leading')).toThrow(/KEY=VALUE/)
  })
})

describe('parseArgsLine', () => {
  it('splits on whitespace and handles empty input', () => {
    expect(parseArgsLine(' -y  @scope/pkg ')).toEqual(['-y', '@scope/pkg'])
    expect(parseArgsLine('')).toEqual([])
    expect(parseArgsLine('   ')).toEqual([])
  })
})
