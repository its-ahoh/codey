import { join } from 'path'

/**
 * App verification runs a second Codey next to the user's own copy. Setting
 * CODEY_TEST_HOME (the runner also points HOME there) gives that copy its own
 * data, its own single-instance lock and no machine-wide side effects.
 */
export const testHome = process.env.CODEY_TEST_HOME || null
export const isTestMode = testHome !== null

// These can point an otherwise isolated copy back at the user's agent data or
// credentials. CODEY_* also includes per-run Browser, Terminal and Computer
// bridge capabilities, which must never cross into another Codey process.
const USER_ENVIRONMENT = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CURSOR_API_KEY',
  'DISCORD_BOT_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_CONFIG',
  'PORT',
  'TELEGRAM_BOT_TOKEN',
  'XAI_API_KEY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
])

export function isolatedTestEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
        && !entry[0].startsWith('CODEY_')
        && !USER_ENVIRONMENT.has(entry[0]),
    ),
  )
}

export function testUserDataDir(home: string): string {
  return join(home, 'user-data')
}
