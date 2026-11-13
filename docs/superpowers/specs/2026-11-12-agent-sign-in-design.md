# In-app agent sign-in

Date: 2026-11-12
Status: implemented, not committed; never run in the real app, real expired login not verified

## Problem

When an agent CLI's login has expired or was never done, the turn fails with the
CLI's raw error and the user has to leave Codey, open a terminal, run the CLI's
login command, come back and send the message again. Only Grok recognises the
case at all, and it still answers with "Run `grok login`"
(`packages/core/src/agents/grok.ts`, `grokErrorMessage`).

## Goal

A turn that failed because the agent is signed out shows a **Sign in** card in
the chat. One click runs the CLI's own login from inside Codey; the browser page
opens as usual; when login succeeds the failed message is re-run automatically.

Codey never implements a login protocol and never reads, stores or moves a
token. It runs the same command the user would type.

## Scope

In: Claude Code and Codex. Mac app chat, Settings → Agents, and a one-line hint
on channels.

Out (later, same shape): opencode, pi, cursor, grok. Logging out from Codey.
Warning before a login expires. Any login on a headless gateway with no Mac app.

## The two CLIs

| | Status | Login |
|---|---|---|
| claude-code | `claude auth status` → JSON, `loggedIn: boolean` | `claude auth login` |
| codex | `codex login status` → text, "Logged in using …" / exit code | `codex login` |

Checked against claude 2.1.322 and codex-cli 0.167.0 on 2026-11-12, signed in
and signed out (throwaway `CLAUDE_CONFIG_DIR` / `CODEX_HOME`):

- `claude auth status`: JSON on stdout, `loggedIn` true (exit 0) / false (exit 1).
- `codex login status`: one line on **stderr**, "Logged in using ChatGPT"
  (exit 0) / "Not logged in" (exit 1).
- A signed-out run fails with "Not logged in · Please run /login" (claude) and
  "401 Unauthorized: Missing bearer or basic authentication in header" (codex).

## Design

### 1. Detecting "signed out" — `packages/core/src/agents/agent-auth.ts` (new)

One table, keyed by agent, holding everything agent-specific:

```ts
interface AgentAuthSpec {
  statusCommand: string[]                      // argv after the binary
  parseStatus(stdout: string, code: number | null): boolean | null  // null = could not tell
  loginCommand: string                         // shell command for the login runner
  authErrorPattern: RegExp                     // failure text that means "sign in again"
  usesOwnLogin(request: AgentRequest, env: NodeJS.ProcessEnv): boolean
}
```

`checkAgentAuth(agent, request)` returns `'signed-out' | 'ok' | 'unknown'`:

1. Agent has no spec → `'unknown'`.
2. `usesOwnLogin` is false → `'ok'`. This is the API-key case: the model carries
   an `apiKey`, or the adapter env (after `applyModelEnv` and `extraEnv`) holds
   `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` for claude-code or
   `OPENAI_API_KEY` for codex. A bad key is not a login problem and must keep
   showing its own error.
3. Run the status command with the same env and cwd the adapter used (so
   `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides are honoured), 10 s timeout.
   `parseStatus` false → `'signed-out'`.
4. Status says signed in (or could not tell) but the failure text matches
   `authErrorPattern` → `'signed-out'`. The status command only reads local
   state; a token revoked on the server still reads as signed in, so the text
   check is a required second signal, not a fallback.
5. Otherwise `'ok'`.

The check runs only after a failed run, never before a run. A signed-in user
pays nothing.

`AgentResponse` gains `authRequired?: { agent: CodingAgent }`.

### 2. Gateway — `runWithFallback`

After the primary agent fails (and the turn was not aborted), call
`checkAgentAuth`. On `'signed-out'`, set `response.authRequired`.

Fallback keeps working as today:

- A fallback agent answers → the user gets that answer. `authRequired` rides on
  the existing `fallback` metadata so the fallback badge can offer Sign in. No
  auto-retry: the question was answered.
- No fallback, or every fallback fails → the turn ends failed with
  `authRequired` on the `done` event (`failed: true`). This is the card case.

`ChatStreamEvent` `done` and `botEnd` carry `authRequired`. `GrokAdapter` keeps
its text for now; it joins the table when Grok is brought in scope.

### 3. Login runner — `codey-mac/electron/agent-login.ts` (new)

Modelled on `agent-update.ts`: same interactive login shell
(`$SHELL -i -c <loginCommand>`), so PATH matches the install probe. The
differences:

- Runs in a PTY (`node-pty`, already bundled), because login commands may
  prompt, and print a URL or a code when the browser cannot open.
- At most one login per agent at a time; a second request joins the first.
- Emits progress to the renderer: `starting` → `waiting` (with any `https://`
  URL seen in the output, so the card can show an "Open page" link) →
  `succeeded` | `failed` | `cancelled`.
