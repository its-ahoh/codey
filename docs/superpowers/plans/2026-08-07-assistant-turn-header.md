# Assistant Turn Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each assistant turn a metadata header above a hairline rule, and render the reply as document flow — so long replies stop reading as a dense wall without losing the turn's identity and boundary, which is what the reverted first attempt got wrong.

**Architecture:** Three pieces. `turnHeaderModel.ts` holds the pure formatting logic and is unit-tested. `TurnHeader.tsx` is the presentational component. `ChatTab.tsx` swaps the assistant bubble for document flow, mounts the header, moves `tsRight` out of the footer, and hands the thinking disclosure to the header. `Markdown.tsx` regains the two typographic densities by cherry-pick from the reverted branch.

**Tech Stack:** React 18 + TypeScript, inline styles, `react-markdown` + `remark-gfm`, Vite, Vitest, Electron.

**Spec:** `docs/superpowers/specs/2026-08-07-assistant-turn-header-design.md`

**Node version:** this repo needs nvm's v22.17.1. Prefix every command with
`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.17.1 >/dev/null`.
The system default v16 cannot run vitest or tsc here.

**Worktree:** `/Users/jackou/Documents/projects/codey/.worktrees/turn-header`, branch `feat/assistant-turn-header`, cut from the post-revert main (`493b844`).

---

## What is different from last time

The previous attempt shipped on "typecheck clean, 322 tests passing" and was reverted hours later for a defect no automated check could catch. Two concrete changes:

1. **There is real logic here, and it gets real tests.** `turnHeaderMeta` is pure with concrete failure modes. Task 3 is genuine TDD — failing test first.
2. **Task 7 is a blocking human review, not a formality.** The plan is not complete until it is done. Do not report success on the strength of the test suite.

Still true from last time: no tests asserting that a style constant equals itself.

## File Structure

- **Create** `codey-mac/src/components/turnHeaderModel.ts` — pure formatting: `turnHeaderMeta()` and `formatTokens()`. No React. Follows the house pattern (`automationsModel.ts`, `notificationLogic.ts`, `flowEditorModel.ts`: logic extracted from a component into a `*Model`-style module so it can be tested).
- **Create** `codey-mac/src/components/turnHeaderModel.test.ts` — its tests.
- **Create** `codey-mac/src/components/TurnHeader.tsx` — the presentational header row + rule.
- **Modify** `codey-mac/src/components/Markdown.tsx` — restored by cherry-pick, not rewritten.
- **Modify** `codey-mac/src/components/ChatTab.tsx` — container split, header mount, footer slimming, `LiveActivity` move, thinking disclosure handover.
- **Modify** `codey-mac/src/App.tsx` — one CSS rule.

`ChatTab.tsx` is 3265 lines and does too much. New code goes in new files; splitting the rest is out of scope.

---

### Task 1: Recover the typographic densities

The `Markdown.tsx` work from the reverted attempt was reviewed twice, verified byte-equivalent on the `compact` path, and was **not** the reason for the revert. Recover it rather than retyping it.

**Files:**
- Modify: `codey-mac/src/components/Markdown.tsx`

- [ ] **Step 1: Cherry-pick the four commits**

```bash
git cherry-pick 81cd2d1 1203888 483eb23 81519e9
```

In order these are: add `layout` prop + `METRICS`; fix code-review findings (`blockGap` rename, `satisfies`, `CodeBlock` and table margins threaded); give the table its own `tableGap` so `compact` stays byte-equivalent; move the density doc comment onto `METRICS`.

If any conflicts: `Markdown.tsx` at `493b844` is identical to `e35e536`, which is what these commits were written against, so there should be none. If one appears, stop and report rather than resolving creatively.

- [ ] **Step 2: Confirm compact is unchanged**

```bash
git diff e35e536 HEAD -- codey-mac/src/components/Markdown.tsx | grep -E '^\-' | grep -E '1\.55|fontSize: 13|8px|10px'
```

