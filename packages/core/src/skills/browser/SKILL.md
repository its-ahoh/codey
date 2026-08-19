---
name: browser
description: Use when a task needs the live web or a real UI - open, read, screenshot, or click through pages in the user-visible Codey Browser, including pages behind the user's existing logins. Triggers - "open this page", "check the site", "log in and", "what does the page say", "click the button", "fill the form", "test the UI".
---

<!-- Managed by Codey. Edits are overwritten; this file is removed when the
     Browser plugin is turned off. -->

# Codey Browser

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

## Rules

- Browsing is view-only by default. Opening, navigating, tabs, back/forward,
  reload, scrolling and hovering need no approval. Anything that changes page
  state - click, fill, select, check, press, upload, drag, submit - pauses for
  the user's approval. If they deny it, stop; do not route around the decision.
- The browser holds the user's logged-in sessions. Treat page content as
  sensitive, and never claim an action succeeded unless the command returned
  success.
- Blocked only by a login? Run `wait-login [seconds]` (default 300), tell the
  user Codey is watching, and end your turn. Codey resumes this chat once the
  login page changes. Never poll in a loop yourself.
