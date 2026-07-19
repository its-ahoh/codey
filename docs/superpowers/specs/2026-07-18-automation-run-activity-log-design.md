# Automation run activity log

Date: 2026-07-18. Status: approved (chat).

## Problem

Automation run records persist only the agent's final response (capped at
`OUTPUT_CAP` = 32k). The rich `ChatStreamEvent` stream produced during a run —
tool calls with inputs/outputs, team worker steps, errors — is discarded by the
no-op sink in `Gateway.runAutomationTurn`. Users cannot see what an automation
actually *did*, only what it said.

## Design

**Capture.** `runAutomationTurn` gains a real sink when a `runId` is supplied:
each `ChatStreamEvent` is formatted into a timestamped text line
(`formatRunLogEvent` in `packages/gateway/src/automations/run-log.ts`) and
appended to a per-run log file. `stream`/`thinking` token events are skipped
(one token per event, redundant with the final output). Per-event payloads
(tool input JSON, tool output) are truncated to 2,000 chars.

**Plumbing.** `AutomationEngine` deps change to `runTarget(a, runId)` and
`resumeTarget(a, answer, runId)`; `execute()` passes `run.runId` to the exec
callback. A resumed run logs to its own new runId (linked via `resumedFrom`).

**Storage.** `~/.codey/automation-runs/<automationId>/<runId>.log`, plain text,
append-only. `AutomationStore.appendRunLog / readRunLog`; the directory is
removed together with the run history on `delete()`. Log write failures never
fail the run.

**Surface.** `Gateway.getAutomationRunLog(id, runId)` → Mac app IPC
`automations:runLog` → preload → renderer. In `AutomationOnePager`'s Runs tab
each run row gets a lazy "Full log" expander rendering the log in a scrollable
monospace block; runs without a file show "No activity log for this run."

## Out of scope

Capturing the agent CLI's internal session transcript (not visible to Codey's
adapters), log rotation/caps beyond per-event truncation, daemon HTTP API
exposure (Mac app reads via in-process gateway; files are shared under
`~/.codey` either way).
