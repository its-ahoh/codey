# Solo Advisor (single-chat 兜底) — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm), pending implementation plan

## Goal

A per-chat toggle. When on, if the single agent (single-worker / single-model mode,
*not* a team) reports it is stuck — or notices it is repeating the same failed
approach across turns — the gateway escalates to the stronger **advisor** model for
*guidance only*, then lets the original agent continue with that guidance injected.

This is distinct from two existing mechanisms:

- **`runWithFallback`** triggers only on a *hard* failure (agent returns non-success)
  and swaps to a different agent/model to redo the work. Solo Advisor triggers on a
  *soft* "I can't make progress" signal and keeps the original agent in the driver's
  seat.
- **Team Advisor** (`runAdvisor` / parallel advisor) is a *coordinator* that picks
  workers from a roster and never writes code. Solo Advisor has no roster — it gives
  one stuck agent targeted guidance.

## Decisions (from brainstorming)

- **Trigger:** automatic (no manual button).
- **Detection:** the agent self-reports it cannot proceed, and/or recognizes it is
  going in circles. Hard-failure detection is intentionally *out of scope* — that is
  already covered by `runWithFallback`.
- **Advisor role:** gives guidance only (never writes code); the original agent
  continues.
- **Advisor model:** reuse the existing `gateway.json` `advisor.{agent, model}` via
  `getAdvisorAgentAndModel()`. No new config key.
- **Toggle scope:** per-chat.
- **Detection mechanism:** signal injection (approach A below), not an LLM classifier.
- **Escalation cap:** up to **2** advisor rounds per turn.

## Detection mechanism — signal injection

When `chat.soloAdvisor === true`, inject a small instruction into the chat prompt:

> If you cannot make progress, or you notice you are repeating the same failed
> approach across turns, end your reply with a single line
> `[ASK_ADVISOR]: <brief description of where you are stuck>`.

The agent already has conversation context (last ~10 messages), so it can recognize
its own repetition ("原地踏步"). After the agent responds we parse `output` for the
marker. This reuses the existing `[ASK_USER]` / `parseAsk` convention in this
codebase, costs **zero** extra LLM calls on the happy path, and avoids brittle
text-matching or a per-turn classifier.

## Components

### 1. Config / state

- Add `soloAdvisor?: boolean` to the `Chat` type (`packages/core/src/types/chat.ts`),
  default off (undefined ⇒ off). Lives alongside the per-chat `agent` / `model`
  overrides.
- Advisor model resolved via existing `getAdvisorAgentAndModel()`.

### 2. Prompt injection

- Only when `chat.soloAdvisor === true`, append the `[ASK_ADVISOR]` self-assessment
  instruction to the single-agent prompt. Implemented as a small helper in
  `packages/gateway/src/chat-runner.ts`, mirroring how worker prompts append the
  `[ASK_USER]` instruction in `packages/core/src/workers.ts`.

### 3. Parser

- New `parseAskAdvisor(text)` in core (sibling to `parseAsk` / `parseAskUser`),
  returning `{ reason: string } | null`. Matches a line `[ASK_ADVISOR]: <reason>`.
  The marker is always stripped from the final user-visible message.

### 4. Solo advisor prompt + runner

- New lightweight `buildSoloAdvisorPrompt(input)` in core, distinct from the team
  `buildAdvisorPrompt` (no roster). Input: original task, the stuck agent's output,
  the stuck reason. Output contract: plain-text guidance, explicitly *no code*.
- Reuse the gateway's existing `advisorRunner` / `getAdvisorAgentAndModel()` to run it
  through `runWithFallback`.

### 5. Escalation loop

In the single-agent branch (`packages/gateway/src/gateway.ts`, ~line 3868–3924),
when the toggle is on:

1. Run the agent normally.
2. Parse `output` for `[ASK_ADVISOR]: <reason>`.
3. If found and rounds-used < 2:
   a. Call the advisor model → plain-text guidance.
   b. Stream the guidance to the UI as a 🧭 Advisor note (reuse existing Advisor
      styling).
   c. Re-run the original agent with the guidance injected as extra context;
      increment rounds-used; go to step 2.
4. **Cap: up to 2 advisor rounds per turn.** If the agent still signals stuck after
   the 2nd round, strip the marker and surface its message to the user normally
   (no infinite loop / token blowup).

### 6. UI (codey-mac)

- A small per-chat toggle (🧭) near the existing per-chat agent/model controls,
  persisting `chat.soloAdvisor`. Follows the existing per-chat control pattern.

## Error handling

- Advisor call fails or times out → skip escalation, return the agent's original
  output (graceful degradation, same philosophy as `runWithFallback`).
- The `[ASK_ADVISOR]` marker is always stripped from the final user-visible message,
  whether or not escalation succeeded.
- Toggle off ⇒ no prompt injection, no parsing, zero behavior change.

## Data flow

```
user msg (chat.soloAdvisor = true)
   │
   ▼
single agent  ──(prompt has [ASK_ADVISOR] instruction)──► output
   │
   ▼
parseAskAdvisor(output)?
   │ no → surface output to user (marker absent)
   │ yes, rounds < 2
   ▼
advisor model (stronger)  ──► plain-text guidance ──► UI 🧭 note
   │
   ▼
re-run single agent with guidance injected ──► output ──► back to parse
   (after 2 rounds: strip marker, surface to user)
```

## Testing

Core unit tests:

- `parseAskAdvisor`: positive, negative, multiline, marker stripping.
- `buildSoloAdvisorPrompt`: includes task / stuck output / reason; instructs
  guidance-only.
- Escalation cap: agent that always signals stuck escalates exactly twice, then
  surfaces.
- Toggle off: no injection, no parsing.

## Out of scope (YAGNI)

- Hard-failure detection (covered by `runWithFallback`).
- A separate model config for solo advisor (reuse team advisor config).
- Manual "ask advisor" button.
- Cross-turn persistent stuck counters beyond what the agent infers from context.
