# Status Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a slim "sidecar" rail on the right of the chat when the context panel is closed, rendering a light version of the Status (Task HUD) tab from the same `chat.taskBrief`.

**Architecture:** A pure extractor (`extractSidecarBrief`) maps the existing `TaskBrief` to a condensed `SidecarView`. A presentational `StatusSidecar` renders that view as a ~220px rail. `ChatTab` mounts the rail in the right slot only when the panel is closed, and self-triggers the existing `generateTaskBrief` call when the rail is visible and the brief is stale — one brief, two views.

**Tech Stack:** React 18 + TypeScript, Vitest, inline-style components (existing codebase convention). All work is in `codey-mac/`.

**Working directory for all commands:** `/Users/jackou/Documents/projects/codey/codey-mac`. Use Node v22.17.1 (`nvm use 22.17.1` if needed — the default v16 cannot run vitest/tsc).

---

### Task 1: `extractSidecarBrief` pure extractor

Add a condensed view type and a pure function that maps a full `TaskBrief` to it. `timeline` is reverse-chronological (newest first), so the 3 newest are `slice(0, 3)`.

**Files:**
- Modify: `src/components/taskHudView.ts` (append after `splitTimeline`)
- Test: `src/components/taskHudView.test.ts` (append a new `describe`)

- [ ] **Step 1: Write the failing test**

Append to `src/components/taskHudView.test.ts`:

```ts
import { extractSidecarBrief } from './taskHudView';

describe('extractSidecarBrief', () => {
  const tl = (text: string, when?: number) => ({ kind: 'progress' as const, text, when });

  it('passes through goal, status, progress and next action text', () => {
    const v = extractSidecarBrief(brief({
      goal: 'Ship sidecar',
      state: { progress: 42, status: 'waiting' },
      nextAction: { text: 'Answer the question', detail: 'ignored', messageId: 'm1' },
    }));
    expect(v.goal).toBe('Ship sidecar');
    expect(v.status).toBe('waiting');
    expect(v.progress).toBe(42);
    expect(v.nextActionText).toBe('Answer the question');
  });

  it('omits nextActionText when there is no next action', () => {
    const v = extractSidecarBrief(brief({ nextAction: undefined }));
    expect(v.nextActionText).toBeUndefined();
  });

  it('keeps the 3 newest timeline entries, newest first', () => {
    const v = extractSidecarBrief(brief({
      timeline: [tl('a', 5), tl('b', 4), tl('c', 3), tl('d', 2)],
    }));
    expect(v.recent.map(r => r.text)).toEqual(['a', 'b', 'c']);
    expect(v.recent[0].when).toBe(5);
  });

  it('handles an empty timeline', () => {
    const v = extractSidecarBrief(brief({ timeline: [] }));
    expect(v.recent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/taskHudView.test.ts`
Expected: FAIL — `extractSidecarBrief is not a function` (or an import error).

- [ ] **Step 3: Write minimal implementation**

Append to `src/components/taskHudView.ts`:

```ts
/** Condensed view of a TaskBrief for the collapsed-panel Status sidecar. */
export interface SidecarView {
  goal: string;
  status: TaskBrief['state']['status'];
  progress: number;
  nextActionText?: string;
  /** The 3 newest timeline entries (already newest-first in TaskBrief). */
  recent: { text: string; when?: number }[];
}

/** Extract the light Status view from the same brief the panel renders. */
export function extractSidecarBrief(brief: TaskBrief): SidecarView {
  return {
    goal: brief.goal,
    status: brief.state.status,
    progress: brief.state.progress,
    nextActionText: brief.nextAction?.text,
    recent: brief.timeline.slice(0, 3).map(e => ({ text: e.text, when: e.when })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/taskHudView.test.ts`
