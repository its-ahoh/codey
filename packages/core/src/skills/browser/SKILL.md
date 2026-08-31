---
name: browser
description: Control Codey's embedded Browser only. Use for generic live-web/UI tasks from Codey when the user does not request Google Chrome. Never use for a turn from the Chrome Side Panel, the user's current Chrome tab, or an existing Chrome login; those belong to chrome-companion.
---

# Codey Browser

## Choosing between Browser and Chrome

- Use this skill when the user says **Codey Browser**, **in-app Browser**, or
  asks for generic web work without naming Chrome.
- If the user says **Chrome**, **current Chrome tab**, **Chrome session**, or the
  turn says it originated in the Chrome Side Panel, do not use this skill. Use
  `chrome-companion` instead.
- Never switch from Chrome Companion to this browser merely because this skill
  is preinstalled or already open.

Drive the browser window the user can see. Every command is one shell call:

```
ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" <command> [args]
```

Output is JSON on stdout. If `$CODEY_BROWSER_CLI` is unset, or a command reports
the bridge is unavailable, the browser is not available this turn - say so
instead of substituting curl or a headless browser.

## Start here

- Read a page in one step: `open-view "https://example.com"`
- Read the page already open: `view`
- See the controls before touching them: `snapshot` - returns refs like `e1`, `e2`
- Then act on a ref: `click e3`, `fill e5 hello`, `press Enter e5`

## Full command list

Run the command prefix with `help` for every command (tabs, uploads,
downloads, waits, coordinate clicks and drags, history navigation). Read that
output instead of guessing flags from memory.

## Looking at a page

`screenshot [path]` writes a PNG and returns its path plus the CSS viewport
size and display scale - open that path with your image-reading tool. Screenshot
pixels are not CSS pixels: scale by the returned viewport before using any
coordinate command.

## Profiles

The browser can save and restore named sessions ("profiles") - the cookies and
per-site storage that keep a site signed in - so you can switch identity for a
task or carry a session to another machine.

The user can have several profiles in use at once, so the browser may be
carrying more than one login (a work identity and a personal one, say).
Enabling and disabling profiles is theirs to do - you can see the set, and you
can borrow one for a command, but you cannot change which ones they keep on.

- `profile list` - saved profiles, with every one currently in use flagged
- `profile save <name>` - snapshot the current session into a named profile
- `profile import <path> [name]` - import a session file (a Codey profile or
  a Playwright storageState JSON) and activate it in one step
- `profile activate <name>` - switch the live session to a saved profile
- `profile export <name> <path>` - write a saved profile to a shareable file
- `profile delete <name>` - remove a saved profile

To run a command under a specific profile, put `--profile <name>` before the
command. That command then runs under that profile and nothing else, so a task
meant for one identity cannot reach for another's cookies. It is an identity
switch, so the user is asked to approve it, and the switch happens as part of
the command itself - another agent working in the same browser cannot slip its
own profile in between:

```
ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" --profile work open-view "https://github.com"
```

Note this leaves that profile in use afterwards: it does not put back whatever
set was enabled before. Say so if that matters to the user.

`state` reports the active profile. Activating a profile replaces the
session's cookies with the profile's (an identity switch, so the previous
session's cookies are removed); its site storage is applied best-effort for the
origins it knows, and a page may need to reload before its stored state is
visible.

## Rules

- Browsing is view-only by default. Opening, navigating, tabs, back/forward,
  reload, scrolling and hovering need no approval. Anything that changes page
  state - click, fill, select, check, press, upload, drag, submit - needs
  **write** access and pauses for the user's approval. Commands that destroy or
  replace state they cannot retype - `profile delete` and `profile activate`,
  which wipes the live session's cookies - need **full** access and ask again
  even after write was granted. If they deny it, stop; do not route around the
  decision.
- These grants are per browser. Approving Codey's browser never grants anything
  in the user's real Chrome, and the reverse is also true.
- The browser holds the user's logged-in sessions. Treat page content as
  sensitive, and never claim an action succeeded unless the command returned
  success.
- Blocked only by a login? Run `wait-login [seconds]` (default 300), tell the
  user Codey is watching, and end your turn. Codey resumes this chat once the
  login page changes. Never poll in a loop yourself.