- Success is decided by re-running the status command, not by the exit code
  alone.
- Timeout 5 minutes, then the process is killed and the result is `failed`.
- `cancel(agent)` kills the PTY.
- "Take over in Terminal": the card can hand the live PTY to the Terminal panel
  through `TerminalSessionManager`, so the user can type a pasted code or pick
  an option. If adopting a live PTY proves awkward in the manager, the
  acceptable fallback is: cancel the hidden run and start the login command in
  a fresh Terminal panel session.

IPC: `agents:authStatus` (all in-scope agents), `agents:login(agent)`,
`agents:loginCancel(agent)`, event `agents:loginProgress`.

### 4. Chat card — renderer

A failed message with `authRequired` renders a card instead of the raw error:

- idle: "Claude Code is signed out." + **Sign in**
- running: "Waiting for sign-in in your browser…" + Open page (when a URL is
  known) + Take over in Terminal + Cancel
- succeeded: "Signed in. Running your message again…"
- failed: reason (tail of output) + **Try again**

The raw CLI error stays available behind a disclosure for debugging.

**Auto-retry.** On `succeeded`, the renderer re-sends the user message that
produced the failed turn, through the existing explicit-retry route so it keeps
its original destination (task, bot), and without adding a second user bubble.
Rules:

- Once per card. A retry that fails with `authRequired` again shows a new card
  and does not loop.
- Skipped if the user has sent another message in that chat since the failure,
  or if the chat is busy; the card then shows a manual **Run again** button.
- Several failed chats waiting on the same agent each retry their own message.

### 5. Settings → Agents

Each in-scope agent row shows "Signed in" / "Signed out" / "Using API key" next
to the version, with a **Sign in** button when signed out. Status is fetched
with the row's existing install/update probe and refreshed after a login.

### 6. Teams

A worker whose turn ends with `authRequired` is the only one stopped; other
workers carry on, matching the existing rule for a single bot asking a question.
Its `botEnd` carries `authRequired`, the card appears on that worker's message,
and after sign-in that worker's step is re-run through the same resume path a
failed step uses today. A team is not reported complete while such a card is
unresolved.

### 7. Channels (Telegram / Discord / iMessage)

No login can be driven from a phone. The reply is one line: "<Agent> is signed
out. Open Codey on your Mac and choose Sign in." No auto-retry. On a gateway
with no Mac app the line names the CLI command instead.

## Error handling

- Status command missing, times out, or prints something unparsable → `'unknown'`
  → text pattern decides; if that does not match, behave exactly as today.
- Login command not found → card shows the failure with the command that was
  tried.
- App quits mid-login → PTY is killed with the app; the card returns to idle on
  next launch (card state is not persisted beyond `authRequired` on the message).
- Never log or surface status output verbatim: it contains the account email and
  organisation. Only `loggedIn` is read.

## Testing

- `agent-auth.test.ts`: `parseStatus` for both agents against captured outputs;
  `usesOwnLogin` for API-key, base-URL-only and `extraEnv` cases; the
  status-says-ok-but-text-says-auth case.
- Gateway: fake adapter failing with an auth error → `authRequired` set; with an
  API key → not set; with a successful fallback → answer delivered, badge
  carries `authRequired`.
- `agent-login.test.ts`: fake CLI scripts for success, failure, URL-printing,
  timeout, cancel, and two concurrent requests joining one run. No test depends
  on `process.platform`.
- Renderer: card state reducer; auto-retry fires once; skipped when a newer user
  message exists.

Not testable here: a real expired login, without signing the developer out. It
needs one manual pass in the packaged app with a throwaway `CLAUDE_CONFIG_DIR` /
`CODEX_HOME`.

## What changed while building

- Auto-retry goes through the normal resend route, so it adds a second user
  bubble. That route appends a turn on purpose; the transcript stays honest.
- A card on a turn the user has since replied past is passive: it says the
  agent was signed out and offers no button.
- A card that was not on screen during the login (another chat waiting on the
  same agent) shows **Run again** instead of running by itself.
- Teams keep today's failure behaviour. The gateway has no "re-run one failed
  step" path, so the card re-sends the message that started the team run.
- "Take over in Terminal" cancels the hidden login and types the same command
  into a Terminal panel tab.
- Channels get one fixed line naming both ways out (Mac app, CLI command); the
  gateway does not try to detect whether a Mac app is attached.
- `usesOwnLogin` takes only the resolved env.