Expected: PASS (all `describe` blocks, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/components/taskHudView.ts src/components/taskHudView.test.ts
git commit -m "feat(codey-mac): add extractSidecarBrief for Status sidecar"
```

---

### Task 2: `StatusSidecar` presentational component

A ~220px vertical rail. Whole rail is one click target calling `onOpen`. No data fetching — props only. Mirrors `TaskHud` styling at a smaller scale (tone pill, clamped goal, condensed recent list).

**Files:**
- Create: `src/components/StatusSidecar.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/StatusSidecar.tsx`:

```tsx
import React from 'react'
import { C } from '../theme'
import { statusMeta, formatAgo, type SidecarView, type StatusTone } from './taskHudView'

interface Props {
  view: SidecarView
  /** True while a (re)generation of the brief is in flight. */
  loading: boolean
  /** Open the full panel on the Status tab. */
  onOpen: () => void
  width: number
}

const toneColor = (tone: StatusTone): string =>
  tone === 'yellow' ? C.yellow : tone === 'red' ? C.red : tone === 'green' ? C.green : C.accent

const clamp = (lines: number): React.CSSProperties => ({
  display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden',
})

export const StatusSidecar: React.FC<Props> = ({ view, loading, onOpen, width }) => {
  const sm = statusMeta(view.status)
  return (
    <div
      style={{ ...styles.root, width }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      title="Open status panel"
    >
      <div style={styles.header}>
        <span style={styles.headerLabel}>Status</span>
        {loading && <span style={styles.headerLoading}>updating…</span>}
      </div>

      <div style={styles.goal}>{view.goal}</div>

      <div style={styles.statusRow}>
        <span style={{ ...styles.pill, color: toneColor(sm.tone), background: `${toneColor(sm.tone)}22` }}>{sm.label}</span>
        <span style={styles.progress}>{view.progress}%</span>
      </div>
      <div style={styles.barTrack}>
        <div style={{ ...styles.barFill, width: `${view.progress}%` }} />
      </div>

      {view.nextActionText && (
        <div style={styles.nextBox}>
          <div style={styles.sectionLabel}>Next</div>
          <div style={styles.nextText}>{view.nextActionText}</div>
        </div>
      )}

      {view.recent.length > 0 && (
        <div style={styles.recent}>
          <div style={styles.sectionLabel}>Recent</div>
          {view.recent.map((r, i) => (
            <div key={i} style={styles.recentRow}>
              <span style={styles.dot} />
              <span style={styles.recentText}>{r.text}</span>
              {r.when != null && <span style={styles.recentWhen}>{formatAgo(r.when)}</span>}
            </div>
          ))}
        </div>
      )}

      <div style={styles.footer}>Open panel →</div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100%', background: C.surface2, borderLeft: `1px solid ${C.border}`,
    flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10,
    padding: '12px 12px', overflowY: 'auto', cursor: 'pointer',
  },
  header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
  headerLabel: { fontSize: 10, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: C.fg3 },
  headerLoading: { fontSize: 10, color: C.fg3, fontStyle: 'italic' },
  goal: { fontSize: 13, fontWeight: 600, color: C.fg, lineHeight: 1.35, ...clamp(2) },
  statusRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  pill: { fontSize: 11, padding: '2px 7px', borderRadius: 6 },
  progress: { fontSize: 12, fontWeight: 600, color: C.fg, fontVariantNumeric: 'tabular-nums' },
  barTrack: { height: 4, background: C.surface3, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', background: C.accent, borderRadius: 2 },
  nextBox: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '8px 9px' },
  sectionLabel: { fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: C.fg3, marginBottom: 5 },
  nextText: { fontSize: 12, fontWeight: 600, color: C.fg, lineHeight: 1.4, ...clamp(2) },
  recent: { display: 'flex', flexDirection: 'column' },
  recentRow: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '4px 0' },
  dot: { flex: 'none', width: 6, height: 6, borderRadius: '50%', background: C.green, marginTop: 5 },
  recentText: { flex: 1, minWidth: 0, fontSize: 12, color: C.fg2, lineHeight: 1.4, ...clamp(2) },
  recentWhen: { flex: 'none', fontSize: 10, color: C.fg3, whiteSpace: 'nowrap' },
  footer: { marginTop: 'auto', fontSize: 11, color: C.fg3, paddingTop: 8 },
}
```

- [ ] **Step 2: Verify it compiles (typecheck)**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors referencing `StatusSidecar.tsx` or `taskHudView.ts`. (Pre-existing unrelated errors elsewhere, if any, are out of scope — confirm none mention these two files.)

- [ ] **Step 3: Commit**

```bash
git add src/components/StatusSidecar.tsx
git commit -m "feat(codey-mac): add StatusSidecar presentational rail"
```

---

### Task 3: Mount the sidecar in `ChatTab` + self-population

Render the rail in the right slot only when the panel is closed, behind the same width guard as the panel. Self-trigger the existing `generateTaskBrief` when the rail is visible, the chat has assistant turns, no turn is in flight, the brief is stale, and no generation is already running.

**Files:**
- Modify: `src/components/ChatTab.tsx` (import; add derived `sidecarVisible`; add self-population effect after the existing turn-boundary effect at lines ~403-409; replace the panel render block at lines ~1274-1314)

- [ ] **Step 1: Add the import**

At the top of `src/components/ChatTab.tsx`, next to the existing `import { ChatContextPanel } from './ChatContextPanel'` (line ~10) and `import { isTaskBriefStale } from './taskHudView'` (line ~14):

```tsx
import { StatusSidecar } from './StatusSidecar'
import { isTaskBriefStale, extractSidecarBrief } from './taskHudView'
```

Replace the existing `import { isTaskBriefStale } from './taskHudView'` line with the combined import above (do not leave a duplicate import of `isTaskBriefStale`).

- [ ] **Step 2: Add derived `sidecarVisible` near other derived state**

Immediately after `const panelOpen: boolean = chat?.contextPanelOpen ?? false` (line ~496), add:

```tsx
  // The Status sidecar shows in the right slot when the panel is closed and
  // there's room for it (same width math as the panel block below). It needs
  // at least one assistant turn to have something to summarize.
  const SIDECAR_W = 220
  const sidecarChatListW = windowWidth < 600 ? 180 : 240
  const sidecarFits = windowWidth - sidecarChatListW - 360 >= SIDECAR_W
  const hasAssistantMsg = (chat?.messages ?? []).some(m => m.role === 'assistant')
  const sidecarVisible = !panelOpen && sidecarFits && !!chat && hasAssistantMsg
```

- [ ] **Step 3: Add the self-population effect**

Immediately after the existing turn-boundary effect (the `useEffect` ending at line ~409 with deps `[turnActive, panelTab, chatId]`), add:

```tsx
  // Self-populate the Status sidecar's brief while the panel is closed. Mirrors
  // the panel's turn-boundary refresh but gates on the sidecar being visible
  // instead of the Status tab being open. One brief, two views. Waits for the
  // turn to settle (!turnActive) so we never regenerate mid-stream, and skips
  // when a generation is already running to avoid double-firing with the panel.
  useEffect(() => {
    if (!sidecarVisible || turnActive || taskBriefLoading || !chat) return
    if (!isTaskBriefStale(chat)) return
    setTaskBriefLoading(true)
    generateTaskBrief(chat.id).finally(() => setTaskBriefLoading(false))
  }, [sidecarVisible, turnActive, chatId, chat?.messages.length, chat?.taskBrief?.generatedAt])
```

- [ ] **Step 4: Replace the panel render block with panel-or-sidecar**

Find the block at lines ~1274-1314 that begins with `if (!panelOpen) return null` and ends with the closing `})()}`. Replace the entire IIFE body so it renders the panel when open, else the sidecar:

```tsx
      {(() => {
        const CHAT_LIST_W = windowWidth < 600 ? 180 : 240
        const MIN_MIDDLE = 360

        if (panelOpen) {
          const MIN_PANEL = 260
          const available = windowWidth - CHAT_LIST_W - MIN_MIDDLE
          if (available < MIN_PANEL) return null
          const effectiveWidth = Math.min(panelWidth, available)
          return (
            <ChatContextPanel
              chat={chat}
              selectedTurnId={selectedTurnId}
              followLatest={followLatest}
              selectedTurnIndex={selectedTurnIndex}
              effectiveAgent={effectiveAgent}
              effectiveModel={effectiveModel}
              workerName={panelWorkerName}
              teamName={panelTeamName}
              workingDir={workingDir}
              width={effectiveWidth}
              onFollowLatest={() => setFollowLatest(true)}
              onClose={() => setContextPanelOpen(chat.id, false)}
              onResize={setPanelWidth}
              onRevealFile={(p) => apiService.revealInFolder(p)}
              onScrollToStep={(mid, step) => {
                document.getElementById(stepDomId(mid, step))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}
              isTurnStreaming={!!flight && selectedTurnId === lastMsg?.id}
              activeTab={panelTab}
              onTabChange={setPanelTab}
              qqInputRef={qqInputRef}
              onAnswerNextAction={() => taRef.current?.focus()}
              taskBriefLoading={taskBriefLoading}
              onTaskTabShown={async () => {
                if (!isTaskBriefStale(chat)) return
                setTaskBriefLoading(true)
                try { await generateTaskBrief(chat.id) } finally { setTaskBriefLoading(false) }
              }}
            />
          )
        }

        // Panel closed → light Status sidecar. Hidden until there's a brief to
        // show (self-population kicks it off via the effect above); a bare
        // "summarizing" state is conveyed by the loading flag once a brief lands.
        if (!sidecarVisible || !chat?.taskBrief) return null
        return (
          <StatusSidecar
            view={extractSidecarBrief(chat.taskBrief)}
            loading={taskBriefLoading}
            width={SIDECAR_W}
            onOpen={() => { setContextPanelOpen(chat.id, true); setPanelTab('task') }}
          />
        )
      })()}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors referencing `ChatTab.tsx`, `StatusSidecar.tsx`, or `taskHudView.ts`.

- [ ] **Step 6: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS, including `taskHudView.test.ts`.

- [ ] **Step 7: Manual smoke (optional but recommended)**

Run: `npm run dev`, open a chat with at least one assistant turn, ensure the right panel is **closed**. Expected: a ~220px rail appears on the right showing goal + status/progress + (if any) Next + up to 3 recent items. Clicking it opens the full panel on the **Status** tab. Re-closing the panel shows the rail again. On a narrow window (< ~820px) the rail hides.

- [ ] **Step 8: Commit**

```bash
git add src/components/ChatTab.tsx
git commit -m "feat(codey-mac): show Status sidecar when context panel is closed"
```

---

## Self-Review notes

- **Spec coverage:** light view fields (goal/status/progress/next/recent) → Task 1 + Task 2; mount-when-closed + width guard + click-to-open-Status → Task 3 Step 4; self-population (Option A) with in-flight/mid-stream guards + "updating" affordance → Task 3 Steps 2–3 and the `loading` prop; true-hide when no assistant turns / no brief → `sidecarVisible` + `!chat?.taskBrief` guard.
- **Type consistency:** `SidecarView`, `extractSidecarBrief`, `StatusSidecar` props (`view`/`loading`/`onOpen`/`width`), and `statusMeta`/`formatAgo`/`StatusTone` imports all match across tasks.
- **Note for the implementer:** the plan file lives under `docs/`, which is gitignored in this repo — only the source commits in each task land in git. That is expected.
