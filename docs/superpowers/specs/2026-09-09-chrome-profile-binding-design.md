# Chrome profile binding — design

**Date:** 2026-09-09
**Branch:** `chrome-profile-binding`
**Builds on:** `f21f932 feat(browser): isolate profiles and mirror Chrome sessions (#429)`

## Problem

Codey's Chrome companion mirrors a real Chrome session into a Codey browser
profile. Two things are wrong once more than one Chrome profile is involved.

**One pairing.** `ChromeCompanionBridge` holds a single `token`, `clientName`,
command `queue` and `pending` map. A Chrome extension instance lives per Chrome
profile, so two Chrome profiles both running the companion fight over that one
pairing: `/v1/connect` mints a fresh token, calls `rejectAll`, and overwrites
the previous client. The loser's next poll is rejected as unauthorized, it
re-connects, and the two ping-pong indefinitely.

**Broadcast sync.** `runAutoSync` in `main.ts` iterates every Codey profile with
`autoSync` on and writes the *same* Chrome export into each. A work login and a
personal login land in every mirroring profile, which defeats the per-profile
partition isolation that #429 introduced.

## Goal

Each Chrome profile is bound to exactly one Codey browser profile. A change made
in Chrome profile X updates only the Codey profile bound to X. Several Chrome
profiles can be connected at once.

## Design

### 1. Chrome-side identity

On first run the extension generates `crypto.randomUUID()` and stores it in
`chrome.storage.local` under `profileId`. `chrome.storage.local` is scoped to
the Chrome profile, so each profile gets its own stable ID for free, with no new
manifest permission.

The extension sends `profileId` in the `/v1/connect` body. Every later request
is identified by its token (see below), so the ID travels once.

The human-readable label is assigned by Codey as `Chrome profile <n>` in order
of first connection, and is renameable in Codey's UI. Reading the signed-in
account name instead would require the `identity.email` permission and its
consent prompt; not worth it for a label.

Extension version bumps to `0.18.0`.

### 2. Bridge: one client becomes many

`ChromeCompanionBridge` replaces its single-client fields with
`clients: Map<string, ChromeClient>` keyed by `profileId`:

```ts
type ChromeClient = {
  profileId: string
  token: string
  clientName: string
  clientVersion: string | null
  pairedAt: number
  lastSeenAt: number | null
  queue: PendingCommand[]
  pending: Map<string, PendingCommand>
}
```

**One token per Chrome profile.** `authorize(request)` resolves the bearer token
to a client by constant-time comparison against each client's token, and returns
the client. Every authenticated handler then operates on that client alone. A
compromised extension in one Chrome profile cannot read another profile's
command queue or pull another profile's cookies — which is the entire point of
the feature, so a shared token with a self-declared `profileId` header is
rejected as a design option.

`/v1/connect` mints a token for the connecting `profileId` only. It rejects the
pending commands of *that* client (a reconnect invalidates its own in-flight
work) and leaves every other client untouched. This is the ping-pong fix.

`/v1/poll`, `/v1/result`, `/v1/session/changed` and the side-panel chat routes
all scope to the resolved client. `command<T>()` gains a `profileId` target and
uses that client's queue and pending map; each client keeps its own command
timeout bookkeeping.

**Persistence.** The pairing state file becomes `{ clients: PersistedClient[] }`.
A file still holding the old single-record shape loads as one client with
`profileId: null`, which is treated as legacy-unbound: it stays authorized so an
un-upgraded extension keeps working, and it is replaced by a properly keyed
client on the extension's next `/v1/connect` after the upgrade.

**Status.** `status()` keeps returning a single summary for existing consumers
(paired/connected = any client), and a new `clients()` returns the per-profile
list for the UI and for routing decisions. `disconnect()` takes an optional
`profileId`; with none it drops every client, as today.

### 3. Binding

`BrowserProfileStore` profile metadata gains:

- `chromeProfileId: string | null`
- `chromeProfileLabel: string | null` (cached for display when Chrome is offline)

The binding is one-to-one in both directions. Binding a Chrome ID that is
already bound removes it from its previous Codey profile in the same write, so
the store can never hold two profiles claiming the same Chrome.

**Auto-create on first sight.** When a `profileId` connects and no Codey profile
is bound to it, Codey creates one named after the Chrome label (deduped against
existing names), turns `autoSync` on, and binds it. Zero setup: work in a Chrome
profile and the matching Codey profile appears. The binding is editable
afterwards.

