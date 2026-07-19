import { describe, it, expect } from 'vitest'
import { decideNotification, createTurnTracker, truncate, mdToPlainText } from './chat-notifications'

const ctx = { focused: false, enabled: true }

describe('decideNotification', () => {
  it('returns null when disabled or focused', () => {
    const done = { type: 'done' as const, chatId: 'c1', response: 'hi' }
    expect(decideNotification(done, { focused: true, enabled: true })).toBeNull()
    expect(decideNotification(done, { focused: false, enabled: false })).toBeNull()
  })

  it('plain done → "Codey finished" with response snippet and chat title', () => {
    const d = decideNotification(
      { type: 'done', chatId: 'c1', response: 'All tests pass.' },
      { ...ctx, chatTitle: 'My project' },
    )
    expect(d).toEqual({ chatId: 'c1', title: 'Codey finished — My project', body: 'All tests pass.' })
  })

  it('done without chat title uses bare title', () => {
    const d = decideNotification({ type: 'done', chatId: 'c1', response: 'ok' }, ctx)
    expect(d?.title).toBe('Codey finished')
  })

  it('done with single-select userQuestion → input title + up to 4 action buttons', () => {
    const d = decideNotification(
      {
        type: 'done', chatId: 'c1', response: 'irrelevant',
        userQuestion: {
          question: 'Which approach?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
        },
      },
      { ...ctx, chatTitle: 'My project' },
    )
    expect(d?.title).toBe('Codey needs your input — My project')
    expect(d?.body).toBe('Which approach?')
    expect(d?.actions).toEqual([{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }])
  })

  it('multi-select userQuestion → notification but NO action buttons', () => {
    const d = decideNotification(
      {
        type: 'done', chatId: 'c1', response: '',
        userQuestion: { question: 'Pick several', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
      },
      ctx,
    )
    expect(d?.title).toBe('Codey needs your input')
    expect(d?.actions).toBeUndefined()
  })

  it('userQuestion with fewer than 1 option falls back to plain done', () => {
    const d = decideNotification(
      { type: 'done', chatId: 'c1', response: 'resp', userQuestion: { question: 'q', options: [] } },
      ctx,
    )
    expect(d?.title).toBe('Codey finished')
  })

  it('error → "Codey hit an error" with message', () => {
    const d = decideNotification({ type: 'error', chatId: 'c1', message: 'boom' }, ctx)
    expect(d).toEqual({ chatId: 'c1', title: 'Codey hit an error', body: 'boom' })
  })

  it('all other event types → null', () => {
    for (const type of ['queued', 'tool_start', 'tool_end', 'info', 'stream', 'thinking', 'stopped', 'permission_denials']) {
      expect(decideNotification({ type, chatId: 'c1' } as any, ctx)).toBeNull()
    }
  })

  it('bodies are truncated to 180 chars with ellipsis', () => {
    const long = 'x'.repeat(300)
    const d = decideNotification({ type: 'done', chatId: 'c1', response: long }, ctx)
    expect(d?.body.length).toBe(180)
    expect(d?.body.endsWith('…')).toBe(true)
  })
})

describe('mdToPlainText', () => {
  it('strips emphasis, inline code and headings', () => {
    expect(mdToPlainText('## Done\nFixed **the bug** in `auth.ts`')).toBe('Done Fixed the bug in auth.ts')
  })
  it('keeps link/image text, drops the URL', () => {
    expect(mdToPlainText('See [the PR](https://x/y) and ![logo](a.png)')).toBe('See the PR and logo')
  })
  it('flattens bullet and numbered lists into one line', () => {
    expect(mdToPlainText('- one\n- two\n\n1. three')).toBe('one two three')
  })
  it('drops code fences but keeps the code text', () => {
    expect(mdToPlainText('Run:\n```bash\nnpm test\n```')).toBe('Run: npm test')
  })
  it('strips blockquotes and horizontal rules', () => {
    expect(mdToPlainText('> quoted\n\n---\n\ntext')).toBe('quoted text')
  })
  it('leaves plain prose untouched', () => {
    expect(mdToPlainText('All tests pass.')).toBe('All tests pass.')
  })
})

describe('decideNotification markdown handling', () => {
  it('renders the done body as plain text, not raw markdown', () => {
    const d = decideNotification(
      { type: 'done', chatId: 'c1', response: '## Summary\n- Did **X**\n- See [docs](http://d)' },
      ctx,
    )
    expect(d?.body).toBe('Summary Did X See docs')
  })
})

describe('truncate', () => {
  it('leaves short strings alone and trims whitespace', () => {
    expect(truncate('  hi  ', 10)).toBe('hi')
  })
})

describe('createTurnTracker', () => {
  it('dedupes: second terminal event for the same turn is suppressed', () => {
    const t = createTurnTracker()
    t.observe({ type: 'stream', chatId: 'c1' })
    expect(t.alreadyNotified('c1')).toBe(false)
    t.markNotified('c1')
    t.observe({ type: 'done', chatId: 'c1' })
    expect(t.alreadyNotified('c1')).toBe(true) // duplicate done / error-after-done suppressed
  })

  it('a new turn resets the notified flag', () => {
    const t = createTurnTracker()
    t.markNotified('c1')
    t.observe({ type: 'queued', chatId: 'c1' }) // new turn begins
    expect(t.alreadyNotified('c1')).toBe(false)
  })

  it('tracks in-flight per chat from non-terminal vs terminal events', () => {
    const t = createTurnTracker()
    expect(t.isInFlight('c1')).toBe(false)
    t.observe({ type: 'tool_start', chatId: 'c1' })
    expect(t.isInFlight('c1')).toBe(true)
    t.observe({ type: 'done', chatId: 'c1' })
    expect(t.isInFlight('c1')).toBe(false)
    t.observe({ type: 'stream', chatId: 'c2' })
    expect(t.isInFlight('c2')).toBe(true)
    expect(t.isInFlight('c1')).toBe(false)
  })

  it('does not reopen a completed turn for a post-run skill notice', () => {
    const t = createTurnTracker()
    t.observe({ type: 'stream', chatId: 'c1' })
    t.observe({ type: 'done', chatId: 'c1' })
    t.observe({ type: 'info', chatId: 'c1', skillNotice: true })
    expect(t.isInFlight('c1')).toBe(false)
  })
})
