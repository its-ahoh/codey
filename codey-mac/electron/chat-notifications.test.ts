import { describe, it, expect } from 'vitest'
import { decideNotification, createTurnTracker, truncate, mdToPlainText, decideTurnSound, resolveTurnSoundFile, TURN_SOUND_FILES } from './chat-notifications'

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

describe('decideTurnSound', () => {
  const on = { enabled: true }
  it('plays even while focused, picks a sound per end state', () => {
    expect(decideTurnSound({ type: 'done', chatId: 'c', response: 'ok' }, on)).toBe('done')
    expect(decideTurnSound({ type: 'error', chatId: 'c', message: 'x' }, on)).toBe('error')
    expect(decideTurnSound({
      type: 'done', chatId: 'c',
      userQuestion: { question: 'Pick?', options: [{ label: 'Blue' }] },
    }, on)).toBe('input')
  })
  it('plays the error sound for a failed team run or bot', () => {
    expect(decideTurnSound({ type: 'done', chatId: 'c', response: '', failed: true }, on)).toBe('error')
    expect(decideTurnSound({ type: 'done', chatId: 'c', response: 'x', botStatus: 'failed' }, on)).toBe('error')
  })
  it('plays the input sound for every way a turn can wait on the user', () => {
    expect(decideTurnSound({ type: 'done', chatId: 'c', choices: ['A', 'B'] }, on)).toBe('input')
    expect(decideTurnSound({ type: 'done', chatId: 'c', botStatus: 'askedUser' }, on)).toBe('input')
    expect(decideTurnSound({ type: 'done', chatId: 'c', response: 'Which file?' }, { enabled: true, awaitingInput: true })).toBe('input')
  })
  it('stays quiet for automation chats, which have their own opt-in banner', () => {
    expect(decideTurnSound({ type: 'done', chatId: 'c', response: 'ok' }, { enabled: true, automation: true })).toBeNull()
    expect(decideTurnSound({ type: 'error', chatId: 'c', message: 'x' }, { enabled: true, automation: true })).toBeNull()
  })
  it('stays quiet when disabled, on stop, and mid-turn', () => {
    expect(decideTurnSound({ type: 'done', chatId: 'c' }, { enabled: false })).toBeNull()
    expect(decideTurnSound({ type: 'stopped', chatId: 'c' }, on)).toBeNull()
    expect(decideTurnSound({ type: 'delta', chatId: 'c' }, on)).toBeNull()
  })
})

describe('resolveTurnSoundFile', () => {
  it('uses the picked file when it exists', () => {
    expect(resolveTurnSoundFile('error', '/tmp/chime.mp3', () => true)).toBe('/tmp/chime.mp3')
  })
  it('falls back to the built-in sound for a non-audio, relative, or option-like path', () => {
    expect(resolveTurnSoundFile('done', '/etc/passwd', () => true)).toBe(TURN_SOUND_FILES.done)
    expect(resolveTurnSoundFile('done', 'chime.mp3', () => true)).toBe(TURN_SOUND_FILES.done)
    expect(resolveTurnSoundFile('done', '-v.mp3', () => true)).toBe(TURN_SOUND_FILES.done)
    expect(resolveTurnSoundFile('done', '/tmp/Chime.MP3', () => true)).toBe('/tmp/Chime.MP3')
  })
  it('falls back to the built-in sound when unset or missing', () => {
    expect(resolveTurnSoundFile('done', undefined, () => true)).toBe(TURN_SOUND_FILES.done)
    expect(resolveTurnSoundFile('done', '', () => true)).toBe(TURN_SOUND_FILES.done)
    expect(resolveTurnSoundFile('input', '/tmp/gone.wav', () => false)).toBe(TURN_SOUND_FILES.input)
  })
})
