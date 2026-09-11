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

One per-profile concept — **active** — plus a per-invocation **target**:

- **active** = the profile is enabled. An active profile can be invoked, and
  an active profile also mirrors its linked Chrome automatically. There is no
  separate "auto-sync" switch: being active *is* the switch. Many profiles can
  be active at once.
- **target** = decided at the moment a command runs: the agent's
  `--profile <name>`, else the browser tab currently on screen. No global
  "default/active" selection survives.

## Design

### 1. `active` becomes per-profile "enabled", `autoSync` is folded into it

The `.active` file already stores one name per line, so multi-enable is the
format's native shape; only the writers and readers collapsed it to one.

- `browser-profiles.ts`: `setActive(name, enabled)` adds/removes a name instead
  of overwriting the file with one. `activeNames()` and the `active` summary
  field stay (they already describe a set). `active()` (the first-name helper)
  and the `autoSync` field/method are removed.
- `browser-controller.ts`: `setDefaultProfile(name)` becomes
  `setActiveProfile(name, enabled)`; `setProfileAutoSync` and
  `activeProfileName()` are removed. `importProfile`'s `makeDefault` flag is
  renamed `activate` and now adds the profile to the active set.
- `autoSync` is gone: mirroring is driven by `active` plus a binding. The
  #432 sync loop keys on `active && chromeProfileId` instead of
  `autoSync && chromeProfileId`.

### 2. Target = current tab, or `--profile`

**A new `currentTabProfile()` accessor** on `BrowserController` returns the
profile name of the tab currently on screen (`tabs.find(tab => tab.view ===
this.view)?.profile ?? null`). `BrowserState` gains a `profile` field so the
renderer can show it. This is the manual-UI target: the toolbar's Chrome
commands and the `+` new-tab button act on the profile the user is looking at.

**New-tab default follows the current tab.** `createTab` / `newTab` use
`currentTabProfile()` instead of the removed `activeProfileName()`; closing the
active tab creates the replacement tab on the closed tab's profile.

**`targetResolver`** (set in `main.ts`) resolves the current tab's profile to
its bound Chrome. The resolution chain is: tab profile → must be active → must
be bound → its Chrome is connected. Named failures:

- no tab / tab has no profile → `Activate a browser profile first`
- profile not active → `Profile "X" is not active`
- profile not linked → `Profile "X" is not linked to a Chrome profile`
- linked Chrome not running → `Chrome profile "Y" (linked to "X") is not running`

### 3. Agent `--profile` routes Chrome commands

`browser-agent-bridge.ts` already captures `--profile` in `profileScope`. Today
it only steers `newTab`. It now also steers every Chrome companion call.

- Add `chromeTarget(): string | null` to the bridge: if `profileScope` holds a
  name, check it is an active profile, resolve
  `controller.chromeBindingForProfile(name)` and return its `profileId` (throw
  the named "not active" / "not linked" error). With no `--profile` it returns
  `null` so the companion's `targetResolver` falls back to the current tab.
- The companion routes pass that target explicitly:
  `companion.activeTab(this.chromeTarget())`, `snapshot(…)`, `navigate(…,
  target)`, `act(…, target)`.
- `getState().profile` and the `/profiles` reply report
  `controller.currentTabProfile()` instead of `activeProfileName()`.

`--profile` names a Codey profile; the binding (#432) maps it to the Chrome
that gets the command. No new mapping table is needed.

### 4. UI

- `BrowserProfiles.tsx`: the single "No profile / Active / Activate" radio goes
  away. Each profile row gets one **Active** toggle (per-profile, many on).
  The "Sync with Chrome" (autoSync) toggle is gone — active profiles sync.
- `BrowserPanel.tsx`: the toolbar chip stops being a picker — it shows the
  current tab's profile (`state.profile`). The "Active profile" menu goes away.
  The alt-click `+` picker stays, listing only active profiles.
- `browser/SKILL.md`: `profile default` becomes `profile activate`; document
  that `--profile` names an active profile and routes the command to that
  profile's bound Chrome.

### 5. IPC surface

- Removed: `browser:profiles:setDefault`, `browser:profiles:setAutoSync`.
- Added: `browser:profiles:setActive(name, enabled)`.
- `browser:profiles:list` reports each profile's `active` flag (now "enabled",
  multi).

### 6. Testing

**`browser-profiles.test.ts`**
- `setActive(name, true)` adds to the set; a second `setActive(other, true)`
  leaves the first enabled; `setActive(name, false)` removes only that name.
- a pre-existing `.active` file with several lines reads back as several active.
- `autoSync` is gone from the store and summary.

**`browser-controller.test.ts`**
- `newTab()` with no profile opens in the current tab's profile.
- `currentTabProfile()` is null with no tab and matches the focused tab's
  profile with tabs open.
- `setActiveProfile` / `importProfile(activate)` add to the active set instead
  of replacing it.

**`browser-agent-bridge.test.ts`**
- `--profile personal` resolves to `personal`'s bound Chrome and is passed to
  the companion call; an inactive or unbound profile throws the named error.
- no `--profile` falls through (companion resolves the current tab).
- `/profiles` and `getState().profile` report the current tab's profile.

**`chrome-companion.test.ts`** — unchanged; `targetResolver` already treats a
null result as "fall back".

### 7. Files touched

| File | Change |
| --- | --- |
| `codey-mac/electron/browser-profiles.ts` | `setActive(name, enabled)` toggle; drop `active()`, `autoSync` |
| `codey-mac/electron/browser-controller.ts` | `currentTabProfile()`, `isActiveProfile()`, `setActiveProfile`, remove `activeProfileName`/`setDefaultProfile`/`setProfileAutoSync`, new-tab default, `importProfile(activate)`, `BrowserState.profile` |
| `codey-mac/electron/browser-agent-bridge.ts` | `chromeTarget()`, route Chrome calls, report current-tab profile |
| `codey-mac/electron/main.ts` | `targetResolver` from current tab, `setActive` IPC, sync loop keys on `active`, drop `setDefault`/`setAutoSync` |
| `codey-mac/electron/preload.ts`, `src/codey-api.d.ts` | `setActive` replaces `setDefault`/`setAutoSync`; summary drops `autoSync` |
| `codey-mac/src/components/BrowserProfiles.tsx` | Active toggle per row, remove sync toggle |
| `codey-mac/src/components/BrowserPanel.tsx` | chip becomes read-only current-tab profile |
| `packages/core/src/skills/browser/SKILL.md` | `profile activate`, document targeting |

## Out of scope

- Chrome → Codey reverse sync (still Chrome → Codey only).
- Any change to per-profile partitions (#429) or Chrome binding (#432).
- A picker for "which Chrome" when several are bound and no tab/`--profile`
  names one — the named error is the whole answer for now.
