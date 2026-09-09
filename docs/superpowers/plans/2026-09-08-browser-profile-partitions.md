# Per-Profile Browser Partitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every saved browser profile its own Electron partition so profiles are fully isolated, logins made inside Codey's browser survive restarts, and naming a profile no longer switches identity for every open tab.

**Architecture:** `BROWSER_PARTITION` stops being a single constant and becomes a function of profile name. `BrowserController` gains a session factory keyed by partition, tabs record which profile they belong to, and the partition — not a JSON file — becomes a profile's source of truth. JSON survives only at the import/export/Chrome-sync boundaries. The merge machinery (`applyLiveProfiles`, `profileConflict`, `mergeProfileSites`) is deleted because isolation makes overlap harmless.

**Tech Stack:** TypeScript (CommonJS, strict), Electron `WebContentsView` + `session.fromPartition`, Vitest, React 18 renderer.

**Spec:** `docs/superpowers/specs/2026-09-08-browser-profile-partitions-design.md`

**Before you start — Node version.** The default `node` on this machine is v16 and cannot run Vitest or `tsc`. Every command in this plan assumes:

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
node -v   # must print v22.17.1
```

**Running tests.** From the repo root:

```bash
npx vitest run electron/browser-profiles.test.ts --root codey-mac
npx vitest run electron/browser-controller.test.ts --root codey-mac
npx vitest run --root codey-mac                       # the whole codey-mac suite
```

**Typecheck.** `npm run build -w codey-mac` compiles the Electron main process; run it before the final commit of each task that changes types.

---

### Task 1: Partition names

A profile's partition name has to be derived from its profile name, deterministically, and be safe as a Chromium partition string. Profile names are already constrained by `assertProfileName` to `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`, so no escaping is needed — but the derivation belongs in one place with a test, because five call sites will use it.

**Files:**
- Modify: `codey-mac/electron/browser-profiles.ts` (append near `assertProfileName`, around line 100)
- Test: `codey-mac/electron/browser-profiles.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `codey-mac/electron/browser-profiles.test.ts`:

```typescript
describe('profilePartition', () => {
  it('gives each profile its own partition and the default jar to none', () => {
    expect(profilePartition(null)).toBe('persist:codey-browser')
    expect(profilePartition('work')).toBe('persist:codey-profile-work')
    expect(profilePartition('personal')).toBe('persist:codey-profile-personal')
  })

  it('never collides two profiles onto one partition', () => {
    expect(profilePartition('work')).not.toBe(profilePartition('work2'))
  })

  it('refuses a name that is not a valid profile name', () => {
    expect(() => profilePartition('../escape')).toThrow(/Profile names must be/)
  })
})
```

Add `profilePartition` to the import list at the top of the file (the `from './browser-profiles'` import).

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-profiles.test.ts --root codey-mac
```

Expected: FAIL — `profilePartition is not a function` (or a TypeScript "no exported member" error).

- [ ] **Step 3: Implement**

In `codey-mac/electron/browser-profiles.ts`, directly after the `assertProfileName` function:

```typescript
/** The default storage jar, used by tabs that belong to no profile. This is
 *  the partition the browser used before profiles were isolated, so an
 *  existing install keeps whatever it was signed into. */
export const DEFAULT_BROWSER_PARTITION = 'persist:codey-browser'

/** The Electron partition that holds a profile's session. Each profile gets
 *  its own Chromium storage bucket - cookies, localStorage, IndexedDB, cache -
 *  so two profiles signed into the same site cannot see or overwrite each
 *  other. `null` means "no profile", which is the default jar. */