Read the output. Every removed hardcoded value must reappear in `METRICS.compact`: `fontSize: 13`, `lineHeight: 1.55`, `blockGap: 8`, `tableGap: 10`, `li: 2`, `hr: '10px 0'`, h1 `17/'8px 0 6px'`, h2 `15/'8px 0 6px'`, h3 `14/'8px 0 4px'`, h4 `13/'6px 0 4px'`, `CodeBlock` `6px 0 8px`. This invariant is what lets the other sixteen `<Markdown>` call sites go unverified.

- [ ] **Step 3: Verify**

```
cd codey-mac && npx tsc --noEmit && npm test
```
Expected: tsc silent, `41 passed`, `322 passed`.

No commit step — the cherry-picks are the commits.

---

### Task 2: Zero the top margin of a turn's first block

**Files:**
- Modify: `codey-mac/src/App.tsx`

Roomy headings carry a 16-22px top margin to open a section. A reply that starts with a heading has nothing above it to separate from, so that margin is dead space. Inline styles cannot express `:first-child`.

- [ ] **Step 1: Add the rule**

In the existing global `<style>` template literal, immediately after:

```
  html, body, #root { height: 100%; margin: 0; background: ${C.bg}; }
```

add:

```
  /* Roomy headings open a section with a large top margin. The first block in a
     turn has nothing above it to separate from, so that margin is dead space. */
  .md-roomy > :first-child { margin-top: 0 !important; }
```

`!important` is required — it overrides an inline style. The selector must be the direct-child form `>`; a descendant selector would also zero the first item of nested lists and blockquotes.

Take care not to introduce a backtick or `${` that breaks the template literal.

- [ ] **Step 2: Verify and commit**

```
cd codey-mac && npx tsc --noEmit && npm test
git add codey-mac/src/App.tsx
git commit -m "style(mac): collapse leading heading margin in roomy markdown"
```

---

### Task 3: The header model (TDD — tests first)

This is the one part of the change with real logic and real failure modes. Write the failing test before the implementation.

**Files:**
- Create: `codey-mac/src/components/turnHeaderModel.ts`
- Create: `codey-mac/src/components/turnHeaderModel.test.ts`
- Modify: `codey-mac/src/components/ChatTab.tsx` (remove its now-duplicate `formatTokens`)

- [ ] **Step 1: Write the failing test**

Create `codey-mac/src/components/turnHeaderModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { turnHeaderMeta } from './turnHeaderModel'
import type { ChatMessage } from '../types'

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', role: 'assistant', content: 'hi', timestamp: 0, ...over,
})

describe('turnHeaderMeta', () => {
  it('joins agent and model as the identity', () => {
    expect(turnHeaderMeta(msg({ agent: 'claude-code', model: 'opus' })).identity)
      .toBe('claude-code · opus')
  })

  it('uses whichever of agent or model is present', () => {
    expect(turnHeaderMeta(msg({ model: 'opus' })).identity).toBe('opus')
    expect(turnHeaderMeta(msg({ agent: 'codex' })).identity).toBe('codex')
  })

  it('reports no identity when neither is known', () => {
    expect(turnHeaderMeta(msg()).identity).toBeNull()
  })

  it('orders stats as duration then tokens', () => {
    expect(turnHeaderMeta(msg({ durationSec: 12, tokens: 3400 })).stats)
      .toEqual(['12s', '3.4k tok'])
  })

  // The orphaned-separator bug: stats are returned as items, never as a
  // pre-joined string, so a missing field cannot leave a dangling '·'.
  it('omits absent stats without leaving a gap', () => {
    expect(turnHeaderMeta(msg({ durationSec: 12 })).stats).toEqual(['12s'])
    expect(turnHeaderMeta(msg({ tokens: 3400 })).stats).toEqual(['3.4k tok'])
    expect(turnHeaderMeta(msg()).stats).toEqual([])
  })

  it('drops a non-finite duration', () => {
    expect(turnHeaderMeta(msg({ durationSec: NaN })).stats).toEqual([])
    expect(turnHeaderMeta(msg({ durationSec: Infinity })).stats).toEqual([])
  })

  it('keeps a zero token count', () => {
    expect(turnHeaderMeta(msg({ tokens: 0 })).stats).toEqual(['0 tok'])
  })

  // formatTokens switches formatting at 10k. Pin both sides so the move out of
  // ChatTab cannot silently change how the count reads.
  it('formats token counts the way the footer did', () => {
    expect(turnHeaderMeta(msg({ tokens: 950 })).stats).toEqual(['950 tok'])
    expect(turnHeaderMeta(msg({ tokens: 3400 })).stats).toEqual(['3.4k tok'])
    expect(turnHeaderMeta(msg({ tokens: 45_000 })).stats).toEqual(['45k tok'])
  })

  it('passes the fallback through', () => {
    const f = { from: 'claude-code(opus)', to: 'codex(gpt-5)' }
    expect(turnHeaderMeta(msg({ fallback: f })).fallback).toEqual(f)
  })

  // Drives the spec's "empty case": nothing to show means the metadata row is
  // not rendered at all, leaving only the rule.
  it('is empty when the message carries no metadata', () => {
    expect(turnHeaderMeta(msg()).isEmpty).toBe(true)
    expect(turnHeaderMeta(msg({ model: 'opus' })).isEmpty).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```
