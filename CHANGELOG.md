# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
