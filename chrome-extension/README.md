# Codey Chrome Companion

Clicking the Codey avatar in Chrome opens a Side Panel chat. Connection is
automatic and stays in the background; there is no connection-status popup or
manual disconnect control. The Chat selector lists normal chats in Codey's
active workspace. Selecting one loads its latest history and continues the
same chat in both Chrome and Codey Mac; selecting **New chat** creates one on
the first message. The active tab title and URL are included automatically as
context for Side Panel turns.

The Side Panel uses the same per-chat Agent and Model settings as Codey Mac.
It also supports up to 10 file attachments (10 MB each). Files are stored in
the active workspace's standard `.codey/uploads` folder.

When Codey operates a Chrome tab, the tab title is prefixed with `● Codey ·`
and the extension action shows an `ON` badge for that tab. The marker follows
Codey to the next operated tab and is removed when the companion disconnects.

The Plugins settings page can also copy the current site's cookies and
localStorage into a named Codey Browser profile. This requires Chrome's
`cookies` permission, runs only after the user clicks **Export & activate**,
and does not export passwords, page contents, form fields, history, or data
from unrelated sites.

Installation from the Codey Mac app: on the Plugins settings page, click
**Choose folder & install**, pick somewhere you can find again, then use
**Open chrome://extensions** and load the installed folder unpacked. Codey
copies this directory there and refreshes it on every launch, so the installed
copy tracks Codey's releases. The copy is needed because Chrome's picker cannot
descend into the `Codey.app` bundle where the shipped extension lives.

Development installation from this repository:

1. Open `chrome://extensions` in Chrome. (Chrome blocks links to its own pages,
   so this URL has to be typed or opened from the Codey Mac app.)
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Keep Codey running. The extension discovers it and connects automatically.
The extension communicates only with Codey's loopback bridge. HTTP and HTTPS
site access is granted once during extension installation. It does not read
saved passwords, payment methods, autofill records, or browser history.
