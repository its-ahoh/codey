import { join } from 'path'

/**
 * App verification runs a second Codey next to the user's own copy. Setting
 * CODEY_TEST_HOME (the runner also points HOME there) gives that copy its own
 * data, its own single-instance lock and no machine-wide side effects.
 */
export const testHome = process.env.CODEY_TEST_HOME || null
export const isTestMode = testHome !== null

export function testUserDataDir(home: string): string {
  return join(home, 'user-data')
}