cd codey-mac && npx vitest run src/components/turnHeaderModel.test.ts
```
Expected: FAIL — cannot resolve `./turnHeaderModel`.

- [ ] **Step 3: Implement the model**

Create `codey-mac/src/components/turnHeaderModel.ts`:

```ts
import type { ChatMessage } from '../types'

/** Compact token count: 1200 -> "1.2k", 45000 -> "45k". Moved verbatim from
 *  ChatTab so the header formats exactly as the footer used to. */
export const formatTokens = (n: number): string | null => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export interface TurnHeaderMeta {
  /** `agent · model`, whichever is known, or null when neither is. */
  identity: string | null
  /** Right-side items, already ordered. Returned as items rather than a joined
   *  string so an absent field cannot leave an orphaned separator. */
  stats: string[]
  fallback?: { from: string; to: string }
  /** Nothing to show — the caller renders the rule without a metadata row. */
  isEmpty: boolean
}

export function turnHeaderMeta(msg: ChatMessage): TurnHeaderMeta {
  const identity = [msg.agent, msg.model].filter(Boolean).join(' · ') || null

  const stats: string[] = []
  if (msg.durationSec != null && Number.isFinite(msg.durationSec)) {
    stats.push(`${msg.durationSec}s`)
  }
  if (msg.tokens != null) {
    const tok = formatTokens(msg.tokens)
    if (tok) stats.push(`${tok} tok`)
  }

  return {
    identity,
    stats,
    fallback: msg.fallback,
    isEmpty: !identity && stats.length === 0 && !msg.fallback,
  }
}
```

Note: `formatTokens` here is moved from `ChatTab.tsx:76`, not copied. `ChatContextPanel.tsx:58` has a third copy; leave it alone — deduplicating it is unrelated to this goal.

- [ ] **Step 4: Run the test again**

```
cd codey-mac && npx vitest run src/components/turnHeaderModel.test.ts
```
Expected: PASS, 10 tests.

If `formatTokens` behaves differently from `ChatTab.tsx:76` — read that function and match it exactly rather than adjusting the test. The header must format tokens the same way the footer did.

- [ ] **Step 5: Point ChatTab at the moved function**

Delete `formatTokens` from `ChatTab.tsx:76` and import it instead:

```ts
import { formatTokens, turnHeaderMeta } from './turnHeaderModel'
```

`ChatTab.tsx:497` still uses `formatTokens`; `:2176` is removed in Task 5. No import cycle: `ChatTab` → `turnHeaderModel`, and `turnHeaderModel` imports only types.

- [ ] **Step 6: Verify and commit**

```
cd codey-mac && npx tsc --noEmit && npm test
git add codey-mac/src/components/turnHeaderModel.ts codey-mac/src/components/turnHeaderModel.test.ts codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): add turn header model with token and duration formatting"
```
Expected: `41 passed` becomes `42 passed`, `322 passed` becomes `332 passed`.

---

### Task 4: The header component

**Files:**
- Create: `codey-mac/src/components/TurnHeader.tsx`

- [ ] **Step 1: Write the component**

```tsx
import React from 'react'
import { C } from '../theme'
import { turnHeaderMeta } from './turnHeaderModel'
import type { ChatMessage } from '../types'