### 4. Sync routing

- Each client's poll response carries the watch list, exclusions and revision of
  *its* bound Codey profile only. The global `autoSyncProfileCache`,
  `sharedExclusionCache` and single `autoSyncRevision` become per-client state
  keyed by `profileId`.
- `runAutoSync` iterates connected clients rather than mirroring profiles. For
  client C bound to Codey profile P it exports from C and calls
  `resyncProfileSites(P, …)`. Nothing else is written.
- `onSessionChanged(domains)` becomes `onSessionChanged(profileId, domains)`.
  A burst from an unbound client is dropped.
- `onConnected` / `onPoll` become per-client, so one Chrome reconnecting forces
  a full sync of its own profile and not of everyone else's.
- Per-client pending-domain sets, full-sync flags and retry backoff, so a
  failing Chrome cannot stall another's sync.

### 5. Which Chrome a Codey-initiated command targets

Commands Codey starts — `activeTab`, `snapshot`, `navigate`, `act`,
`listSessionSites`, `exportSessionForSites`, the agent-facing `chrome`
subcommands — target the Chrome bound to the **currently active Codey browser
profile**.

Failure modes get named errors rather than a generic "not connected":

- active profile has no binding → `Profile "X" is not linked to a Chrome profile`
- bound Chrome is not connected → `Chrome profile "Y" (linked to "X") is not running`
- no Codey profile is active → `Activate a browser profile first`

### 6. Which Codey profile a Chrome-initiated request feeds

Requests Chrome starts already arrive on an authorized connection, so the client
is known from the token. Session-change bursts route to that client's bound
profile. The side panel's `suggestProfileName` and `profilesOverview` default to
the caller's own bound profile.

### 7. UI

`BrowserProfiles.tsx` — each profile row gains a line under the name:
`Chrome: <label>` or `Not linked to Chrome`. Clicking opens a picker listing
every known Chrome profile (connected ones marked) plus "None". Picking a Chrome
already bound elsewhere shows what it will be moved away from.

`BrowserPanel.tsx` — the Chrome settings section lists all connected Chrome
profiles with their bound Codey profile, instead of one connection row.

### 8. IPC surface

- `browser:profiles:setChromeBinding(name, chromeProfileId | null)`
- `browser:chrome:clients()` → the list of known/connected Chrome profiles
- `browser:chrome:renameClient(chromeProfileId, label)`
- `browser:chrome:disconnect(chromeProfileId?)` — existing handler gains the
  optional argument

### 9. Testing

**`chrome-companion.test.ts`**
- two clients connect; both stay paired and both polls stay authorized
- a command targeted at client A appears only in A's poll
- a result posted with A's token cannot resolve B's pending command
- A's token is rejected on a route scoped to B
- legacy single-record state file loads, authorizes, and is replaced on reconnect

**`browser-profiles.test.ts`**
- binding is one-to-one; rebinding clears the previous owner
- auto-created profile is named, deduped, autoSync on, bound
- metadata round-trips through read/write

**`main.ts` auto-sync (via existing harness)**
- a change from Chrome A writes only the profile bound to A
- an unbound client's change burst is dropped
- a failing client does not block another client's sync pass

### 10. Files touched

| File | Change |
| --- | --- |
| `codey-mac/electron/chrome-companion.ts` | connection layer rewritten for N clients |
| `codey-mac/electron/main.ts` | per-client auto-sync loop, target resolution, new IPC |
| `codey-mac/electron/browser-profiles.ts` | binding metadata + one-to-one enforcement |
| `codey-mac/electron/browser-controller.ts` | binding accessors, active-profile target |
| `codey-mac/electron/browser-agent-bridge.ts` | agent `chrome` commands resolve a target |
| `codey-mac/electron/preload.ts`, `src/codey-api.d.ts` | new IPC |
| `codey-mac/src/components/BrowserProfiles.tsx` | binding row + picker |
| `codey-mac/src/components/BrowserPanel.tsx` | multi-connection settings |
| `chrome-extension/service-worker.js`, `sidepanel.js`, `manifest.json` | profile ID, version bump |
| `packages/core/src/skills/chrome-companion/SKILL.md` | targeting semantics |

## Out of scope

- Reading Chrome's real profile directory or account identity.
- Syncing Codey → Chrome. The flow stays Chrome → Codey.
- Any change to how the Codey browser's own partitions work (#429 stands).