export function profilePartition(name: string | null): string {
  if (name === null) return DEFAULT_BROWSER_PARTITION
  assertProfileName(name)
  return `persist:codey-profile-${name}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run electron/browser-profiles.test.ts --root codey-mac
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-profiles.ts codey-mac/electron/browser-profiles.test.ts
git commit -m "feat(browser): derive a partition name per profile

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The session factory takes a partition

`BrowserController`'s fifth constructor argument is `getBrowserSession: () => Session` (`browser-controller.ts:258`), which hands back the one shared session. It becomes `(partition: string) => Session`, and the controller grows a `sessionFor(profileName)` helper so the rest of the class never builds a partition string itself.

**Files:**
- Modify: `codey-mac/electron/browser-controller.ts:29`, `:258`, `:287-291`
- Test: `codey-mac/electron/browser-controller.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `codey-mac/electron/browser-controller.test.ts`, inside the `describe` block that contains `makeFixture` (after the `makeFixture` definition, before the first `it`):

```typescript
  it('asks for a different session per profile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-partitions-'))
    try {
      const asked: string[] = []
      const makeSession = () => ({
        cookies: { get: vi.fn(async () => []), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        clearStorageData: vi.fn(async () => {}),
      })
      const sessions = new Map<string, any>()
      const controller = new BrowserController(
        () => null,
        vi.fn(),
        vi.fn(),
        undefined,
        (partition: string) => {
          asked.push(partition)
          if (!sessions.has(partition)) sessions.set(partition, makeSession())
          return sessions.get(partition)
        },
        { getProfilesDir: () => dir },
      )
      expect((controller as any).sessionFor('work')).not.toBe((controller as any).sessionFor('personal'))
      expect((controller as any).sessionFor('work')).toBe((controller as any).sessionFor('work'))
      expect(asked).toContain('persist:codey-profile-work')
      expect(asked).toContain('persist:codey-profile-personal')
      expect((controller as any).sessionFor(null)).toBe(sessions.get('persist:codey-browser'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac -t 'different session per profile'
```

Expected: FAIL — `controller.sessionFor is not a function`.

- [ ] **Step 3: Implement**

In `codey-mac/electron/browser-controller.ts`, replace line 29:

```typescript
export const BROWSER_PARTITION = 'persist:codey-browser'
```

with a re-export so existing importers keep working:

```typescript
export { DEFAULT_BROWSER_PARTITION as BROWSER_PARTITION } from './browser-profiles'
```

Add `profilePartition` and `DEFAULT_BROWSER_PARTITION` to the existing `from './browser-profiles'` import block (`browser-controller.ts:12-26`).

Change the constructor parameter (line 258) from:

```typescript
    private readonly getBrowserSession: () => Session = () => session.fromPartition(BROWSER_PARTITION, { cache: true }),
```

to:

```typescript
    private readonly getBrowserSession: (partition: string) => Session =
      (partition: string) => session.fromPartition(partition, { cache: true }),
```

Add the helper immediately after the `profiles()` method (`browser-controller.ts:278-285`):

```typescript
  /** The session that holds one profile's login state. `null` is the default
   *  jar, used by tabs that belong to no profile. Electron returns the same
   *  Session object for a partition string it has already seen, so this is
   *  cheap to call. */
  private sessionFor(profileName: string | null): Session {
    return this.getBrowserSession(profilePartition(profileName))
  }
```

Fix the one existing caller in `setSitePermissionManager` (`browser-controller.ts:287-291`):

```typescript
  setSitePermissionManager(manager: BrowserSitePermissionManager): void {
    this.sitePermissionManager = manager
    this.bindSitePermissions(this.sessionFor(null))
  }
```

Every other `this.getBrowserSession()` call in the file becomes `this.sessionFor(null)` for now; later tasks give them a real profile. Those call sites are in `captureProfileData` (line 1256) and `applyProfileData` (line 1322).

Update `main.ts:2042` from:

```typescript
  const browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true })
```

to the same thing — it is already a literal partition string, so no change is needed there yet; Task 10 and Task 11 revisit it.

Update `makeFixture` in `browser-controller.test.ts:487` from `() => session as any` to `(_partition: string) => session as any`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac
npm run build -w codey-mac
```

Expected: all tests PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-controller.ts codey-mac/electron/browser-controller.test.ts
git commit -m "refactor(browser): key the session factory by partition

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Tabs carry a profile

A tab's `WebContentsView` is created on a partition and cannot change it afterwards, so a tab's profile is fixed at creation. Popups inherit their opener's profile — an OAuth popup that landed in the default jar while its opener was in "work" would sign in to the wrong place.

**Files:**
- Modify: `codey-mac/electron/browser-controller.ts:123-128` (`BrowserTab`), `:142-145` (`BrowserTabRecord`), `:307-312` (`newTab`), `:1583-1600` (`createTab`), `:1680-1698` (popup handler)
- Test: `codey-mac/electron/browser-controller.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `browser-controller.test.ts` in the same `describe` block as Task 2's test:

```typescript
  it('reports which profile each tab belongs to', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-tabprofile-'))
    try {
      const { controller } = makeFixture(dir)
      ;(controller as any).tabs = [
        { id: 't1', view: { webContents: { isDestroyed: () => false, getURL: () => 'https://a.com/', getTitle: () => 'A' } }, profile: null },
        { id: 't2', view: { webContents: { isDestroyed: () => false, getURL: () => 'https://b.com/', getTitle: () => 'B' } }, profile: 'work' },
      ]
      ;(controller as any).view = (controller as any).tabs[1].view
      expect(controller.listTabs().map(tab => [tab.id, tab.profile])).toEqual([
        ['t1', null],
        ['t2', 'work'],
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac -t 'which profile each tab'
```

Expected: FAIL — `tab.profile` is `undefined`, so the arrays do not match.

- [ ] **Step 3: Implement**

`browser-controller.ts:123`, add a field to `BrowserTab`:

```typescript
export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
  /** The profile whose storage jar this tab uses; null is the default jar. */
  profile: string | null
}
```

`browser-controller.ts:142`, add it to the record:

```typescript
interface BrowserTabRecord {
  id: string
  view: WebContentsView
  profile: string | null
}
```

`listTabs` (`browser-controller.ts:261`) maps the new field through:

```typescript
  listTabs(): BrowserTab[] {
    return this.tabs.map(tab => ({
      id: tab.id,
      title: tab.view.webContents.getTitle() || 'New tab',
      url: tab.view.webContents.getURL() || '',
      active: tab.view === this.view,
      profile: tab.profile,
    }))
  }
```

(Keep whatever the existing body computes for `title`/`url`/`active`; only `profile` is added.)

`createTab` (`browser-controller.ts:1583`) takes the profile and builds the view on that partition:

```typescript
  private createTab(activate: boolean, profileName: string | null = null): BrowserTabRecord {
    const browserSession = this.sessionFor(profileName)
    this.bindSitePermissions(browserSession)
    this.bindDownloads(browserSession)

    const view = new WebContentsView({
      webPreferences: {
        partition: profilePartition(profileName),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
```

Everywhere `createTab` pushes the record onto `this.tabs`, include `profile: profileName`.

`newTab` (`browser-controller.ts:307`) accepts a profile:

```typescript
  async newTab(input = 'about:blank', profileName: string | null = null): Promise<BrowserState> {
    if (profileName !== null) assertProfileName(profileName)
    const url = normalizeBrowserUrl(input)
    const tab = this.createTab(true, profileName)
    if (url !== 'about:blank') await tab.view.webContents.loadURL(url)
    return this.refreshState()
  }
```

The popup handler (`browser-controller.ts:1691`) uses the opener's partition. `setWindowOpenHandler` is installed inside `createTab`, so `profileName` is in scope:

```typescript
            webPreferences: {
              partition: profilePartition(profileName),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
            },
```

The hidden storage view (`browser-controller.ts:267`) also needs a partition. Change `createHiddenView` from `() => WebContentsView` to `(partition: string) => WebContentsView`, in both `BrowserControllerOptions` (`:101`), the field declaration (`:249`) and the default:

```typescript
    this.createHiddenView = options.createHiddenView ?? ((partition: string) => new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    }))
```

`applyLocalStorage` (`browser-controller.ts:1372`) takes the profile through to it — see Task 5, which changes that method's signature. For this task, pass `profilePartition(null)` at the single existing call site so the code compiles:

```typescript
    const view = this.createHiddenView?.(profilePartition(null))
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac
npm run build -w codey-mac
```

Expected: PASS. If other tests construct tab records literally, add `profile: null` to them.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-controller.ts codey-mac/electron/browser-controller.test.ts
git commit -m "feat(browser): bind each tab to a profile's partition

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Bind permissions and downloads per partition

`bindSitePermissions` and `bindDownloads` guard themselves with a single boolean (`permissionSessionBound`, `downloadSessionBound`), which means only the first partition ever gets handlers. A tab in the second profile would silently get no permission prompts and no download capture.

The permission store and the download list stay global on purpose: a permission is the user's decision about a *site*, not about an identity, and a download is a file on disk.

**Files:**
- Modify: `codey-mac/electron/browser-controller.ts:239-240` (the flags), `:1619-1622`, `:1724-1726`
- Test: `codey-mac/electron/browser-controller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
  it('binds permission and download handlers on every partition it opens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-bind-'))
    try {
      const made = new Map<string, any>()
      const controller = new BrowserController(
        () => null,
        vi.fn(),
        vi.fn(),
        undefined,
        (partition: string) => {
          if (!made.has(partition)) {
            made.set(partition, {
              cookies: { get: vi.fn(async () => []), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
              clearStorageData: vi.fn(async () => {}),
              setPermissionCheckHandler: vi.fn(),
              setPermissionRequestHandler: vi.fn(),
              on: vi.fn(),
            })
          }
          return made.get(partition)
        },
        { getProfilesDir: () => dir },
      )
      const work = (controller as any).sessionFor('work')
      const personal = (controller as any).sessionFor('personal')
      ;(controller as any).bindSitePermissions(work)
      ;(controller as any).bindDownloads(work)
      ;(controller as any).bindSitePermissions(personal)
      ;(controller as any).bindDownloads(personal)

      expect(work.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
      expect(personal.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
      expect(work.on).toHaveBeenCalledTimes(1)
      expect(personal.on).toHaveBeenCalledTimes(1)

      // Binding the same session twice must not stack handlers.
      ;(controller as any).bindSitePermissions(work)
      ;(controller as any).bindDownloads(work)
      expect(work.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
      expect(work.on).toHaveBeenCalledTimes(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac -t 'every partition it opens'
```

Expected: FAIL — `personal.setPermissionCheckHandler` was called 0 times, because the boolean flag was already true.

- [ ] **Step 3: Implement**

Replace the two boolean fields (`browser-controller.ts:239-240`) with sets of bound sessions:

```typescript
  private readonly permissionBoundSessions = new WeakSet<Session>()
  private readonly downloadBoundSessions = new WeakSet<Session>()
```

`bindSitePermissions` (`:1619`):

```typescript
  private bindSitePermissions(browserSession: Session): void {
    if (this.permissionBoundSessions.has(browserSession)) return
    this.permissionBoundSessions.add(browserSession)
```

`bindDownloads` (`:1724`):

```typescript
  private bindDownloads(browserSession: Session): void {
    if (this.downloadBoundSessions.has(browserSession)) return
    this.downloadBoundSessions.add(browserSession)
```

The rest of both method bodies is unchanged.

A `WeakSet` is used rather than a set of partition strings so a session that Electron tears down does not keep an entry alive, and so the guard is about the object the handlers were actually installed on.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac
npm run build -w codey-mac
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-controller.ts codey-mac/electron/browser-controller.test.ts
git commit -m "fix(browser): bind permissions and downloads on each partition

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Read a profile's contents from its jar

`profileContents` and `profileSites` parse the JSON file. They must read the partition instead, because the jar is now the truth. Cookie and storage *values* still never leave the main process — the caller gets site names and counts.

`captureProfileData` gains a profile parameter so it reads the right jar, and only the open tabs that belong to that profile contribute localStorage.

**Files:**
- Modify: `codey-mac/electron/browser-controller.ts:1045-1078` (`profileContents`, `profileSites`), `:1253` (`captureProfileData`), `:1372` (`applyLocalStorage`)
- Test: `codey-mac/electron/browser-controller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
  it('reads a profile\'s sites from its own jar, not from a file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-jarread-'))
    try {
      const jars: Record<string, any[]> = {
        'persist:codey-profile-work': [
          { name: 'sid', value: 'w', domain: 'github.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
        ],
        'persist:codey-profile-personal': [
          { name: 'sid', value: 'p', domain: 'github.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
          { name: 'x', value: 'y', domain: 'news.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax' },
        ],
      }
      const controller = new BrowserController(
        () => null,
        vi.fn(),
        vi.fn(),
        undefined,
        (partition: string) => ({
          cookies: {
            get: vi.fn(async () => jars[partition] ?? []),
            set: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
          },
          clearStorageData: vi.fn(async () => {}),
        }) as any,
        { getProfilesDir: () => dir },
      )
      new BrowserProfileStore(dir).write('work', { cookies: [], origins: [] }, null)
      new BrowserProfileStore(dir).write('personal', { cookies: [], origins: [] }, null)

      await expect(controller.profileSites('work')).resolves.toEqual(['github.com'])
      await expect(controller.profileSites('personal')).resolves.toEqual(
        expect.arrayContaining(['github.com', 'news.example.com']),
      )
      const contents = await controller.profileContents('work')
      expect(contents.sites.map(site => site.domain)).toEqual(['github.com'])
      // Values never come back.
      expect(JSON.stringify(contents)).not.toContain('"w"')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

Note both methods become `async` — the jar is read asynchronously. Existing callers must be updated to `await`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac -t 'own jar, not from a file'
```

Expected: FAIL — `profileSites` returns `[]` synchronously (the JSON file has no cookies), so the `resolves` assertion fails.

- [ ] **Step 3: Implement**

Add a private reader next to `captureProfileData`:

```typescript
  /** Everything a profile's jar holds, in the portable profile shape. Used by
   *  export, by the contents disclosure, and by the Chrome-sync site list. */
  private async readJar(profileName: string | null): Promise<BrowserProfileData> {
    return this.captureProfileData(profileName)
  }
```

Change `captureProfileData` (`:1253`) to take the profile and use its jar and its tabs:

```typescript
  private async captureProfileData(profileName: string | null): Promise<BrowserProfileData> {
    let cookies: BrowserProfileCookie[] = []
    try {
      const found = await this.sessionFor(profileName).cookies.get({})
      // ... existing mapping, unchanged ...
    } catch {
      // Cookies unavailable (session torn down) - save what is reachable.
    }

    const origins = new Map<string, BrowserProfileStorageOrigin>()
    for (const tab of this.tabs) {
      if (tab.profile !== profileName) continue
      // ... existing per-tab localStorage read, unchanged ...
    }
    return { cookies, origins: Array.from(origins.values()) }
  }
```

Rewrite `profileContents` (`:1048`):

```typescript
  /** What a profile's jar actually holds, site by site, so it can be looked at
   *  before it is trusted. Values are left behind on purpose - the caller wants
   *  to know which logins are in there, not what they are. */
  async profileContents(name: string): Promise<{
    name: string
    updatedAt: number
    sourceUrl: string | null
    sites: BrowserProfileSiteSummary[]
  }> {
    assertProfileName(name)
    const meta = this.profiles().read(name)
    const data = await this.readJar(name)
    return {
      name,
      updatedAt: meta.updatedAt,
      sourceUrl: meta.sourceUrl,
      sites: summarizeProfileSites({ ...data, name, createdAt: meta.createdAt, updatedAt: meta.updatedAt, sourceUrl: meta.sourceUrl }),
    }
  }
```

Rewrite `profileSites` (`:1068`):

```typescript
  /** The domains a profile's jar holds logins for. Storage origins count too:
   *  a SPA that keeps its token in localStorage may have no cookie at all. */
  async profileSites(name: string): Promise<string[]> {
    assertProfileName(name)
    const data = await this.readJar(name)
    const seen = new Set<string>()
    for (const cookie of data.cookies) {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase()
      if (domain) seen.add(domain)
    }
    for (const origin of data.origins) {
      try {
        seen.add(new URL(origin.origin).hostname.toLowerCase())
      } catch { /* an unparseable origin has no host to refresh */ }
    }
    return [...seen]
  }
```

`applyLocalStorage` (`:1372`) takes the profile so it reuses a tab in the right jar and opens its hidden view on the right partition:

```typescript
  private async applyLocalStorage(
    profileName: string | null,
    origin: string,
    items: Array<{ name: string; value: string }>,
  ): Promise<void> {
    if (items.length === 0) return
    const open = this.tabs.find(tab => {
      if (tab.profile !== profileName) return false
      try { return new URL(tab.view.webContents.getURL()).origin === origin } catch { return false }
    })
    // ... existing "use the open tab" branch, unchanged ...
    const view = this.createHiddenView?.(profilePartition(profileName))
    // ... rest unchanged ...
  }
```

Update its caller in `applyProfileData` to pass the profile through — Task 6 rewrites that method, so for now thread the same `profileName` it is being given.

Update the callers of `profileContents` / `profileSites` to await:
- `main.ts:2448` — the `browser:profiles:contents` IPC handler. `browserCall` already accepts an async function, so change `() => browserController.profileContents(...)` to `async () => browserController.profileContents(...)` (or leave as-is: returning a promise from the callback works, but make it explicit).
- `main.ts:2454` — `const sites = await browserController.profileSites(requested)`.
- `main.ts:2499` — the auto-sync owner filter. It becomes async:

```typescript
    const targets = new Map<string, Set<string>>()
    for (const domain of changed) {
      const owners: string[] = []
      for (const name of autoSyncProfileNames()) {
        try {
          if ((await browserController.profileSites(name)).some(site => domainsTouch(site, domain))) owners.push(name)
        } catch { /* an unreadable profile does not own anything */ }
      }
      // ... existing owners.length !== 1 handling, unchanged ...
    }
```

- `main.ts:2542` — the `watchDomains` hook is synchronous by contract (`() => string[] | null`). Cache the last computed list: add `let watchDomainCache: string[] = []`, refresh it inside `runAutoSync` and after every profile write, and have the hook return the cache. Concretely, add next to `autoSyncProfileNames`:

```typescript
  let watchDomainCache: string[] = []
  const refreshWatchDomains = async () => {
    const syncing = autoSyncProfileNames()
    const domains = new Set<string>()
    for (const name of syncing) {
      try { for (const site of await browserController.profileSites(name)) domains.add(site) }
      catch { /* an unreadable profile just is not watched */ }
    }
    watchDomainCache = [...domains]
  }
```

and change the hook to:

```typescript
    watchDomains: () => (autoSyncProfileNames().length === 0 ? null : watchDomainCache),
```

Call `void refreshWatchDomains()` once at startup (right after `chromeCompanion?.setAutoSync({...})`) and at the end of `runAutoSync`'s `try` block.

- `browser-agent-bridge.ts` — `profilesForUrl` still reads files and is retired in Task 6; leave it for now.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --root codey-mac
npm run build -w codey-mac
```

Expected: PASS. Tests that asserted `profileSites` synchronously need `await`.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-controller.ts codey-mac/electron/browser-controller.test.ts codey-mac/electron/main.ts
git commit -m "feat(browser): read a profile's contents from its own jar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Import, export and sync write into the jar

Three boundaries move JSON in and out of a partition, and each is a one-directional write. There is nothing to merge into, because the partition holds that profile and only that profile.

**Files:**
- Modify: `codey-mac/electron/browser-controller.ts:961-995` (`saveProfile`, `importProfile`), `:1082-1100` (`resyncProfileSites`), `:1239-1248` (`exportProfile`), `:1319-1365` (`applyProfileData`)
- Test: `codey-mac/electron/browser-controller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
  it('imports into the named jar and leaves the other jars alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-import-'))
    try {
      const writes: Record<string, any[]> = {}
      const controller = new BrowserController(
        () => null,
        vi.fn(),
        vi.fn(),
        undefined,
        (partition: string) => ({
          cookies: {
            get: vi.fn(async () => []),
            set: vi.fn(async (cookie: any) => { (writes[partition] ??= []).push(cookie) }),
            remove: vi.fn(async () => {}),
          },
          clearStorageData: vi.fn(async () => {}),
        }) as any,
        { getProfilesDir: () => dir },
      )
      await controller.importProfile('work', {
        json: JSON.stringify({
          cookies: [{
            name: 'sid', value: 'w', domain: 'github.com', path: '/', expires: -1,
            httpOnly: true, secure: true, sameSite: 'lax',
          }],
          origins: [],
        }),
      })
      expect(writes['persist:codey-profile-work'].map(cookie => cookie.value)).toEqual(['w'])
      expect(writes['persist:codey-profile-personal']).toBeUndefined()
      expect(writes['persist:codey-browser']).toBeUndefined()
      // The metadata record exists, but carries no cookies.
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'work.json'), 'utf8'))
      expect(stored.cookies).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac -t 'imports into the named jar'
