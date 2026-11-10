import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// Settings that would point a test copy at the user's real chat bots, port or
// data folder. HOME is swapped too, so every ~/... path stays in the temp home.
const LIVE_SETTINGS = ['PORT', 'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'CODEY_HOME']

/** Starts an isolated Codey (own HOME, data and lock) beside the user's copy. */
export async function launchCodey(): Promise<{ app: ElectronApplication; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'codey-e2e-'))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !LIVE_SETTINGS.includes(name)) env[name] = value
  }
  const app = await electron.launch({
    args: [resolve(__dirname, '..')],
    env: { ...env, HOME: home, CODEY_TEST_HOME: home },
  })
  return { app, home }
}

/** Every process started by `pid`, at any depth (agent CLIs Codey probes at startup). */
function descendants(pid: number): number[] {
  const children = new Map<number, number[]>()
  for (const line of execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found: number[] = []
  for (let queue = [pid]; queue.length > 0;) {
    for (const child of children.get(queue.shift()!) ?? []) { found.push(child); queue.push(child) }
  }
  return found
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

/**
 * Codey hides its window on close and keeps running in the menu bar, so ask it
 * to quit; force-stop it if quitting stalls. Processes it started are stopped
 * too, so none can write into the test home after it is removed.
 */
export async function closeCodey(app: ElectronApplication): Promise<void> {
  const child = app.process()
  const started = child.pid ? descendants(child.pid) : []
  const exited = new Promise<void>(done => {
    if (child.exitCode !== null || child.signalCode !== null) done()
    else child.once('exit', () => done())
  })
  // Not awaited: a blocked main process would never answer.
  void app.evaluate(({ app }) => app.quit()).catch(() => {})
  const quit = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])
  if (!quit) { child.kill('SIGKILL'); await exited }
  for (let waited = 0; started.some(isRunning) && waited < 5_000; waited += 100) await sleep(100)
  for (const pid of started.filter(isRunning)) process.kill(pid, 'SIGKILL')
}

type Fixtures = { app: ElectronApplication; page: Page }

export const test = base.extend<Fixtures>({
  // Playwright reads fixture dependencies from the first argument's
  // destructuring, so a fixture without dependencies takes an empty pattern.
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use) => {
    const { app, home } = await launchCodey()
    try {
      await use(app)
    } finally {
      await closeCodey(app)
      rmSync(home, { recursive: true, force: true })
    }
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow({ timeout: 45_000 })
    await expect(page.getByText('Settings', { exact: true })).toBeVisible({ timeout: 30_000 })
    await use(page)
  },
})

export { expect }
