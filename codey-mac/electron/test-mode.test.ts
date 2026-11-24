import { describe, expect, it } from 'vitest'
import { isolatedTestEnvironment } from './test-mode'

describe('isolatedTestEnvironment', () => {
  it('keeps ordinary launch settings', () => {
    expect(isolatedTestEnvironment({ PATH: '/usr/bin', LANG: 'en_CA.UTF-8' })).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_CA.UTF-8',
    })
  })

  it('drops credentials and paths that belong to the parent Codey', () => {
    expect(isolatedTestEnvironment({
      CODEY_BROWSER_TOKEN: 'bridge-secret',
      CODEY_HOME: '/private/data',
      OPENAI_API_KEY: 'api-secret',
      CLAUDE_CONFIG_DIR: '/private/agent',
      XDG_CONFIG_HOME: '/private/config',
      TELEGRAM_BOT_TOKEN: 'bot-secret',
      PORT: '4100',
    })).toEqual({})
  })
})