```

Expected: FAIL — nothing is written to `persist:codey-profile-work`; `importProfile` writes a file and applies to the shared jar.

- [ ] **Step 3: Implement**

`applyProfileData` (`:1319`) takes a profile name and writes into its jar. Rename it to `writeJar` to say what it now does:

```typescript
  /** Replace a profile's jar with this data: cookies wholesale, then
   *  per-origin localStorage. Replacing rather than merging is what makes an
   *  import an import - leftovers from what the jar held cannot survive it. */
  private async writeJar(profileName: string | null, data: BrowserProfileData): Promise<void> {
    const browserSession = this.sessionFor(profileName)
    let existing: Electron.Cookie[] = []
    try {
      existing = await browserSession.cookies.get({})
    } catch {
      // Session unavailable - nothing to replace.
    }
    for (const cookie of existing) {
      const domain = cookie.domain || ''
      if (!domain) continue
      const url = `https://${domain.replace(/^\./, '')}${cookie.path || '/'}`
      try { await browserSession.cookies.remove(url, cookie.name) } catch { /* best-effort */ }
    }
    try {
      await browserSession.clearStorageData({ storages: ['localstorage'] })
    } catch { /* session unavailable - cookies were the load-bearing part */ }
    for (const cookie of data.cookies) {
      try {
        const url = `https://${cookie.domain}${cookie.path || '/'}`
        await browserSession.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
          path: cookie.path || '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
          ...(cookie.sameSite !== 'unspecified' ? { sameSite: cookie.sameSite } : {}),
        })
      } catch {
        // One cookie failing must not abort the whole import.
      }
    }
    for (const origin of data.origins) {
      await this.applyLocalStorage(profileName, origin.origin, origin.localStorage)
    }
  }
