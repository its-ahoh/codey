# Browser multi-active — design

**Date:** 2026-09-10
**Branch:** `browser-active-profiles`
**Builds on:** `c5e723b` (#434 active-profile wording + drop export, #432 Chrome
binding, #429 per-profile partitions)

## Problem

"Active profile" does two unrelated jobs today, and the user's model splits
them apart:

1. **Which profiles mirror Chrome.** `autoSync` already exists per profile and
   #432 already routes each Chrome's changes to its own bound jar. But the UI
   also has a single "Active / Activate" radio (`setDefaultProfile`) that reads
   as "only one profile can be on at a time" — the exact thing the user asked
   to remove.
2. **Which profile a command runs against.** Every Codey-initiated Chrome
   command (`chrome tab` / `view` / `open` / `click`…) resolves through
   `targetResolver` → `activeProfileName()` — the *first* of the enabled list.
   So an agent that said `--profile personal` still gets routed to whatever the
   global "active" happens to be, not to `personal`.

The result is one radio pretending to be an identity switch, while `--profile`
only ever affected which jar a *new tab* opens in, never which Chrome a command
targets.

## Goal

Two concepts, fully separated:

- **Activation** = `autoSync`. A profile is "active" when it auto-syncs with
  Chrome. It is per-profile and many can be on at once.
- **Target** = decided at the moment a command runs: the agent's
  `--profile <name>`, else the browser tab currently on screen. No global
  "default/active" selection survives.

## Design

### 1. Delete the single "active/default" profile

The `.active` file and everything that treated it as one-of-N goes away.

- `browser-profiles.ts`: remove `activeFile()`, `activeNames()`, `active()`,
  `setActive()`, and the `active` field on `BrowserProfileSummary`.
- `browser-controller.ts`: remove `activeProfileName()` and
  `setDefaultProfile()`. `importProfile` drops its `makeDefault` parameter.
- `main.ts`: remove the `browser:profiles:setDefault` IPC handler and the
  `active` field from the profiles-list reply.
- The side-panel `handoffSession` and any other `importProfile(…, true, …)`
  callers drop the flag.

"Which profiles are enabled" is now simply "which profiles have `autoSync`
on", which the store already knows and #432 already drives per Chrome client.

### 2. Target = current tab, or `--profile`

**A new `currentTabProfile()` accessor** on `BrowserController` returns the
profile name of the tab currently on screen (`tabs.find(tab => tab.view ===
this.view)?.profile ?? null`). This is the manual-UI target: the toolbar's
Chrome commands and the `+` new-tab button act on the profile the user is
looking at.

**New-tab default follows the current tab.** `createTab` / `newTab` use
`currentTabProfile()` instead of the removed `activeProfileName()`, so a new
tab opened while viewing a `personal` tab opens in `personal`.

**`targetResolver`** (set in `main.ts`) resolves the current tab's profile to
its bound Chrome, exactly as today but from `currentTabProfile()` rather than
`activeProfileName()`. Named failures stay:

- no tab / tab has no profile → `Activate a browser profile first`
- profile not linked → `Profile "X" is not linked to a Chrome profile`
- linked Chrome not running → `Chrome profile "Y" (linked to "X") is not running`

### 3. Agent `--profile` routes Chrome commands

`browser-agent-bridge.ts` already captures `--profile` in `profileScope`. Today
it only steers `newTab`. It now also steers every Chrome companion call.

- Add `chromeTarget(): string | null` to the bridge: if `profileScope` holds a
  name, resolve `controller.chromeBindingForProfile(name)` and return its
  `profileId` (throw the "not linked" error when unbound). With no `--profile`
  it returns `null` so the companion's `targetResolver` falls back to the
  current tab.
- The companion routes pass that target explicitly:
  `companion.activeTab(this.chromeTarget())`, `snapshot(…)`, `navigate(…,
  target)`, `act(…, target)`.
- `getState().profile` and the `/profiles` reply report
  `controller.currentTabProfile()` instead of `activeProfileName()`.

`--profile` names a Codey profile; the binding (#432) is what maps it to the
Chrome that gets the command. No new mapping table is needed.

### 4. UI

- `BrowserProfiles.tsx`: remove the "No profile" radio and the per-profile
  "Active / Activate" radio. The existing `autoSync` toggle is the activation,
  so it moves out of the collapsed sync box to sit on the profile row (always
  visible), labelled "Sync with Chrome".
- `BrowserPanel.tsx`: the toolbar chip stops being a picker. It shows the
  current tab's profile (already available as `state.profile`); the "Active
  profile" menu goes away. The alt-click `+` picker stays — it explicitly
  chooses a profile for *that* tab.
- `browser/SKILL.md`: drop `profile default`, fold the notion of "the profile
  you are looking at / `--profile`" into the command semantics.

### 5. IPC surface

Removed: `browser:profiles:setDefault`.

The `chromeCompanion:*` command handlers keep working unchanged — their
resolution now goes through the current-tab `targetResolver`.

### 6. Testing

**`browser-profiles.test.ts`**
- the active-file store is gone: no `setActive`/`activeNames` assertions remain.

**`browser-controller.test.ts`**
- `newTab()` with no profile opens in the current tab's profile, not a global
  default.
- `currentTabProfile()` is null with no tab and matches the focused tab's
  profile with tabs open.

**`browser-agent-bridge.test.ts`**
- `--profile personal` resolves to `personal`'s bound Chrome and is passed to
  the companion call; an unbound profile throws the named error.
- no `--profile` falls through (companion resolves the current tab).
- `/profiles` and `getState().profile` report the current tab's profile.

**`chrome-companion.test.ts`** — unchanged; `targetResolver` already treats a
null result as "fall back".

### 7. Files touched

| File | Change |
| --- | --- |
| `codey-mac/electron/browser-profiles.ts` | remove active-file store + `active` field |
| `codey-mac/electron/browser-controller.ts` | `currentTabProfile()`, remove `activeProfileName`/`setDefaultProfile`, new-tab default, `importProfile` flag |
| `codey-mac/electron/browser-agent-bridge.ts` | `chromeTarget()`, route Chrome calls, report current-tab profile |
| `codey-mac/electron/main.ts` | `targetResolver` from current tab, drop `setDefault` IPC, drop `active` in list |
| `codey-mac/electron/preload.ts`, `src/codey-api.d.ts` | drop `setDefault`/`active` |
| `codey-mac/src/components/BrowserProfiles.tsx` | remove radio, promote autoSync toggle |
| `codey-mac/src/components/BrowserPanel.tsx` | chip becomes read-only current-tab profile |
| `packages/core/src/skills/browser/SKILL.md` | drop `profile default`, document targeting |

## Out of scope

- Chrome → Codey reverse sync (still Chrome → Codey only).
- Any change to per-profile partitions (#429) or Chrome binding (#432).
- A picker for "which Chrome" when several are bound and no tab/`--profile`
  names one — the named error is the whole answer for now.
