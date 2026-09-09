# Per-profile browser partitions

Date: 2026-09-08
Status: design approved, not yet implemented

## Problem

Codey's built-in browser has exactly one storage jar. `BROWSER_PARTITION =
'persist:codey-browser'` (`codey-mac/electron/browser-controller.ts:29`) is a
constant, and every tab, popup window and hidden storage view is created on it.

Saved profiles are JSON files. Enabling profiles merges their cookies and
localStorage into that single jar (`applyLiveProfiles`,
`browser-controller.ts:1191` — "the live session becomes the union of every
enabled profile"). Three problems follow.

**Profiles are not isolated.** Two profiles that hold the same cookie for the
same domain cannot both be honoured; one value would silently win. The code
avoids the silent loss by refusing the second profile (`profileConflict`,
`browser-profiles.ts:293`, called from `browser-controller.ts:1035` and
`:1142`). So "work" and "personal" can never both be signed into GitHub.

**Logins made inside Codey's browser do not survive.** The JSON file is the
source of truth, and `applyLiveProfiles` is "always a full replace". When an
agent signs in through the Codey browser, that session lives in the jar but not
in any profile file, and the next rebuild wipes it.

**Switching identity is a whole-browser event.** An agent's `--profile <name>`
(`browser-agent-bridge.ts:161`) triggers `activateProfile`, which replaces the
live session for every open tab, and is gated behind the `activate-profile`
approval because it is that disruptive.

## Design

Give each profile its own Electron partition. A partition is a Chromium storage
bucket backed by its own directory: cookies, localStorage, IndexedDB, cache,
service workers. Two partitions share nothing.

```
persist:codey-profile-<name>    one per saved profile
persist:codey-browser           the default jar, for tabs with no profile
```

Four consequences, each of which is a section below: the jar becomes the source
of truth, tabs carry an identity, per-session facilities bind per jar, and the
merge machinery retires.

### The jar is the source of truth

A profile's login state is whatever its partition holds. There is no separate
JSON copy to reconcile.

JSON appears at exactly three boundaries:

- **Import** — read a profile file, write its cookies and localStorage into that
  profile's partition.
- **Export** — read the partition's cookies and localStorage, write a file.
- **Sync from Chrome** — write the extension's export into the partition.

Every one of these is a one-directional write. There is no `mergeProfileSites`
step, because there is nothing to merge into: the partition already holds the
profile and only the profile.

Reads change accordingly. `profileContents` and `profileSites`
(`browser-controller.ts:1048`, `:1068`) currently parse the JSON file; they
read `session.cookies.get({})` on the profile's partition instead. Cookie and
storage **values** still never leave the main process — the disclosure UI gets
site names and counts, as today.

localStorage cannot be read from a session object; it lives in the page. The
existing hidden-view mechanism (`createHiddenView`,
`browser-controller.ts:267`, `:1387`) already loads an origin off-screen to
apply storage, and is reused for both directions, now created on the profile's
partition rather than the shared one.

A profile still has non-jar metadata — display name, avatar, `createdAt`,
`sourceUrl`, the Chrome-sync switch. That stays in a small JSON record per
profile, holding metadata only, never cookies.

### Tabs carry an identity

`BrowserTabRecord` (`browser-controller.ts:142`) gains a `profile: string |
null` field — `null` meaning the default jar. The tab's `WebContentsView` is
created on that profile's partition. A tab's profile is fixed at creation: a
`WebContentsView` cannot change partition, and a tab that silently changed
identity mid-session is exactly the confusion this design removes.

`BrowserTab` (`browser-controller.ts:123`) gains `profile` so the renderer can
label the tab. The tab strip shows the profile's avatar on tabs that belong to
one; unprofiled tabs look as they do today. New-tab gets a way to pick which
profile it opens under, defaulting to the last one used.

Popups opened by a page (`setWindowOpenHandler`, `browser-controller.ts:1691`)
inherit the opener tab's partition. An OAuth popup that landed in the default
jar while its opener was in "work" would sign in to the wrong place.

### Per-session facilities bind per jar

These are attached to a `Session` today and assume there is one:

| Facility | Where | Change |
|---|---|---|
| Site permissions | `bindSitePermissions`, `:1619` | Bind on first use of each partition. Drop the `permissionSessionBound` one-shot flag for a set of bound partitions. The `BrowserSitePermissionManager` store stays global — a permission is the user's decision about a site, not about an identity. |
| Downloads | `bindDownloads`, `:1724` | Same: bind per partition, one shared download list and directory. |
| WebAuthn / passkeys | `configureBrowserWebAuthn`, `main.ts:2307` | Called once per partition. |
| Extensions | `BrowserExtensionManager`, `main.ts:2048` | Loaded per partition. Extensions are installed once (the on-disk record is global) and loaded into each profile's session as it is created. |

Extensions are the heaviest of these: `BrowserExtensionManager` takes a single
`Session` in its constructor. It changes to hold the installed-extension record
and expose `loadInto(session)`, called for each partition the browser opens.

### The merge machinery retires

These go away:

- `applyLiveProfiles` (`:1191`) — nothing is merged.
- `profileConflict`, `conflictingCookie`, `conflictingStorageKey`
  (`browser-profiles.ts:293`) and the two call sites that refuse an overlap.
  Isolation makes an overlap harmless.
- `mergeProfileSites` (`:1095`) and the site-scoped refresh it supports.
- The `activate-profile` approval gate in `browser-agent-bridge.ts` — an agent
  naming a profile now opens a tab in that jar, which disturbs nothing else.

`activeNames` / `setActive` (`browser-profiles.ts:514`, `:541`) shrink from "the
set of profiles merged into the live session" to "which profile new tabs
default to" — a single name, or none.

`enableProfile` / `disableProfile` / `activateProfile`
(`browser-controller.ts:1111`–`1161`) collapse into one `setDefaultProfile(name
| null)`. Nothing about it is destructive any more, so it needs no approval.

### Migration

On first run after the upgrade, each existing profile JSON file is replayed into
its new partition — the same write the import path performs — and the file is
rewritten as a metadata-only record. This is the one place the old and new
shapes meet; it runs once, keyed off the absence of a `schema` marker in the
metadata record.

The existing shared jar (`persist:codey-browser`) is left alone and becomes the
default, unprofiled jar. Whatever the user was signed into keeps working.

### Disk

Each profile now costs a full Chromium storage directory rather than a JSON
file. Deleting a profile deletes its partition directory
(`session.clearStorageData()` then remove the directory), so the cost is bounded
by the profiles a user keeps.

## Testing

`browser-controller.test.ts` and `browser-profiles.test.ts` already run against
an injected session factory (`getBrowserSession`,
`browser-controller.ts:258`). That factory becomes `(partition: string) =>
Session`, so tests hand out one fake session per partition and assert isolation
directly.

New cases:

- Two profiles hold a different cookie for the same domain; both open; each
  tab's session sees only its own value.
- A cookie set in a tab's jar is still there after the browser restarts, with no
  import step. This is the "logins survive" guarantee.
- Import writes into the named partition only; a second profile's jar is
  untouched.
- Export reads back what the partition holds, including localStorage gathered
  through the hidden view.
- Deleting a profile clears its partition and leaves the others intact.
- A popup opened from a profiled tab lands on the opener's partition.
- Migration: a pre-upgrade JSON profile with cookies ends up in its partition
  and the file is left holding metadata only.

## Out of scope

**Chrome auto-sync and localStorage freshness.** Getting an active profile to
mirror Chrome continuously — including sites not yet in the profile, an
exclusion list, and keeping localStorage current — is a separate design, written
after this one lands. It gets materially simpler once profiles are isolated,
because the conflict handling in `main.ts:2496`–`2512` (skip a domain when two
syncing profiles both claim it) has nothing left to guard.

**Per-tab profile switching.** A tab is bound to its partition for life. Moving
an open tab to another identity would mean recreating its `WebContentsView` and
losing history and page state; if it is wanted later it is its own change.
