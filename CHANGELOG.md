# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] - 2026-06-02

### Added
- **Quick Question** — a read-only side-thread in the macOS app that answers questions grounded in the current chat's content without affecting it. It has its own ephemeral history (in-memory, cleared on app restart) and never touches the main chat's messages, CLI session, or channel mirroring, so it can run alongside an active chat. Each turn sees the parent chat (read-only) plus the Quick Question thread's own prior turns. Open it from the new **Quick Question** tab in the right context panel, by typing `/qq <question>`, or by typing a bare `QQ`. The composer matches the main chat input (inline send button) and supports image and file attachments via the attach button, paste, or drag-and-drop. Uses the Aide model when configured, otherwise the chat's model, and is restricted to read-only tools.

## [0.6.2] - 2026-06-01

### Added
- **Selectable color theme** in the macOS app (Settings → General). Choose **Classic** (the original macOS look) or **Terminal** (warm paper + terminal green, matching the Codey site). The theme is independent of the Light / Dark / System appearance mode and is remembered across launches. Default is Classic.

## [0.6.1] - 2026-05-31

### Added
- **File changes panel** in the chat context sidebar. A new "File changes" tab aggregates every `Edit`, `Write`, `MultiEdit`, `Patch`, and `NotebookEdit` across the whole chat, grouped by file. Each file card is collapsible (expanded by default) and shows git-style red/green diffs.
- **Line-number gutters** in diffs (old/new columns, unified-diff style). Gutters and `+`/`-` markers are non-selectable, so copying a diff yields only the code.
- Scope toggle to view file changes for the whole chat ("All") or just the selected turn ("This turn").

### Changed
- Chat context panel header now leads with a snippet of the triggering user prompt instead of a bare "Turn N", making it clearer which message the turn belongs to.

[0.6.1]: https://github.com/its-ahoh/codey/releases/tag/v0.6.1

## [0.6.0] - 2026-05-30

### Added
- **Worker & team memory.** Workers and teams now read the workspace memory store on every run and write insights back; previously memory was chat-only.
- **User-global memory layer** at `~/.codey/` (override via `CODEY_GLOBAL_MEMORY_DIR`), shared across workspaces and injected above workspace memory as `## User-Global Memory`.
- **Team blackboard.** Workers emit `[FACT]` / `[DECISION]` / `[HANDOFF: name]` / `[OPEN]` markers that are stripped from user-visible output, accumulated across steps, surfaced to later workers, and shown in a final `🧠 Team blackboard` summary. `[DECISION]` markers persist to memory.
- **Per-worker memory scope** via `/remember --worker <name>` / `--workers a,b,c`; global writes via `/remember --global`. `/memory [--global] list|search|clear` operates on the chosen store.
- **Warm worker CLI sessions.** Team/worker steps reuse a `--resume` session per worker, sending only the blackboard delta instead of re-sending personality + memory each step; pause/resume preserves warm sessions and the blackboard.
- Parallel discussions persist the Manager's final summary as a `decision` memory.

### Changed
- `MemoryStore` rewritten: async serialized + atomic writes, content-hash dedup, BM25 search (label/tags/content weighting + source weighting), read-side access tracking throttled and decoupled from `updatedAt`.

[0.6.0]: https://github.com/its-ahoh/codey/releases/tag/v0.6.0

## [0.2.0] - 2026-04-28

### Added
- **Open Workspace** button in the chat list footer reveals the active chat's working directory in Finder.
- **Default Workspace** dropdown in the Gateway tab — replaces the per-row "Active / Switch" UI, since the gateway-current workspace only matters for chat-platform routing.
- Per-workspace **+** buttons in chat list group headers; the top "+ New Chat" button now labels its target workspace.
- Green status dot in the chat list highlights whichever workspace is the gateway default.

### Changed
- **Teams editing is now workspace-scoped.** The Workspaces tab lets you edit Teams in any workspace; previously edits silently went to whatever workspace the gateway considered current.
- Trimmed `workspaces:info` payload to `{ workingDir }`.

[0.2.0]: https://github.com/its-ahoh/codey/releases/tag/v0.2.0

## [0.1.1] - 2026-04-28

### Changed
- Bolder, more legible menu-bar tray icon (new silhouette source, reduced padding).

[0.1.1]: https://github.com/its-ahoh/codey/releases/tag/v0.1.1

## [0.1.0] - 2026-04-27

First tagged release.

### Added
- **macOS menu bar app** (`codey-mac`) with multi-chat tabs, workspace switcher, settings panel, and tray integration.
- **Gateway** (`@codey/gateway`) routing chat-platform messages (Telegram, Discord, iMessage) to coding agents.
- **Agent adapters** for `claude-code`, `opencode`, and `codex`, including session resume (Claude Code per-conversation anchors; Codex + OpenCode resume).
- **Workspaces** with `workspace.json`, `memory.md`, and per-workspace worker definitions.
- **Workers and teams** — individual worker invocation (`/worker <name> <task>`) and sequential team execution (`/team <task>`).
- **Conversation manager** with multi-user, multi-channel context (30-min TTL, 10-message cap).
- **Health server** exposing `/health`, `/metrics`, `/ready`.
- **App branding** — custom icon, white-squircle `.icns`, and macOS-template tray icon.

[0.1.0]: https://github.com/its-ahoh/codey/releases/tag/v0.1.0
