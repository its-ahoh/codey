# Status Sidecar — collapsed-panel rail

**Date:** 2026-06-13
**Component:** `codey-mac` chat view (`ChatTab`)

## Problem

When the right context panel is closed, the right edge of the chat is empty. A
person opening a chat has no at-a-glance sense of what the session is doing —
current goal, status, what's next, recent activity. Opening the full panel is
the only way to see the Task HUD.

## Goal

Show a slim, always-visible "sidecar" rail on the right when the panel is
**closed**, presenting a *light* version of the Status (Task HUD) tab. Opening
the panel reveals the full version. The sidecar is a second, condensed view of
the **same** task brief — not a separate data source.

## Single-brief principle

The Status tab renders `chat.taskBrief` (a single `TaskBrief` object, see
`packages/core/src/types/chat.ts`) through `TaskHud`. The sidecar reads that
**same** `chat.taskBrief` and renders an extracted subset. There is exactly one
brief and one generation path (`generateTaskBrief`); the sidecar adds a second
*view*, never a second brief.

## Scope of the light view

Fixed-width (~220px) vertical rail showing, extracted from `chat.taskBrief`:

1. **Goal** — `brief.goal`, clamped to 2 lines.
2. **Status + progress** — a status pill (`statusMeta(brief.state.status)`) and
   `brief.state.progress%`.
3. **Next Action** — `brief.nextAction.text` if present, one clamped line,
   visually emphasized.
4. **Recent missions** — the 2–3 newest `brief.timeline` entries (text +
   `formatAgo(when)`), styled as a condensed timeline.

## Components & boundaries

- **`extractSidecarBrief(brief: TaskBrief): SidecarView`** — pure function in
  `src/components/taskHudView.ts` (alongside `statusMeta`, `formatAgo`,
  `splitTimeline`). Maps a full brief to the light view shape:
  `{ goal, status, progress, nextActionText?, recent: { text; when? }[] }`.
  Caps `recent` at 3. Unit-tested in `taskHudView.test.ts`.
- **`StatusSidecar`** — new presentational component
  (`src/components/StatusSidecar.tsx`). Props: `view: SidecarView`,
  `loading: boolean`, `onOpen: () => void`. Renders the rail; the whole rail is
  a single click target calling `onOpen`. No data fetching, no brief logic.
- **`ChatTab`** — mounts `StatusSidecar` in the same right-side slot where the
  panel renders, but **only when `panelOpen === false`**. Panel and sidecar are
  mutually exclusive. `onOpen` does
  `setContextPanelOpen(chat.id, true)` + `setPanelTab('task')`.

## Layout & visibility

- Rendered in `ChatTab`'s flex row after the conversation column, in an
  `else` branch of the existing `panelOpen` block.
- Reuse the panel's width guard: if the window is too narrow to fit chat list +
  a usable conversation column + the rail, render nothing (same thresholds the
  panel uses, with the rail's ~220px instead of `MIN_PANEL`).
- Styling: `borderLeft: 1px solid C.border`, `background: C.surface2`, matching
  the panel's frame so toggling feels continuous.

## Self-population (resolves empty-state)

`taskBrief` is today generated only while the panel is open on the Status tab
(`onTaskTabShown` and the turn-boundary effect, both gated on
`panelTab === 'task'`). Without a trigger, the sidecar would never appear.

The sidecar self-triggers the **same** `generateTaskBrief(chat.id)` call:

- **When:** the sidecar is mounted (panel closed + wide enough) AND the chat has
  at least one assistant message AND `isTaskBriefStale(chat)` is true.
- **Fire points:** (a) when the sidecar first becomes visible and is stale; and
  (b) on turn-completion boundary while the sidecar is visible — mirroring the
  panel's existing turn-boundary effect but gated on *sidecar visible* instead
  of `panelTab === 'task'`. Keyed off the `turnActive` boolean (not `flight`)
  to avoid per-token churn.
- **Guards:** never fire while a generation is already in flight
  (`taskBriefLoading`); never fire mid-stream (wait for the turn to settle).
  Reuses the existing `taskBriefLoading` state so panel and sidecar don't
  double-generate.
- **Empty/loading display:** while no brief exists yet and a generation is
  running, the rail shows a minimal "Summarizing…" shimmer rather than an empty
  card or an "Open status" prompt. If the chat has no assistant turns at all,
  the sidecar renders nothing (true hide).

## Click behavior

Clicking anywhere on the sidecar opens the full panel on the Status tab. No
per-row targeting in this version (YAGNI).

## Testing

- Unit-test `extractSidecarBrief`: goal/status/progress pass-through, next
  action present/absent, `recent` capped at 3 and newest-first, empty timeline.
- Existing `taskHudView.test.ts` patterns are the template.
- No new e2e; visual placement verified manually.

## Out of scope

- Per-mission click targeting / scroll-to-step from the rail.
- Resizable sidecar width.
- A separate "light brief" generation or any second Aide call.
- Changing the panel itself.
