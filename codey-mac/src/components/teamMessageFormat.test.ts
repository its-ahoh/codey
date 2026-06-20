import { describe, it, expect } from 'vitest'
import { parseTeamMessage, extractPreview } from './teamMessageFormat'

describe('parseTeamMessage', () => {
  it('returns null for plain text', () => {
    expect(parseTeamMessage('hello world')).toBeNull()
  })

  it('returns null for content that lacks the team marker', () => {
    expect(parseTeamMessage('### Some heading\n\nbody')).toBeNull()
  })

  it('parses summary + multiple steps', () => {
    const input = [
      '🧭 Advisor summary: All done.',
      '',
      '### Step 1: alice',
      '',
      'alice did a thing.',
      '',
      '---',
      '',
      '### Step 2: bob',
      '',
      'bob also did a thing.',
    ].join('\n')
    const r = parseTeamMessage(input)
    expect(r).not.toBeNull()
    expect(r!.summary).toBe('All done.')
    expect(r!.steps).toHaveLength(2)
    expect(r!.steps[0]).toEqual({ step: 1, worker: 'alice', output: 'alice did a thing.' })
    expect(r!.steps[1]).toEqual({ step: 2, worker: 'bob', output: 'bob also did a thing.' })
  })

  it('parses steps without a summary', () => {
    const input = [
      '### Step 1: alice',
      '',
      'output here',
    ].join('\n')
    const r = parseTeamMessage(input)
    expect(r).not.toBeNull()
    expect(r!.summary).toBeNull()
    expect(r!.steps).toHaveLength(1)
  })

  it('preserves "(revision)" suffix in worker name', () => {
    const input = '### Step 3: alice (revision)\n\nfixed it'
    const r = parseTeamMessage(input)
    expect(r!.steps[0].worker).toBe('alice (revision)')
  })

  it('returns null when any chunk fails to match the step pattern', () => {
    const input = [
      '🧭 Advisor summary: x',
      '',
      'not a step heading at all',
    ].join('\n')
    expect(parseTeamMessage(input)).toBeNull()
  })

  // The Sequential / `all` dispatch paths (authored-graph teams) emit a
  // different transcript than the `### Step` auto/advisor format: a
  // "📊 Team **X** flow results" header followed by "**worker**:" blocks,
  // optionally trailed by a "🧠 Team blackboard" section.
  it('parses the Sequential "flow results" / **worker**: format', () => {
    const input = [
      '📊 Team **Feature** flow results',
      '',
      '**product-manager**:',
      'PM wrote the spec.',
      '',
      'It has **bold** mid-output and a blank line.',
      '',
      '**architect**:',
      'Design done.',
    ].join('\n')
    const r = parseTeamMessage(input)
    expect(r).not.toBeNull()
    expect(r!.steps).toHaveLength(2)
    expect(r!.steps[0]).toEqual({
      step: 1, worker: 'product-manager',
      output: 'PM wrote the spec.\n\nIt has **bold** mid-output and a blank line.',
    })
    expect(r!.steps[1]).toMatchObject({ step: 2, worker: 'architect', output: 'Design done.' })
  })

  it('captures same-line worker output (failed step) and excludes the blackboard', () => {
    const input = [
      '📊 Team **Feature** flow results',
      '',
      '**product-manager**:',
      'spec ok',
      '',
      '**developer**: ❌ Failed - build error',
      '',
      '---',
      '',
      '### 🧠 Team blackboard',
      '',
      '**Decisions:**',
      '- *product-manager* — ship it',
    ].join('\n')
    const r = parseTeamMessage(input)
    expect(r!.steps).toHaveLength(2)
    expect(r!.steps[1]).toMatchObject({ step: 2, worker: 'developer', output: '❌ Failed - build error' })
  })

  it('also parses the "results" header without the "flow" word (all path)', () => {
    const input = '📊 Team **Crew** results\n\n**alice**:\ndid a thing'
    const r = parseTeamMessage(input)
    expect(r!.steps).toEqual([{ step: 1, worker: 'alice', output: 'did a thing' }])
  })
})

describe('extractPreview', () => {
  it('returns "(no output)" for empty', () => {
    expect(extractPreview('')).toBe('(no output)')
    expect(extractPreview('   \n\n  ')).toBe('(no output)')
  })

  it('takes first sentence of last non-empty paragraph', () => {
    const text = 'First paragraph here.\n\nSecond paragraph. Has two sentences.'
    expect(extractPreview(text)).toBe('Has two sentences.')
  })

  it('handles Chinese full stop', () => {
    const text = '中间段落\n\n结论一。结论二。' // lint-allow-non-english: Chinese fixture
    expect(extractPreview(text)).toBe('结论一。') // lint-allow-non-english: Chinese fixture
  })

  it('returns whole paragraph when no sentence terminator', () => {
    expect(extractPreview('just a fragment')).toBe('just a fragment')
  })

  it('truncates long previews to ~120 chars with ellipsis', () => {
    const long = 'a'.repeat(200)
    const out = extractPreview(long)
    expect(out.length).toBeLessThanOrEqual(121)
    expect(out.endsWith('…')).toBe(true)
  })
})
