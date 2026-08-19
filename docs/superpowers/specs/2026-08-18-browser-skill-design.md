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

### Discovery: an installed skill

- `packages/core/src/skills/browser/SKILL.md` holds the text — plain markdown,
  copied into `dist/skills` at build time so `__dirname/../skills` resolves
  identically from source and from a packaged app.
- `installBrowserSkill()` copies it into `~/.codey/skills/browser/`, the user's
  own global skill root, which the existing `syncCodeyGlobalSkills()` already
  links into `.claude/skills` and `.agents/skills`.
  `uninstallBrowserSkill()` deletes the directory.
- Both run **only for an explicit user action**. Codey never rewrites the
  directory behind the user's back, which is what makes the Skills tab's own
  on/off and delete hold.

### Why install, not a toggle

A first pass had Codey own the skill: a `~/.codey/managed-skills` root, rewritten
and removed on every agent run to follow a plugin switch. It worked, and the UX
was incoherent. The skill was linked into the same directories the Skills tab
scans, so it appeared there as an ordinary skill — with a delete button that
`syncCodeyGlobalSkills()` undid on the next run, and an on/off toggle that
renamed `SKILL.md` to `SKILL.md.disabled` only for the next install to write
`SKILL.md` back beside it. Two controls for one capability, and the more
obvious one silently lost.

The cause was the middle state: a thing that lives in the user's skill
directories but is not the user's. Removing that state removes the conflict.
The Plugins tab now installs and uninstalls; between those two moments the
skill is an ordinary user-owned skill, and the Skills tab is the only place
that acts on it. Both tabs read the same directory, so they cannot disagree.

This is also the interaction model users already have from `npx skills add`,
package managers and editor extensions, and it is the prerequisite for ever
serving plugins from a registry: the state machine does not change when the
source of the copy stops being the app bundle.

### State, read from disk

`browserSkillStatus()` reports `absent` (not installed), `disabled` (installed,
switched off in Skills) or `installed`, plus `updateAvailable` when the copy on
disk differs from the one this build ships. There is no enabled flag in config:
the Plugins tab, the Skills tab and a hand-run `rm` all write the same
directory, and a second source of truth could only ever contradict it.

`gateway.json`'s `plugins.browser.enabled` survives as a legacy marker, read
once at startup: a user who had the plugin on before this change gets the skill
installed for them rather than losing the capability silently.

### Capability: the environment

`addCodeyBrowserTools()` (the name the pre-MCP function had, restored) puts
`CODEY_BROWSER_{SOCKET,TOKEN,CLI,RUNTIME,CHAT_ID}` into `request.extraEnv`
under the unchanged gating chain: the skill installed and enabled, bridge
present, `browserTools === true`, a working directory, and no `allowedTools`.
All four
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

Disabling the skill in the Skills tab also stops the env, because the gate asks
for `installed` specifically. An agent holding bridge credentials for a skill it
cannot read would be harmless — it does not know the command exists — but it is
a state no user action asked for.

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
- **Upgrades no longer update the text by themselves.** The copy is the user's,
  so Codey must not overwrite it; instead the Plugins card compares it with the
  bundled one and offers Update when they differ. The failure this guards
  against is a stale copy documenting commands the shipped CLI no longer has.

## Verification

- pi, unmodified, discovered the installed skill, ran the CLI, and reported a
  page back through the bridge — the browser reached an agent that cannot use
  MCP at all.
- The four state transitions, driven through the same functions the IPC calls:
  install → `installed`; disable in Skills → `disabled` and the capability gate
  reads inactive; install again → active with no `SKILL.md.disabled` left
  behind; uninstall → `absent`, and the next sync drops both discovery links.
- The markdown survives packaging: present in the built app's asar under
  `node_modules/@codey/core/dist/skills`, and installing from the compiled
  `dist` writes and links identical bytes.
- Full suite green (core 538 / gateway 328 / mac 571); build and lint pass.

Not covered: a run against the real in-app bridge with the plugin installed,
and the Plugins tab's own buttons. The verification above used a stand-in
bridge, because the real token never leaves the app process's memory, and
drove the IPC handlers' functions rather than the rendered UI.

## Follow-ups

- The installed copy comes from the app bundle, not a remote repo. Serving it
  from a registry would let it update out of band, which is exactly the problem:
  the skill documents an in-app CLI, so an independently-versioned copy can
  describe commands the installed app does not have. Worth revisiting once
  there are plugins that do not wrap an in-app binary.
- The one-time startup migration (install for a user who had the old config
  flag on, and delete the `~/.codey/managed-skills` root a development build
  left behind) can be dropped a release or two after it ships.
- Whether Grok Code (not yet an adapter) honours `.agents/skills` is unverified.
  If it does not, that adapter can fall back to prompt injection without
  affecting this architecture.