```

`importProfile` (`:979`) writes the jar and a metadata record. `activate` no longer means "switch the whole browser" — it means "make this the profile new tabs open under":

```typescript
  /** Import a session snapshot from a file path or raw JSON (our profile
   *  format or a Playwright storageState) into a profile's jar. Making it the
   *  default for new tabs is the usual next step, so it is the default. */
  async importProfile(
    name: string,
    source: { path: string } | { json: string },
    makeDefault = true,
    sourceUrl: string | null = null,
  ): Promise<BrowserProfileSummary> {
    assertProfileName(name)
    const data = 'path' in source
      ? readProfileJson(source.path)
      : parseProfileJsonText(source.json)
    this.profiles().writeMeta(name, sourceUrl)
    await this.writeJar(name, data)
    if (makeDefault) this.profiles().setActive(name)
    return this.summaryOf(name)
  }
```

`saveProfile` (`:961`) snapshots the *current tab's* jar into a new profile, and the multi-profile guard it carried is gone because nothing is merged any more:

```typescript
  /** Snapshot the current tab's jar into a named profile. Used to turn "I am
   *  signed in right now" into a profile that can be reopened later. */
  async saveProfile(name: string): Promise<BrowserProfileSummary> {
    assertProfileName(name)
    const current = this.tabs.find(tab => tab.view === this.view)?.profile ?? null
    const data = await this.captureProfileData(current)
    const sourceUrl = this.view?.webContents.getURL() || null
    this.profiles().writeMeta(name, sourceUrl)
    await this.writeJar(name, data)
    return this.summaryOf(name)
  }
```

`exportProfile` (`:1241`) reads the jar:

```typescript
  /** Write a profile's jar to an arbitrary path, so a session can be handed to
   *  another machine (or another profile-enabled tool). */
  async exportProfile(name: string, targetPath: string): Promise<{ path: string }> {
    const meta = this.profiles().read(name)
    const data = await this.readJar(name)
    const file = path.resolve(String(targetPath))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = { ...data, name, createdAt: meta.createdAt, updatedAt: meta.updatedAt, sourceUrl: meta.sourceUrl }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
    return { path: file }
  }
```

`resyncProfileSites` (`:1082`) becomes a per-site write into the jar, with no merge and no conflict check:

```typescript
  /** Refresh some of a profile's sites from a fresh export. Only the cookies
   *  and origins the export covers are replaced; the jar's other sites are
   *  left alone, so a single-site refresh cannot drop an unrelated login. */
  async resyncProfileSites(
    name: string,
    source: { json: string },
    sites: readonly string[],
  ): Promise<BrowserProfileSummary> {
    assertProfileName(name)
    const incoming = parseProfileJsonText(source.json)
    const browserSession = this.sessionFor(name)
    const covered = sites.map(site => site.replace(/^\./, '').toLowerCase()).filter(Boolean)
    let existing: Electron.Cookie[] = []
    try { existing = await browserSession.cookies.get({}) } catch { /* nothing to clear */ }
    for (const cookie of existing) {
      const domain = (cookie.domain || '').replace(/^\./, '').toLowerCase()
      if (!domain || !covered.some(site => siteCoversHost(site, domain))) continue
      const url = `https://${domain}${cookie.path || '/'}`
      try { await browserSession.cookies.remove(url, cookie.name) } catch { /* best-effort */ }
    }
    for (const cookie of incoming.cookies) {
      try {
        await browserSession.cookies.set({
          url: `https://${cookie.domain}${cookie.path || '/'}`,
          name: cookie.name,
          value: cookie.value,
          ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
          path: cookie.path || '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
          ...(cookie.sameSite !== 'unspecified' ? { sameSite: cookie.sameSite } : {}),
        })
      } catch { /* one cookie failing must not abort the refresh */ }
    }
    for (const origin of incoming.origins) {
      await this.applyLocalStorage(name, origin.origin, origin.localStorage)
    }
    this.profiles().touch(name)
    return this.summaryOf(name)
  }
```

`siteCoversHost` is already exported from `browser-profiles.ts:308`; add it to the import list.

`assertRefreshFitsEnabledSet` (`:1024`) is deleted — it exists only to prevent a clash that isolation makes impossible.

`profilesForUrl` (`:1000`) reads every jar instead of every file:

```typescript
  /** Profiles that already hold a cookie scoped to `url` - the profiles a
   *  handoff of that page would be refreshing rather than creating. */
  async profilesForUrl(url: string): Promise<string[]> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return []
    }
    const names: string[] = []
    for (const summary of this.profiles().list()) {
      try {
        const data = await this.readJar(summary.name)
        if (data.cookies.some(cookie => cookieMatchesUrl(cookie, parsed))) names.push(summary.name)
      } catch { /* an unreadable jar is simply not offered */ }
    }
    return names
  }
```

Update its caller in `browser-agent-bridge.ts` to `await`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --root codey-mac
npm run build -w codey-mac
```

Expected: PASS. Existing profile tests that asserted a merge (`mergeProfileSites` behaviour through `resyncProfileSites`, the "refuses a refresh that would clash" test, the "refuses to enable two profiles" test) now assert the wrong thing — delete them; Task 8 replaces them with isolation tests.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-controller.ts codey-mac/electron/browser-controller.test.ts codey-mac/electron/browser-agent-bridge.ts
git commit -m "feat(browser): move import, export and sync into per-profile jars

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Metadata-only profile records, and migration

A profile file stops holding cookies. It keeps name, avatar, `autoSync`, `createdAt`, `updatedAt`, `sourceUrl`, plus a `schema` marker that tells the migration it has already run.

**Files:**
- Modify: `codey-mac/electron/browser-profiles.ts:385-545` (`BrowserProfileStore`)
- Test: `codey-mac/electron/browser-profiles.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('BrowserProfileStore metadata records', () => {
  it('writes metadata without cookies and marks the schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-store-meta-'))
    try {
      const store = new BrowserProfileStore(dir)
      store.writeMeta('work', 'https://github.com/')
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'work.json'), 'utf8'))
      expect(raw.schema).toBe(2)
      expect(raw.cookies).toBeUndefined()
      expect(raw.origins).toBeUndefined()
      expect(raw.sourceUrl).toBe('https://github.com/')
      expect(store.read('work').name).toBe('work')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a pre-upgrade file as needing migration, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-store-migrate-'))
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({
        name: 'work',
        cookies: [{
          name: 'sid', value: 'w', domain: 'github.com', path: '/', expires: -1,
          httpOnly: true, secure: true, sameSite: 'lax',
        }],
        origins: [],
        createdAt: 1,
        updatedAt: 2,
        sourceUrl: null,
      }))
      const store = new BrowserProfileStore(dir)
      const pending = store.pendingMigrations()
      expect(pending.map(entry => entry.name)).toEqual(['work'])
      expect(pending[0].data.cookies.map(cookie => cookie.value)).toEqual(['w'])

      store.markMigrated('work')
      expect(store.pendingMigrations()).toEqual([])
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'work.json'), 'utf8'))
      expect(raw.cookies).toBeUndefined()
      expect(raw.createdAt).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the touch timestamp moving without touching other metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-store-touch-'))
    try {
      const store = new BrowserProfileStore(dir)
      store.writeMeta('work', null)
      store.setAutoSync('work', true)
      const before = store.read('work').updatedAt
      store.touch('work', before + 1000)
      const after = store.read('work')
      expect(after.updatedAt).toBe(before + 1000)
      expect(after.autoSync).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-profiles.test.ts --root codey-mac
```

Expected: FAIL — `store.writeMeta is not a function`.

- [ ] **Step 3: Implement**

In `browser-profiles.ts`, add a schema constant near `ACTIVE_PROFILE_FILE`:

```typescript
/** Bumped when a profile file's shape changes. Schema 1 carried the session
 *  itself; schema 2 carries metadata only, because the partition holds the
 *  session now. A file with no marker is schema 1 and needs migrating. */
export const PROFILE_SCHEMA = 2
```

Add a metadata type next to `BrowserProfile`:

```typescript
/** A profile record on disk: everything about a profile except its session,
 *  which lives in the profile's partition. */
export interface BrowserProfileMeta {
  name: string
  avatar?: string | null
  autoSync?: boolean
  createdAt: number
  updatedAt: number
  sourceUrl: string | null
}
```

Inside `BrowserProfileStore`, add:

