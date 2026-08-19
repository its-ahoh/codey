# Browser as a skill, not an MCP server — Design

Date: 2026-08-18
Status: Implemented (PR #313)
Supersedes: `2026-07-21-plugins-browser-mcp-design.md` (the browser transport
half of it; the plugin registry, config shape and UI it introduced all stay)

## Problem

The Browser plugin reached agents through a stdio MCP server, so it only worked
on the three adapters with an MCP surface. pi has none — "No MCP" is its own
README's wording, with a linked essay arguing the position, so this is a
settled design stance upstream rather than a gap waiting to be filled. Enabling
the plugin and then running pi produced an agent with no browser and no
diagnostic: no error, no notice, nothing in the UI saying the switch did not
apply here. The same would hold for any future adapter without MCP.

MCP also costs context. Tool schemas sit in the prompt every turn whether or
not the turn touches the browser, and published measurements of comparable
browser MCP servers put that at 13–17K tokens before any work happens.

## Goal

One browser capability that every coding agent Codey runs can consume, on a
transport with no per-agent prerequisite, without weakening the approval gate
or widening which turns can reach the browser.

## Decision

**Shell CLI for execution, skill for discovery.** A coding agent without a
shell is not a coding agent, which makes shell the one universal surface. The
CLI already existed and shipped: `codey-mac/electron/browser-agent-cli.cjs`,
25 subcommands over the same Unix-socket bridge and the same permission gate
the MCP server used. What was missing was only the layer that tells an agent
the command exists.

That layer is a skill. `packages/core/src/agents/codey-skills.ts` already links
Codey's skills into `.claude/skills` and `.agents/skills` — between them those
two conventions cover claude-code, codex, opencode and pi. Skills are read on
demand: only the frontmatter description stays in context, and the body loads
when a task actually needs the browser.

This replaces a transport rather than adding one. `browser-mcp-server.cjs`
duplicated the bridge client the CLI already contained; both are gone, and the
net change is −403 lines.

### Why not keep both

Two transports means two copies of the bridge client, two copies of the command
documentation, and two things to update whenever a subcommand changes. The MCP
path bought typed schemas and inline screenshot images; neither justifies a
permanent second implementation of the same capability, and the second is the
one that silently fails on a third of our adapters.

### Prior art

Orca ships browser control as CLI plus skill with MCP as an optional extra, and
supports Claude Code, Codex, OpenCode, Gemini, Cursor, Copilot and Grok on that
basis. Vercel's agent-browser and Microsoft's Playwright CLI are CLI-first for
the same token reason, with Microsoft explicitly recommending a skill wrapper
over an MCP server.

## Design

### Discovery: the managed skill

- `packages/core/src/skills/browser/SKILL.md` holds the text — plain markdown,
  copied into `dist/skills` at build time so `__dirname/../skills` resolves
  identically from source and from a packaged app.
- `installBrowserSkill()` writes it to `~/.codey/managed-skills/browser/`;
  `removeBrowserSkill()` deletes that directory. `AgentFactory.run()` calls one
  or the other on every run, so an upgrade always ships current instructions and
  turning the plugin off takes the skill out of every agent's list.
- The managed root is **not** `~/.codey/skills`. That directory is the user's;
  a plugin that rewrites and deletes its own skill on every run must never
  operate inside it.
- `syncCodeyManagedSkills()` links the managed root into `.claude/skills` and
  `.agents/skills`, reusing the existing link logic.

### Capability: the environment

`addCodeyBrowserTools()` (the name the pre-MCP function had, restored) puts
`CODEY_BROWSER_{SOCKET,TOKEN,CLI,RUNTIME,CHAT_ID}` into `request.extraEnv`
under the unchanged gating chain: plugin enabled, bridge present,
`browserTools === true`, a working directory, and no `allowedTools`. All four
adapters already merge `extraEnv` into the spawned process, pi included, so no
adapter changed.

**Discovery and capability are deliberately separate.** The skill on disk is
documentation; the gate is the environment. The skill is a global link and so
appears in every turn's skill list, including advisor and tool-restricted
turns — but those turns get no `CODEY_BROWSER_*`, and the CLI refuses to act
without them. The set of turns that can reach the browser is byte-for-byte the
set that could reach it before; only the failure mode moved, from "the agent
cannot see the tool" to "the agent sees it and is told the bridge is
unavailable".

### The toggle

Unchanged: the same `browser` entry in `codey-mac/electron/plugins.ts`, the
same `PluginsTab` switch, the same `gateway.json` persistence and default. Only
its description text changed, since it no longer describes MCP tools. Existing
enabled/disabled state carries over.

### `mcpServers` after this

The mechanism stays, for user-configured external MCP servers (Linear and the
like), which have no CLI to fall back to and so remain limited to the three
adapters that can speak MCP. The `codey-browser` name reservation in
`addExternalMcpServers` is gone; nothing occupies that name now, and keeping
the filter would silently swallow a user's server of the same name.

## Costs accepted

- **Screenshots** return a PNG path instead of an inline image block. The agent
  reads the file with its own image tool — one extra hop, but every agent has
  that tool, so it is more portable than the MCP-only image content type.
- **No schema validation.** A model can mistype a command line in a way a typed
  tool call would have rejected. The CLI's own error output is the correction
  path, and the skill tells the agent to run `help` rather than guess flags.
- **Invocation is probabilistic.** pi's own documentation notes models do not
  always read a skill they should. The description is written dense with
  trigger phrases ("open this page", "log in and", "click the button") to make
  it fire.
- **An agent with shell disabled** loses the browser. Nothing in Codey does
  that today.

## Verification

- pi, unmodified, discovered the skill, ran the CLI, and reported a page back
  through the bridge — the browser reached an agent that cannot use MCP at all.
- Turning the plugin off removed the managed skill and both discovery links.
- The markdown survives packaging: present in the built app's asar under
  `node_modules/@codey/core/dist/skills`, and installing from the compiled
  `dist` writes and links identical bytes.
- Full suite green (core 535 / gateway 328 / mac 544); build and lint pass.

Not covered: a run against the real in-app bridge with the plugin enabled. The
verification above used a stand-in bridge, because the real token never leaves
the app process's memory.

## Follow-ups

- A third-party or user-authored managed skill would want its own repo and a
  registry; deliberately not built for a single skill that documents our own
  in-app CLI, where independent versioning would only introduce skew between
  the documentation and the binary it describes.
- Whether Grok Code (not yet an adapter) honours `.agents/skills` is unverified.
  If it does not, that adapter can fall back to prompt injection without
  affecting this architecture.