interface Props {
  msg: ChatMessage
  /** Rendered only when the turn has thinking to disclose. */
  hasThinking: boolean
  expanded: boolean
  onToggle: () => void
}

/** Identifies an assistant turn and bounds it.
 *
 *  The bubble used to do both jobs. When it was removed, the boundary fell to
 *  spacing alone — an implicit signal competing with the reply's own paragraph
 *  spacing — and the turn's secondary chrome lost the surface that marked it as
 *  belonging to this turn. The rule is an explicit boundary that does not
 *  compete, and the header gives the thinking disclosure a permanent home.
 *
 *  The rule always renders; the metadata row renders only when there is
 *  something to put in it, so a turn with no metadata is a bare hairline rather
 *  than a blank line. */
export const TurnHeader: React.FC<Props> = ({ msg, hasThinking, expanded, onToggle }) => {
  const meta = turnHeaderMeta(msg)
  if (meta.isEmpty && !hasThinking) return <div style={styles.rule} />

  return (
    <div>
      <div style={styles.row}>
        <div style={styles.left}>
          {meta.identity && <span style={styles.identity}>{meta.identity}</span>}
          {hasThinking && (
            <span
              style={styles.chevron}
              onClick={onToggle}
              role="button"
              title={expanded ? 'Hide thinking' : 'Show thinking'}
            >
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </div>
        <div style={styles.right}>
          {meta.fallback && (
            <span
              style={styles.fallback}
              title={`Primary ${meta.fallback.from} failed — answered by fallback ${meta.fallback.to}`}
            >
              ⤷ {meta.fallback.to}
            </span>
          )}
          {meta.stats.length > 0 && <span style={styles.stats}>{meta.stats.join(' · ')}</span>}
        </div>
      </div>
      <div style={styles.rule} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, fontSize: 11, color: C.fg3, marginBottom: 4,
  },
  left: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  right: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  identity: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chevron: { cursor: 'pointer', fontSize: 9, userSelect: 'none', flexShrink: 0 },
  stats: { fontVariantNumeric: 'tabular-nums', opacity: 0.55 },
  fallback: { color: C.yellow },
  rule: { borderTop: `1px solid ${C.border2}`, marginBottom: 8 },
}
```

The chevron sits to the right of the identity, per the design.

- [ ] **Step 2: Verify and commit**

```
cd codey-mac && npx tsc --noEmit && npm test
git add codey-mac/src/components/TurnHeader.tsx
git commit -m "feat(mac): add assistant turn header component"
```

No test for this file — it is markup and style objects, the category the spec explicitly excludes. Its logic lives in `turnHeaderModel`, which is tested.

---

### Task 5: Wire it into ChatTab

The largest task, and the one that failed last time. Work through it in order.

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Hoist the thinking disclosure state**

The header owns the chevron, so the expanded state can no longer live inside `ThinkingBlock`. Next to the existing `expandedSteps` state in the `ChatTab` component, add:

```tsx
const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
```

Keyed by message id. `ThinkingBlock` at `:256` and its team-context uses at `:509` and `:701` are **not** touched — only the single-agent main path at `:2006` is replaced.

- [ ] **Step 2: Split the message container**

Replace the inner `div` opening tag at `ChatTab.tsx:1981-1994` (it begins `minWidth: 0, maxWidth: '72%', padding: '10px 14px',`):

```tsx
              <div style={isUser ? {
                minWidth: 0, maxWidth: '72%', padding: '10px 14px',
                borderRadius: '16px 16px 4px 16px',
                background: C.userBg,
                color: C.onAccent, fontSize: 13, lineHeight: 1.55,
                overflowWrap: 'anywhere', wordBreak: 'break-word',
              } : {
                // The bubble marks "what the user said". An assistant reply
                // reads as a document; the header rule below carries the
                // boundary the bubble used to provide.
                //
                // `ch` resolves against this element's 13px font, so 78ch is
                // ~562px — about 72 characters of the 14px roomy body text, or
                // ~43 Chinese characters. Unlike the old 72%, it does not grow
                // with the window.
                minWidth: 0, width: '100%', maxWidth: 'min(100%, 78ch)',
                // 6px top is the vertical padding the previous attempt dropped
                // when it replaced the bubble's '10px 14px'. Left: 3 (rail) +
                // 12 = the old 1 (border) + 14 (bubble padding).
                padding: '6px 0 0 12px',
                // The rail is always 3px, transparent when unselected, so
                // selecting a turn never shifts the text column sideways.
                borderLeft: `3px solid ${isSelected ? C.accent : 'transparent'}`,
                background: isSelected ? C.accentDim : 'transparent',
                // fontSize/lineHeight stay compact: non-Markdown children
                // inherit them. Roomy applies inside <Markdown layout="roomy">.
                color: C.fg, fontSize: 13, lineHeight: 1.55,
                overflowWrap: 'anywhere', wordBreak: 'break-word',
                transition: 'border-color 0.18s ease, background 0.18s ease',
              }}>
```

Also change `marginBottom: 12,` at `:1974` to `marginBottom: isUser ? 12 : 20,`.

- [ ] **Step 3: Mount the header and move LiveActivity below the rule**

Replace the `LiveActivity` block at `:1995-1997`:

```tsx
                {!isUser && (
                  <TurnHeader
                    msg={msg}
                    hasThinking={!!msg.thinking?.trim()}
                    expanded={!!expandedThinking[msg.id]}
                    onToggle={() => setExpandedThinking(p => ({ ...p, [msg.id]: !p[msg.id] }))}
                  />
                )}
                {!isUser && !!msg.thinking?.trim() && expandedThinking[msg.id] && (
                  <div style={styles.thinkingBody}>{msg.thinking}</div>
                )}
                {!isUser && !!flight && msg === lastMsg && (
                  <LiveActivity toolCalls={msg.toolCalls} />
                )}
```

The header comes first, then the disclosed thinking, then live activity — activity is turn *content*, not turn identity.

Add the import at the top of the file:

```tsx
import { TurnHeader } from './TurnHeader'
```

- [ ] **Step 4: Remove the old inline ThinkingBlock from the main path**

At `:2005-2011` (inside `if (!parsed) return (`), delete the `{msg.thinking && (<ThinkingBlock ... />)}` block, leaving:

```tsx
                  if (!parsed) return (
                    <div>
                      <Markdown variant="assistant" layout="roomy">{text}</Markdown>
                    </div>
                  )
```

Leave the `ThinkingBlock` component definition and its two team-context uses in place.

- [ ] **Step 5: Slim the footer**

At `:2156`, `tsLabel` currently holds the timestamp plus the whole `tsRight` span (model badge, fallback badge, `tokens · duration`). Every item in `tsRight` is assistant-only and now lives in the header. Delete the `tsRight` span entirely, leaving:

```tsx
              <div style={styles.tsLabel}>
                <span>{fmtTime(msg.timestamp)}</span>
              </div>
```

The timestamp stays in the footer by design. Remove the now-unused `tsRight`, `tsMeta`, `modelBadge`, and `fallbackBadge` style entries **only if** nothing else references them — check with `grep -n 'tsRight\|tsMeta\|modelBadge\|fallbackBadge' ChatTab.tsx` first and leave any that are still used.

- [ ] **Step 6: Verify and commit**

```
cd codey-mac && npx tsc --noEmit && npm test
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): render assistant turns as document flow under a turn header"
```

Expected: tsc silent, all tests pass. `tsc` will catch a missed reference to a deleted style or the removed `formatTokens`.

---

### Task 6: Settle the thinking question

The spec leaves open why the "Show thinking" toggle vanished entirely under the reverted attempt. That must be settled before the visual review can interpret an absent chevron.

**Files:** none unless a defect is found.

- [ ] **Step 1: Establish whether thinking data exists at all**

Run the app, send a prompt to an agent that produces extended thinking, and check whether the chevron appears next to the model in the header.

- [ ] **Step 2: If the chevron does not appear, trace the data**

Do not conclude "the model does not emit thinking" without checking. The chain is: gateway emits a `thinking` stream event → `useChats.tsx:576` dispatches `thinkingToken` → the reducer at `:225-241` accumulates it onto `inFlight` and copies it to the message → the message is persisted with `thinking` (`packages/core/src/types/chat.ts:57`).

Add a temporary `console.log` at `useChats.tsx:576` reporting whether any `thinking` event arrives, and one where the message is finalised reporting whether `thinking` survived. Run once, read the output, then remove the logging.

Report which link is broken. Do not fix it inside this task — if it is a data bug it is a separate change with its own scope.

- [ ] **Step 3: If the chevron appears, say so explicitly**

Then the vanishing was a layout artefact of the reverted attempt and is fixed by construction. Record that, and close the open question in the spec.

---

### Task 7: Visual verification — blocking

**Files:** none.

The previous attempt was reverted for a defect that typecheck and 322 tests could not see. This task is the gate. Do not report the plan complete without it.

```
cd codey-mac && npm run dev
```

(The gateway binds port 3000 — quit a running Codey.app first.)

- [ ] **Step 1: Long reply, dark theme.** Ask for 800+ words with headings, a bulleted list, a fenced code block, and a table. Confirm: the text column stops widening past ~600px; paragraph breaks read as larger than line breaks; headings group with the text below them; the code block and table are wider than before, not clipped.
- [ ] **Step 2: The header itself.** Model and agent on the left, duration and tokens on the right, hairline under them, timestamp still at the bottom. Nothing appears in both header and footer.
- [ ] **Step 3: Streaming.** Watch a turn arrive. The header shows the model immediately; duration and tokens appear on completion without shifting the left side.
- [ ] **Step 4: Thinking.** The chevron sits to the right of the model. Clicking it discloses the thinking between the rule and the reply, and collapses it again.
- [ ] **Step 5: Short reply.** Send something answered in one line. **This is the risk the spec flags** — the header may outweigh the content. Judge honestly.
- [ ] **Step 6: Light theme.** Assistant text now sits on `#f6f7fb` with no white bubble. Confirm the column still reads as anchored and the hairline is visible without being harsh.
- [ ] **Step 7: Selection and boundaries.** Double-click an assistant turn: the accent rail appears and the text does **not** shift sideways. Two consecutive assistant turns read as separate.
- [ ] **Step 8: Untouched surfaces.** Team run panels and the quick-question view are unchanged in size and spacing — that is what the `compact` default protects. Team messages still show their own thinking blocks.
- [ ] **Step 9: A turn with no metadata.** An older message with no model or tokens shows a bare hairline, not a blank row.

- [ ] **Step 10: Report what you saw**, per step, including anything that read poorly. If step 5 or 6 is bad, the spec's fallback is a very subtle background on the assistant column — not restoring the bubble. Raise it rather than applying it unilaterally.

---

## Rollback

Each task is a separate commit. Reverting Task 5's commit restores bubbles while keeping the header component, the model, and its tests on the branch.