```typescript
  /** Write (or update) a profile's metadata record. Keeps createdAt, the
   *  avatar and the Chrome-sync switch when the profile already exists. */
  writeMeta(name: string, sourceUrl: string | null, now = Date.now()): BrowserProfileMeta {
    assertProfileName(name)
    let existing: BrowserProfileMeta | null = null
    try { existing = this.read(name) } catch { /* new profile */ }
    const meta: BrowserProfileMeta & { schema: number } = {
      schema: PROFILE_SCHEMA,
      name,
      avatar: existing?.avatar ?? null,
      autoSync: existing?.autoSync === true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sourceUrl: sourceUrl ?? existing?.sourceUrl ?? null,
    }
    this.writeRecord(name, meta)
    return meta
  }

  /** Move a profile's updatedAt without changing anything else - what a
   *  refresh of its jar reports back to the UI. */
  touch(name: string, now = Date.now()): BrowserProfileMeta {
    const meta = this.read(name)
    const next = { ...meta, schema: PROFILE_SCHEMA, updatedAt: now }
    this.writeRecord(name, next)
    return next
  }

  /** Profiles still holding a schema-1 session, with the session to replay
   *  into their partition. Empty once every profile has been migrated. */
  pendingMigrations(): Array<{ name: string; data: BrowserProfileData }> {
    const pending: Array<{ name: string; data: BrowserProfileData }> = []
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dir)
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -'.json'.length))
    } catch {
      return []
    }
    for (const name of names.sort()) {
      let record: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
        if (typeof parsed !== 'object' || parsed === null) continue
        record = parsed as Record<string, unknown>
      } catch {
        continue
      }
      if (record.schema === PROFILE_SCHEMA) continue
      pending.push({ name, data: parseProfileData(record) })
    }
    return pending
  }

  /** Rewrite a migrated profile as a metadata-only record, dropping the
   *  session it used to carry. Called only after the session has been written
   *  into the partition, so a crash in between simply migrates again. */
  markMigrated(name: string): void {
    assertProfileName(name)
    const meta = this.read(name)
    this.writeRecord(name, { ...meta, schema: PROFILE_SCHEMA })
  }

  private writeRecord(name: string, record: object): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const file = this.file(name)
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
  }
```

Change `read` to return `BrowserProfileMeta` and stop parsing session data:

```typescript
  read(name: string): BrowserProfileMeta {
    assertProfileName(name)
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
    } catch (error) {
      throw new Error(`Profile ${name} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`Profile ${name} is corrupt`)
    const record = parsed as Record<string, unknown>
    return {
      name,
      avatar: typeof record.avatar === 'string' && (BROWSER_PROFILE_AVATARS as readonly string[]).includes(record.avatar)
        ? record.avatar
        : null,
      autoSync: record.autoSync === true,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : null,
    }
  }
```

Delete `write(name, data, sourceUrl, now)` — `writeMeta` replaces it. Rewrite `setAvatar` and `setAutoSync` to go through `writeRecord` with the schema marker:

```typescript
  setAvatar(name: string, avatar: string): BrowserProfileSummary {
    assertProfileName(name)
    assertProfileAvatar(avatar)
    const meta = this.read(name)
    this.writeRecord(name, { ...meta, schema: PROFILE_SCHEMA, avatar })
    return this.summary(name, this.activeNames())
  }

  setAutoSync(name: string, enabled: boolean): BrowserProfileSummary {
    assertProfileName(name)
    const meta = this.read(name)
    this.writeRecord(name, { ...meta, schema: PROFILE_SCHEMA, autoSync: enabled === true })
    return this.summary(name, this.activeNames())
  }
```

`summary` can no longer count cookies from the file. `cookieCount` and `originCount` stay on `BrowserProfileSummary` (the UI shows them) but are filled by the controller, which can read the jar. In the store, set them to `0`:

```typescript
  private summary(name: string, activeNames: readonly string[]): BrowserProfileSummary {
    let meta: BrowserProfileMeta | null = null
    try { meta = this.read(name) } catch { /* a half-written file still shows up */ }
    return {
      name,
      avatar: meta?.avatar ?? null,
      autoSync: meta?.autoSync === true,
      createdAt: meta?.createdAt ?? 0,
      updatedAt: meta?.updatedAt ?? 0,
      cookieCount: 0,
      originCount: 0,
      active: activeNames.includes(name),
      sourceUrl: meta?.sourceUrl ?? null,
    }
  }
```

Add the controller-side counts. In `browser-controller.ts`, add:

```typescript
  /** A profile summary with the counts its jar actually holds. The store
   *  cannot fill these in - it no longer sees the session. */
  private async summaryOf(name: string): Promise<BrowserProfileSummary> {
    const base = this.profiles().list().find(entry => entry.name === name)
    if (!base) throw new Error(`Profile ${name} is missing on disk`)
    try {
      const data = await this.readJar(name)
      return { ...base, cookieCount: data.cookies.length, originCount: data.origins.length }
    } catch {
      return base
    }
  }

  /** Every saved profile, with the counts each jar holds. */
  async listProfiles(): Promise<BrowserProfileSummary[]> {
    const summaries = this.profiles().list()
    const filled: BrowserProfileSummary[] = []
    for (const summary of summaries) {
      try {
        const data = await this.readJar(summary.name)
        filled.push({ ...summary, cookieCount: data.cookies.length, originCount: data.origins.length })
      } catch {
        filled.push(summary)
      }
    }
    return filled
  }
```

The existing synchronous `listProfiles` (`browser-controller.ts:944`) is replaced by this async one; update its callers in `main.ts` (`:2244`, `:2461`, `:2473`) and `browser-agent-bridge.ts` (`:411`) to `await`.

Add the migration entry point:

```typescript
  /** Replay any pre-upgrade profile file into its own partition, then rewrite
   *  the file as metadata only. Runs once per profile; a crash halfway simply
   *  migrates that profile again on the next start. */
  async migrateProfilesToPartitions(): Promise<{ migrated: string[] }> {
    const migrated: string[] = []
    for (const entry of this.profiles().pendingMigrations()) {
      try {
        await this.writeJar(entry.name, entry.data)
        this.profiles().markMigrated(entry.name)
        migrated.push(entry.name)
      } catch {
        // Leave the file as schema 1 so the next start tries again.
      }
    }
    return { migrated }
  }
