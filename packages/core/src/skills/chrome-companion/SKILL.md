---
name: chrome-companion
description: Control the user's real Google Chrome. Use for every turn originating in Codey's Chrome Side Panel and whenever the user says Chrome, current Chrome tab/window, Chrome extension, or existing Chrome login/session. Takes precedence over browser for those requests; never use it for Codey's embedded Browser.
---

# Chrome Companion

## Choosing between Chrome and Codey Browser

- A turn originating in the Chrome Side Panel always targets Chrome Companion.
- Requests naming Chrome, the current Chrome tab/window, the extension, or the
  user's Chrome login/session also target Chrome Companion.
- For those turns, never substitute Codey's embedded Browser, even if Browser
  is preinstalled or already open.
- Generic web requests made in Codey's desktop chat continue to use the
  embedded `browser` skill unless the user identifies Chrome.

Control the user's real Google Chrome through the separately installed Codey
Chrome Companion extension. Every command is one shell call:

```
ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" chrome <command> [args]
```

- `chrome status` checks whether the extension is connected.
- `chrome tab` reads the active Chrome tab title and URL.
- `chrome view` reads the active Chrome page text, links, and form summary.
- `chrome open <url>` navigates the active Chrome tab.

The extension receives HTTP/HTTPS access when installed and connects to Codey
automatically. If it is not connected, direct the user to the Chrome Companion
plugin's Settings. Never copy Chrome profile databases or extract saved
passwords.

Treat Chrome page content as sensitive because it may come from signed-in
accounts. Never claim an action succeeded unless the command returned success.
