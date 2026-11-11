# Computer control in Codey

Codey is the computer-use host. Its Electron main process owns the Cua Driver
SDK, bounded native runtime, application authorization, window identities,
observations and input. Agents call Codey's authenticated local API through a
small CLI. No agent receives Driver MCP configuration or its private endpoint.
The same integration works through the existing shell tools of Claude Code,
Codex, OpenCode and Pi; there are no agent-specific Cua adapters.

## Flow

Agent shell -> Codey computer CLI -> private Codey socket -> Codey service ->
Cua SDK -> bounded native driver -> selected application window.

The renderer has a desktop panel beside the chat. After selecting an approved
window, Start live view requests a native Electron window video stream (30 fps
target, no audio). Codey maps only the inspected native window ID to a capture
source; it never falls back to a whole display or enables the system picker.
The stream is local to Codey, is not recorded, and is independent of the agent's
CUA snapshots. Frame delivery does not refresh accessibility snapshots or stale
an agent's element references. Agent image tools continue to use observations.

Take control pauses agent desktop requests, drains the current operation and
invalidates queued input before enabling the user's mouse and keyboard. Click,
right-click, completed drag gestures, scroll, text/IME, paste and keyboard
shortcuts go through the same bounded Cua runtime. Return control invalidates
old human input and requires the agent to observe again. Already delivered input
cannot be rolled back. Ctrl+Shift+Esc returns control from the keyboard surface.

The main process validates each stream grant against a trusted top-level
renderer, a user gesture, the current task, native window ownership and macOS
permission. Single-use grants expire after ten seconds. Window disappearance,
task termination, renderer navigation/crash or permission revocation ends access.
A hidden/reloaded panel stops its tracks; paused video leaves a human-owned task
paused until explicit handback or Stop. Input requires a live stream grant and a
recent decoded frame. Native input rechecks that grant after taking its targeting
snapshot. Coordinates account for video letterboxing and screenshot scaling;
a changed aspect ratio refuses input rather than guessing.

## Use

1. Open Tools > Computer and grant Accessibility and Screen Recording to Codey.
2. Select applications with the native picker and enable computer tools.
3. To preview locally, choose View next to an application, select a window and
   choose Open desktop. Approve the native Codey access dialog, then select
   Start live view in the panel beside the chat.
4. Agent tasks receive the Codey CLI and a per-run credential. Ordinary coding
   does not start a driver or ask for approval. Listing configured apps is local;
   the first window request starts approval and acquires exclusive computer use.
5. Codey lists windows for exact approved bundle IDs. The agent observes a
   returned window before input, opens its returned screenshot with its image
   tool, acts, then observes again. Codey's independent video shows the application continuously.
6. Stop computer control revokes active and queued desktop capabilities. A
   declined desktop request returns an error without cancelling normal coding.

App selections persist, but enablement resets off at launch. Changing selection
stops existing sessions. A wider selection needs another task and approval.
Agents take over a local preview by closing it and requesting their own grant.
While an agent owns the desktop, the panel follows its selected window. A user
can take control of that window. Agents cannot displace a human-owned preview.
Stop the current task's computer access before opening an unrelated preview.

## Boundaries and lifetime

Codey owns OS permission checks and native approval dialogs. Only its trusted
local top-level renderer may invoke settings, grant or preview IPC. Requests
from websites and subframes are refused. The bridge uses a random private
Unix socket, owner-only permissions and random per-run bearer credentials.
Computer access is omitted from housekeeping and restricted-tool turns.

After approval, Codey creates a version 3 bounded manifest of exact application
bundle IDs and a small tool list. Full-desktop capture, browser-profile access,
arbitrary execution, file transfer and process termination are not granted.
Codey itself cannot be selected. Driver hard protections remain in effect.
Application contents and screenshots may reach the selected model provider.

The Codey API accepts apps, windows, observe and act commands. It derives process
and window IDs from the native SDK, rechecks process ownership before requests,
requires observation before input and rejects arbitrary tool or target overrides.
Input defaults to background delivery; explicit foreground mode can change focus.
The driver still validates native schemas, window ownership and grant scope.
This is an application policy boundary, not a sandbox against arbitrary shell
code running with the same user's existing privileges.

One desktop request owner runs at a time. Other agents continue normal work
until they actually need the desktop. Each runtime has a two-hour maximum and
fifteen-minute idle expiry. Finishing, cancellation, driver failure and shutdown
revoke credentials and stop the runtime. Queued cancelled requests cannot later
show an approval prompt. A failed native stop blocks subsequent desktop work
until restart. Input already delivered cannot be rolled back by stopping.

Screenshots are kept in memory for the panel and in private temporary files for
agent image tools, overwritten on observation and removed at task end. They are
not stored in Codey settings or chat state. Renderer polling never broadcasts
image data to the global queued status channel.

## Packaging and validation

`npm run prepare:cua -w codey-mac` stages the pinned official 0.34.0 universal
binary with SHA-256 verification. The TypeScript SDK is pinned to 0.34.0. No
upstream installer or user agent configuration is changed. The executable and
MIT license live outside ASAR; the native SDK is loaded through its unpacked
physical path. Existing release signing/notarization includes the driver.

Tests cover lazy approval, all-agent CLI delivery, per-task credential revocation,
image lifetime, preview takeover, queued cancellation, target restrictions,
exact-window video grants, handoff barriers, human input geometry, stale frames,
stream cleanup and renderer lifecycle,
trusted renderer IPC, OS prerequisites and factory cleanup. Package smoke checks
load the real SDK, check the binary version and execute the packaged CLI help
without granting or exercising desktop access.

Live acceptance still requires a human-granted macOS permission session: preview
a fixture app, start live video, inspect the same window through an agent,
take control, click/type/scroll/drag, return control and verify a fresh agent
observation. Deny a new task, stop active/queued work, close or resize the target,
revoke Screen Recording, then start a fresh task. Check Retina scaling, IME and
application-specific background input support. Video frame rate and input latency
are targets, not measured performance claims.
Mock tests and builds do not establish live desktop correctness.