```

Call it from `main.ts` right after `browserController.setSitePermissionManager(browserSitePermissions)` (`main.ts:2046`):

```typescript
  try {
    const { migrated } = await browserController.migrateProfilesToPartitions()
    if (migrated.length > 0) {
      console.log(`[browser] moved ${migrated.length} profile(s) into their own partitions: ${migrated.join(', ')}`)
    }
  } catch (error) {
    console.warn(`[browser] profile migration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --root codey-mac
npm run build -w codey-mac
```

Expected: PASS. Store tests that called `store.write(name, data, sourceUrl)` must switch to `store.writeMeta(name, sourceUrl)`; those that asserted cookies came back from `read` should assert against the jar via the controller instead.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-profiles.ts codey-mac/electron/browser-profiles.test.ts codey-mac/electron/browser-controller.ts codey-mac/electron/browser-controller.test.ts codey-mac/electron/main.ts
git commit -m "feat(browser): store profile metadata only and migrate sessions into partitions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Retire the merge machinery

Nothing merges profiles any more, so the code that made merging safe is dead weight. This is the task that pays for the whole change.

**Files:**
- Modify: `codey-mac/electron/browser-controller.ts:1102-1186` (enable/disable/activate, `setEnabledProfiles`, `applyLiveProfiles`), `:1231-1237` (`deleteProfile`)
- Modify: `codey-mac/electron/browser-profiles.ts` — delete `profileConflict`, `conflictingCookie`, `conflictingStorageKey`, `mergeProfileSites`
- Modify: `codey-mac/electron/preload.ts`, `codey-mac/electron/main.ts` IPC handlers
- Test: `codey-mac/electron/browser-controller.test.ts`, `codey-mac/electron/browser-profiles.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the deleted conflict tests with the isolation guarantee they were standing in for:

```typescript
  it('lets two profiles hold different cookies for the same site', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-isolation-'))
    try {
      const jars: Record<string, any[]> = {}
      const controller = new BrowserController(
        () => null,
        vi.fn(),
        vi.fn(),
        undefined,
        (partition: string) => ({
          cookies: {
            get: vi.fn(async () => jars[partition] ?? []),
            set: vi.fn(async (cookie: any) => {
              jars[partition] = [...(jars[partition] ?? []).filter((entry: any) => entry.name !== cookie.name), {
                name: cookie.name, value: cookie.value, domain: cookie.domain ?? 'github.com',
                path: '/', secure: true, httpOnly: true, sameSite: 'lax',
              }]
            }),
            remove: vi.fn(async () => {}),
          },
          clearStorageData: vi.fn(async () => {}),
        }) as any,
        { getProfilesDir: () => dir },
      )
      const snapshot = (value: string) => JSON.stringify({
        cookies: [{
          name: 'session', value, domain: 'github.com', path: '/', expires: -1,
          httpOnly: true, secure: true, sameSite: 'lax',
        }],
        origins: [],
      })
      await controller.importProfile('work', { json: snapshot('work-token') })
      await controller.importProfile('personal', { json: snapshot('personal-token') })

      expect(jars['persist:codey-profile-work'].map(cookie => cookie.value)).toEqual(['work-token'])
      expect(jars['persist:codey-profile-personal'].map(cookie => cookie.value)).toEqual(['personal-token'])
      expect(await controller.profileSites('work')).toEqual(['github.com'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sets which profile new tabs open under, without touching open tabs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-default-'))
    try {
      const { controller, cookiesSet } = makeFixture(dir)
      new BrowserProfileStore(dir).writeMeta('work', null)
      cookiesSet.mockClear()
      await controller.setDefaultProfile('work')
      expect(controller.activeProfileName()).toBe('work')
      // Nothing was replayed into any jar: existing tabs keep their identity.
      expect(cookiesSet).not.toHaveBeenCalled()
      await controller.setDefaultProfile(null)
      expect(controller.activeProfileName()).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac -t 'without touching open tabs'
```

Expected: FAIL — `controller.setDefaultProfile is not a function`.

- [ ] **Step 3: Implement**

Delete from `browser-controller.ts`: `activateProfile` (`:1111`), `enableProfile` (`:1130`), `disableProfile` (`:1157`), `setEnabledProfiles` (`:1183`), `applyLiveProfiles` (`:1191`), `activeProfileNames` (`:1103`).

Add in their place:

```typescript
  /** Which profile new tabs open under. Nothing is replayed and no open tab
   *  changes identity - a tab keeps the jar it was created on for life. */
  async setDefaultProfile(name: string | null): Promise<BrowserProfileSummary | null> {
    if (name === null) {
      this.profiles().setActive(null)
      return null
    }
    assertProfileName(name)
    this.profiles().read(name)
    this.profiles().setActive(name)
    return this.summaryOf(name)
  }
```

`deleteProfile` (`:1231`) clears the profile's jar and forgets it as the default:

```typescript
  /** Remove a profile: its metadata record and its whole storage jar. Tabs
   *  still open on that jar keep working until they are closed; the storage
   *  behind them is gone, so they are signed out on the next load. */
  async deleteProfile(name: string): Promise<{ deleted: boolean }> {
    assertProfileName(name)
    try {
      await this.sessionFor(name).clearStorageData()
    } catch {
      // A jar that will not clear must not block removing the profile.
    }
    this.profiles().remove(name)
    if (this.profiles().active() === name) this.profiles().setActive(null)
    return { deleted: true }
  }
```

Delete from `browser-profiles.ts`: `profileConflict`, `conflictingCookie`, `conflictingStorageKey`, `mergeProfileSites`, and their imports in `browser-controller.ts`. Delete the tests for them in `browser-profiles.test.ts` (`describe('conflictingStorageKey / profileConflict')` and `describe('siteCoversHost / mergeProfileSites')` — keep the `siteCoversHost` cases, which `resyncProfileSites` still uses).

`activeNames`/`active`/`setActive` in the store keep working as-is; `setActive` is now only ever called with one name or `null`. Narrow its signature to say so:

```typescript
  setActive(name: string | null): void {
    if (name === null) {
      try { fs.unlinkSync(this.activeFile()) } catch { /* already absent */ }
      return
    }
    assertProfileName(name)
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.activeFile(), `${name}\n`, { encoding: 'utf8', mode: 0o600 })
  }
```

Keep `activeNames()` — it still reads the multi-line legacy file correctly, and `active()` is defined in terms of it.

Update the IPC surface. In `main.ts`, replace the three handlers `browser:profiles:activate`, `browser:profiles:enable`, `browser:profiles:disable` with one:

```typescript
  ipcMain.handle('browser:profiles:setDefault', (event, name: string | null) =>
    browserCall(event, () => browserController.setDefaultProfile(name === null ? null : String(name || ''))))
```

In `preload.ts`, replace the matching `activate` / `enable` / `disable` entries with:

```typescript
      setDefault: (name: string | null) => ipcRenderer.invoke('browser:profiles:setDefault', name),
```

Update `codey-mac/src/codey-api.d.ts` to match.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --root codey-mac
npm run build -w codey-mac
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron codey-mac/src/codey-api.d.ts
git commit -m "refactor(browser): drop the profile merge machinery

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The agent bridge opens a tab in the named jar

`--profile <name>` currently forces a whole-browser identity switch behind the `activate-profile` approval. With isolation it opens a tab on that profile's partition — nothing else is disturbed, so nothing needs approving.

**Files:**
- Modify: `codey-mac/electron/browser-agent-bridge.ts:83-85`, `:150-180`, `:410-455`, `:468-495`
- Test: `codey-mac/electron/browser-agent-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `browser-agent-bridge.test.ts`:

```typescript
  it('opens a profiled request in that profile without an approval', async () => {
    const opened: Array<[string, string | null]> = []
    const controller = {
      getState: () => ({ url: 'https://example.com/', title: 'Example', loading: false, canGoBack: false, canGoForward: false, error: null }),
      activeProfileName: () => null,
      listTabs: () => [],
      newTab: async (url: string, profile: string | null) => {
        opened.push([url, profile])
        return { url, title: '', loading: false, canGoBack: false, canGoForward: false, error: null }
      },
    }
    const { endpoint, token, approvals } = await startBridge(controller)
    const response = await fetch(`${endpoint}/newTab`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-codey-profile': 'work', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/' }),
    })
    expect(response.status).toBe(200)
    expect(opened).toEqual([['https://github.com/', 'work']])
    expect(approvals.map(entry => entry.command)).not.toContain('activate-profile')
  })
```

`startBridge` is the existing helper in that test file; reuse whatever it is called there and match its `approvals` capture. If it does not expose captured approvals, add that capture to the helper.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-agent-bridge.test.ts --root codey-mac -t 'without an approval'
```

Expected: FAIL — the bridge requests an `activate-profile` approval and calls `newTab` with one argument.

- [ ] **Step 3: Implement**

In `browser-agent-bridge.ts`, the `profileScope` `AsyncLocalStorage` keeps its role (carry the requested profile through one request) but stops driving an activation. Replace the block at `:161-176`:

```typescript
      const requestedProfile = typeof req.headers['x-codey-profile'] === 'string'
        ? (req.headers['x-codey-profile'] as string).trim()
        : ''
      if (requestedProfile) {
        // Naming a profile no longer switches the browser: the request's tab
        // simply opens on that profile's jar, which disturbs nothing else.
        this.profileScope.enterWith({ name: requestedProfile })
      }
```

Delete `profileIsExactly` (`:471`) and the `exclusive`-wrapper branch that called `activateProfile` (`:481-495`) — its only job was making the switch happen inside the turn.

`newTab` (`:258`) passes the scope through:

```typescript
          return await this.controller.newTab(url, this.profileScope.getStore()?.name ?? null)
```

`/profiles` (`:410`) returns the async list:

```typescript
      if (req.method === 'GET' && route === '/profiles') {
        json(res, 200, {
          active: this.controller.activeProfileName(),
          profiles: await this.controller.listProfiles(),
        })
        return
      }
```

`/profile/activate` (`:443`) becomes `/profile/default`, unapproved:

```typescript
      if (req.method === 'POST' && route === '/profile/default') {
        const body = await readJson(req)
        const name = body.name === null ? null : String(body.name || '')
        json(res, 200, await this.controller.setDefaultProfile(name))
        return
      }
```

Remove `'activate-profile'` from the command union and from `levelForCommand`. `delete-profile` keeps its approval — deleting a jar is destructive.

Update `packages/core/src/skills/browser/*` (the CLI the agent calls) so `--profile` sends the header and the `activate` subcommand becomes `default`. Find the call sites with:

```bash
grep -rn "profile/activate\|activate-profile" packages codey-mac --include='*.ts' --include='*.md' | grep -v node_modules
```

and update each hit.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --root codey-mac
npx vitest run -w @codey/core
npm run build -w codey-mac
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron packages/core/src/skills
git commit -m "feat(browser): let an agent open a tab in a profile without switching identity

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Load extensions into every partition

`BrowserExtensionManager` (`browser-extensions.ts:247`) takes one `ExtensionSession` in its constructor and stores a single `runtimeId` per extension. With several partitions, each extension is loaded once per session and gets a *different* runtime id in each, so `runtimeId: string | null` becomes a map keyed by session.

**Files:**
- Modify: `codey-mac/electron/browser-extensions.ts:247-260` (constructor), `:262-300` (`initialize`), `:445-460` (`load`, `unload`)
- Modify: `codey-mac/electron/main.ts:2048-2051`
- Modify: `codey-mac/electron/browser-controller.ts` (`BrowserControllerOptions`, `createTab`)
- Test: `codey-mac/electron/browser-extensions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `codey-mac/electron/browser-extensions.test.ts`:

```typescript
  it('loads every enabled extension into each session it is attached to', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ext-multi-'))
    try {
      const extensionDir = path.join(dir, 'ext')
      fs.mkdirSync(extensionDir, { recursive: true })
      fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Demo', version: '1.0.0',
      }))
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify([{ path: extensionDir, enabled: true }]))

      const makeSession = (id: string) => ({
        extensions: {
          loadExtension: vi.fn(async () => ({ id })),
          removeExtension: vi.fn(),
        },
      })
      const a = makeSession('id-a')
      const b = makeSession('id-b')
      const manager = new BrowserExtensionManager(path.join(dir, 'state.json'), [])
      await manager.initialize()

      await manager.attach(a as any)
      await manager.attach(b as any)
      expect(a.extensions.loadExtension).toHaveBeenCalledWith(extensionDir)
      expect(b.extensions.loadExtension).toHaveBeenCalledWith(extensionDir)

      // Attaching the same session twice must not load it twice.
      await manager.attach(a as any)
      expect(a.extensions.loadExtension).toHaveBeenCalledTimes(1)

      // Disabling unloads from every attached session, using each one's own id.
      await manager.setEnabled(manager.list()[0].key, false)
      expect(a.extensions.removeExtension).toHaveBeenCalledWith('id-a')
      expect(b.extensions.removeExtension).toHaveBeenCalledWith('id-b')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

Match `setEnabled`'s real name — check with `grep -n "async setEnabled\|setEnabled(" codey-mac/electron/browser-extensions.ts` and use whatever the class exposes for turning an extension off.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run electron/browser-extensions.test.ts --root codey-mac -t 'each session it is attached to'
```

Expected: FAIL — the constructor still takes a session first, and `attach` does not exist.

- [ ] **Step 3: Implement**

Drop the session from the constructor (`browser-extensions.ts:251`):

```typescript
  private readonly sessions: ExtensionSession[] = []

  constructor(
    private readonly stateFile: string,
    private readonly chromeRoots: string[] = defaultChromeRoots(),
  ) {
```

(The `managedRoot` computation in the body is unchanged.)

`BrowserExtensionEntry.runtimeId` changes from `string | null` to a per-session map. Because `ExtensionSession` is an object, use a `Map`:

```typescript
  /** Runtime ids, one per session the extension is loaded into. Each partition
   *  is its own Chromium profile, so the same extension gets a different id in
   *  each of them and has to be removed by the right one. */
  runtimeIds: Map<ExtensionSession, string>
```

Everywhere an entry is constructed (`initialize` at `:275` and `:288`, plus the import path), replace `runtimeId: null` with `runtimeIds: new Map()`.

`list()` must keep reporting a single boolean-ish value to the UI. Wherever it exposed `runtimeId`, expose `loaded: entry.runtimeIds.size > 0` instead, and update `codey-mac/src/codey-api.d.ts` and any renderer use of `runtimeId` to match — find them with `grep -rn "runtimeId" codey-mac | grep -v node_modules`.

`load` and `unload` (`:445`, `:459`) work on one session:

```typescript
  private async loadInto(entry: BrowserExtensionEntry, target: ExtensionSession): Promise<void> {
    try {
      const loaded = await target.extensions.loadExtension(entry.path)
      entry.runtimeIds.set(target, loaded.id)
      entry.error = null
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
    }
  }

  private unload(entry: BrowserExtensionEntry): void {
    for (const [target, runtimeId] of entry.runtimeIds) {
      try { target.extensions.removeExtension(runtimeId) } catch { /* already unloaded */ }
    }
    entry.runtimeIds.clear()
  }
```

Replace the old `private async load(entry)` calls: in `initialize` (`:285`) and anywhere else that loaded on enable, load into every attached session:

```typescript
  /** Load one extension into every session already attached. */
  private async loadEverywhere(entry: BrowserExtensionEntry): Promise<void> {
    for (const target of this.sessions) await this.loadInto(entry, target)
  }
```

`initialize` runs before any session is attached, so `loadEverywhere` there is a no-op that simply records the entries — the actual loading happens in `attach`. That is the point: extensions are now loaded when a partition opens, not when the app starts.

Add the public entry point:

```typescript
  /** Start serving one more session (one more profile's partition). Every
   *  enabled extension is loaded into it, and it is remembered so extensions
   *  enabled later reach it too. Attaching the same session twice is a no-op. */
  async attach(target: ExtensionSession): Promise<void> {
    if (this.sessions.includes(target)) return
    this.sessions.push(target)
    for (const entry of this.entries.values()) {
      if (entry.enabled) await this.loadInto(entry, target)
    }
  }
```

In `main.ts:2048`:

```typescript
  browserExtensionManager = new BrowserExtensionManager(
    join(app.getPath('userData'), 'browser-extensions.json'),
  )
```

Give the controller a hook so it attaches the manager the first time it opens a partition. Add to `BrowserControllerOptions` (`browser-controller.ts:95-105`):

```typescript
  /** Called with each partition's session the first time the browser opens a
   *  tab on it, so extensions and passkeys reach every profile's jar. */
  onSessionOpened?: (session: Session) => void
```

Store it in the constructor (`this.onSessionOpened = options.onSessionOpened`), declare the field next to `createHiddenView` (`:249`), and call it in `createTab` right after `bindDownloads`:

```typescript
    this.onSessionOpened?.(browserSession)
```

Task 11 supplies the `main.ts` side of that hook.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --root codey-mac
npm run build -w codey-mac
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron codey-mac/src/codey-api.d.ts
git commit -m "feat(browser): load extensions into every profile partition

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: WebAuthn per partition

`configureBrowserWebAuthn(app, browserSession, ...)` (`main.ts:2307`) is called once, on the shared session. Passkeys in any other profile would not work.

**Files:**
- Modify: `codey-mac/electron/main.ts:2307`

- [ ] **Step 1: Check the current signature**

```bash
grep -rn "export function configureBrowserWebAuthn" -A 12 codey-mac/electron
```

- [ ] **Step 2: Implement**

Move the call into the same `onSessionOpened` hook Task 10 added, so each partition is configured the first time it is used. In `main.ts`, replace the standalone call with a per-session one:

```typescript
  const configuredWebAuthn = new WeakSet<Electron.Session>()
  const onBrowserSessionOpened = (target: Electron.Session) => {
    void browserExtensionManager?.attach(target)
    if (configuredWebAuthn.has(target)) return
    configuredWebAuthn.add(target)
    configureBrowserWebAuthn(app, target, pickBrowserPasskey, error => {
      sendToRenderer('gateway-log', `[browser] passkey: ${error}`)
    })
  }
```

(Keep the exact error callback body that is there today; only the session argument and the guard are new.)

Pass `onSessionOpened: onBrowserSessionOpened` when the controller is constructed, and call `onBrowserSessionOpened(session.fromPartition(BROWSER_PARTITION, { cache: true }))` once at startup so the default jar is configured even before any tab exists.

- [ ] **Step 3: Verify**

```bash
npm run build -w codey-mac
npx vitest run --root codey-mac
```

Expected: build succeeds, tests PASS.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(browser): configure passkeys on each profile partition

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Renderer — show and pick a tab's profile

The tab strip labels a tab with its profile's avatar, the new-tab button lets the user pick which profile to open under, and the profiles panel drops the enable/disable toggles for a single "new tabs open in" choice.

**Files:**
- Modify: `codey-mac/src/components/BrowserPanel.tsx:689-745` (tab strip, new-tab button)
- Modify: `codey-mac/src/components/BrowserProfiles.tsx`
- Modify: `codey-mac/src/codey-api.d.ts:200-210`

- [ ] **Step 1: Update the renderer type**

In `codey-mac/src/codey-api.d.ts`, add `profile` to `BrowserTab`:

```typescript
export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
  profile: string | null
}
```

and replace the profile activation entries with:

```typescript
      setDefault: (name: string | null) => Promise<Result<BrowserProfileSummary | null>>
```

Also change `newTab` to accept a profile:

```typescript
    newTab: (url?: string, profile?: string | null) => Promise<Result<BrowserState>>
```

and update `preload.ts:502` to forward it:

```typescript
    newTab: (url?: string, profile?: string | null) => ipcRenderer.invoke('browser:newTab', url, profile),
```

plus the `browser:newTab` handler in `main.ts` to pass the second argument through to `browserController.newTab(url, profile)`.

- [ ] **Step 2: Show the profile on each tab**

In `BrowserPanel.tsx`, the tab strip renders `tabs.map(tab => ...)` at line 690. Inside each tab button, before the title, render the profile's avatar when the tab has one. The profile list is already fetched by `BrowserProfiles.tsx`; fetch it here too:

```tsx
  const [profiles, setProfiles] = useState<BrowserProfileSummary[]>([])
  useEffect(() => {
    void window.codey.browser.profiles.list().then(result => { if (result.ok) setProfiles(result.data) })
  }, [tabs.length])
  const avatarOf = (name: string | null) =>
    name === null ? null : (profiles.find(profile => profile.name === name)?.avatar ?? null)
```

and in the tab button:

```tsx
            {tab.profile && (
              <span style={styles.tabProfile} title={`Profile: ${tab.profile}`} aria-label={`Profile ${tab.profile}`}>
                {avatarOf(tab.profile) ?? tab.profile.slice(0, 1).toUpperCase()}
              </span>
            )}
```

with a style next to `newTabButton` (line 1079):

```typescript
  tabProfile: { flexShrink: 0, marginRight: 4, fontSize: 11, lineHeight: '11px', opacity: 0.9 },
```

- [ ] **Step 3: Let the new-tab button pick a profile**

Replace the new-tab button's `onClick` (line 741) so a plain click uses the default profile and an alt-click offers the list:

```tsx
          onClick={event => {
            if (!event.altKey || profiles.length === 0) {
              void showWebTab(() => window.codey.browser.newTab())
              return
            }
            setProfilePickerOpen(true)
          }}
```

and render a small menu when `profilePickerOpen` is set:

```tsx
      {profilePickerOpen && (
        <div style={styles.profilePicker} role="menu" aria-label="Open a new tab in a profile">
          <button
            style={styles.profilePickerItem}
            role="menuitem"
            onClick={() => { setProfilePickerOpen(false); void showWebTab(() => window.codey.browser.newTab()) }}
          >No profile</button>
          {profiles.map(profile => (
            <button
              key={profile.name}
              style={styles.profilePickerItem}
              role="menuitem"
              onClick={() => {
                setProfilePickerOpen(false)
                void showWebTab(() => window.codey.browser.newTab(undefined, profile.name))
              }}
            >{profile.avatar ?? ''} {profile.name}</button>
          ))}
        </div>
      )}
```

with:

```typescript
  const [profilePickerOpen, setProfilePickerOpen] = useState(false)
```

and styles:

```typescript
  profilePicker: { position: 'absolute', top: 34, right: 8, zIndex: 5, display: 'flex', flexDirection: 'column', minWidth: 160, padding: 4, borderRadius: 8, background: C.bg2, border: `1px solid ${C.border}`, boxShadow: '0 6px 20px rgba(0,0,0,0.35)' },
  profilePickerItem: { textAlign: 'left', padding: '6px 8px', border: 'none', borderRadius: 6, background: 'transparent', color: C.fg, cursor: 'pointer', fontSize: 12 },
```

Match `C.bg2` / `C.border` / `C.fg` to whatever the file's existing colour constants are called.

- [ ] **Step 4: Update the profiles panel**

In `BrowserProfiles.tsx`, replace the enable/disable/activate controls with a single "new tabs open in this profile" radio-style choice calling `window.codey.browser.profiles.setDefault(name)` (and `setDefault(null)` for none). Update the `bits` line at `:126` — `'syncs with Chrome'` stays; add `'new tabs open here'` when `profile.active`. Remove the two-syncing-profiles warning copy at `:316-317`, which describes a conflict that no longer exists:

```tsx
              <span style={styles.syncCopy}>
                Keep in sync with Chrome — when one of this profile’s logins changes there, it refreshes itself.
              </span>
```

- [ ] **Step 5: Verify**

```bash
npm run build -w codey-mac
npx vitest run --root codey-mac
npm run lint
```

Expected: build succeeds, tests PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src codey-mac/electron
git commit -m "feat(browser): show and pick a tab's profile

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Restart persistence and the full suite

The headline guarantee — a login made inside Codey's browser survives a restart with no import step — has no unit test yet, because it is about the partition surviving. Assert the thing the code controls: nothing replays over a jar at startup.

**Files:**
- Test: `codey-mac/electron/browser-controller.test.ts`

- [ ] **Step 1: Write the test**

```typescript
  it('never replays a jar at startup, so a login made in the browser survives', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-persist-'))
    try {
      const removed: string[] = []
      const controller = new BrowserController(
        () => null,
        vi.fn(),
        vi.fn(),
        undefined,
        (_partition: string) => ({
          cookies: {
            get: vi.fn(async () => []),
            set: vi.fn(async () => {}),
            remove: vi.fn(async (url: string, name: string) => { removed.push(`${url}|${name}`) }),
          },
          clearStorageData: vi.fn(async () => {}),
        }) as any,
        { getProfilesDir: () => dir },
      )
      new BrowserProfileStore(dir).writeMeta('work', null)
      // Startup does exactly one thing to jars: migrate schema-1 files. There
      // are none here, so no jar is touched.
      await expect(controller.migrateProfilesToPartitions()).resolves.toEqual({ migrated: [] })
      await controller.setDefaultProfile('work')
      expect(removed).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates a pre-upgrade profile into its own jar exactly once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-migrate-'))
    try {
      const written: Record<string, any[]> = {}
      const controller = new BrowserController(
        () => null,
        vi.fn(),
        vi.fn(),
        undefined,
        (partition: string) => ({
          cookies: {
            get: vi.fn(async () => []),
            set: vi.fn(async (cookie: any) => { (written[partition] ??= []).push(cookie) }),
            remove: vi.fn(async () => {}),
          },
          clearStorageData: vi.fn(async () => {}),
        }) as any,
        { getProfilesDir: () => dir },
      )
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({
        name: 'work',
        cookies: [{
          name: 'sid', value: 'legacy', domain: 'github.com', path: '/', expires: -1,
          httpOnly: true, secure: true, sameSite: 'lax',
        }],
        origins: [],
        createdAt: 111,
        updatedAt: 222,
        sourceUrl: null,
      }))

      await expect(controller.migrateProfilesToPartitions()).resolves.toEqual({ migrated: ['work'] })
      expect(written['persist:codey-profile-work'].map(cookie => cookie.value)).toEqual(['legacy'])

      // Second start: nothing left to do, and the file is metadata only.
      await expect(controller.migrateProfilesToPartitions()).resolves.toEqual({ migrated: [] })
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'work.json'), 'utf8'))
      expect(raw.cookies).toBeUndefined()
      expect(raw.createdAt).toBe(111)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run electron/browser-controller.test.ts --root codey-mac
```

Expected: PASS (the implementation for both landed in Tasks 7 and 8).

- [ ] **Step 3: Run everything**

```bash
npm test
npm run build -w codey-mac
npm run lint
```

Expected: all workspaces green, build succeeds, lint clean. Fix anything red before committing.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/browser-controller.test.ts
git commit -m "test(browser): cover jar persistence and one-shot migration

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Update the docs

`CLAUDE.md` does not mention browser profiles, but the browser skill does, and it is what an agent reads before using `--profile`.

**Files:**
- Modify: `packages/core/src/skills/browser/SKILL.md` (or wherever `grep -rn 'profile' packages/core/src/skills/browser` points)
- Modify: `docs/superpowers/specs/2026-08-18-browser-skill-design.md` — add a short "superseded for profiles" note pointing at the new spec

- [ ] **Step 1: Find every mention**

```bash
grep -rn "activate-profile\|profile/activate\|enable a profile\|profiles are enabled" packages docs codey-mac --include='*.md' | grep -v node_modules
```

- [ ] **Step 2: Rewrite the profile section of the browser skill**

Replace any text describing profile activation as a browser-wide identity switch with:

```markdown
Profiles are isolated. Each profile has its own cookie jar, so two profiles can
be signed into the same site at once. `--profile <name>` opens your tab in that
profile's jar; it does not change any other tab, and it needs no approval.
A login you make inside a profile stays in it — there is no save step.
```

- [ ] **Step 3: Note the superseded design**

At the top of `docs/superpowers/specs/2026-08-18-browser-skill-design.md`, under the title:

```markdown
> The profile model in this document (one shared jar, profiles merged into it,
> activation as an identity switch) was replaced by
> `2026-09-08-browser-profile-partitions-design.md`. Everything else still holds.
```

- [ ] **Step 4: Verify and commit**

```bash
npm run lint
git add packages/core/src/skills docs
git commit -m "docs(browser): describe isolated profiles

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done

At the end of Task 14:

- Every profile has its own partition; two profiles can hold different logins for the same site.
- A login made inside Codey's browser survives a restart with no import step.
- `--profile` opens a tab in a jar instead of switching the whole browser, and needs no approval.
- `applyLiveProfiles`, `profileConflict`, `conflictingCookie`, `conflictingStorageKey`, `mergeProfileSites` and `assertRefreshFitsEnabledSet` are gone.
- Old profile files were replayed into their partitions once and are metadata only.

**Real-machine smoke test still owed** — none of this has run in the packaged app:

1. Launch the Mac app, open Browser, confirm existing profiles survived migration (Settings → Profiles shows their sites).
2. Open two tabs in two profiles on the same site; confirm each shows a different account.
3. Sign in inside a profiled tab, quit the app, reopen — still signed in.
4. Trigger an OAuth popup from a profiled tab; confirm it completes in the same profile.
5. Confirm a browser extension is present in a profiled tab, not just the default one.

**Next spec:** Chrome auto-sync with an exclusion list and fresh localStorage, which was deliberately left out of this change.
