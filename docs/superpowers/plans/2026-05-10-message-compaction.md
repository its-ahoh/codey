# Message Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove inline tool-call rendering from the Mac chat view, and render Team Mode messages as collapsible per-step cards with a prominent manager summary.

**Architecture:** Pure frontend change in `codey-mac/src/components/ChatTab.tsx`. Add a small parser module `teamMessageFormat.ts` that detects the `formatManagerParts` output shape (`🧭 Manager summary:` + `### Step N:` chunks) and returns structured data. ChatTab uses the parser to switch between plain Markdown and a custom card layout. The right Context Panel (`ChatContextPanel.tsx`) already shows tool calls and is unchanged.

**Tech Stack:** React + TypeScript, existing `Markdown` component, no new deps.

**Spec:** `docs/superpowers/specs/2026-05-10-message-compaction-design.md`

---

## File Map

- **Create:** `codey-mac/src/components/teamMessageFormat.ts` — parser + preview extractor.
- **Create:** `codey-mac/src/components/teamMessageFormat.test.ts` — unit tests for the parser.
- **Modify:** `codey-mac/src/components/ChatTab.tsx`
  - Remove inline tool-call rendering block (`:539-605`).
  - Remove `expandedIds` state (`:101`) and the `toolFormat` import (`:7`) once unreferenced.
  - Remove dead style entries (`toolCallsContainer`, `toolCallRow`, `toolCallInfo`, `toolCallSep`, `chevron`, `toolDetail`).
  - Add team-message card rendering using the new parser.
  - Add per-step collapse state.

The right Context Panel's auto-open effect (`:190-197`) stays — it is now the only entry point to tool detail.

---

## Test setup note

`codey-mac` does not currently have a test runner. Add one in Task 1 (Vitest, since the project uses Vite) so the parser is testable. If the maintainer prefers no tests in this package, skip Task 1 and Task 2's test file — the parser is small enough to verify by hand.

---

## Task 1: Add Vitest to codey-mac

**Files:**
- Modify: `codey-mac/package.json`
- Create: `codey-mac/vitest.config.ts`

- [ ] **Step 1: Install Vitest**

```bash
cd codey-mac && npm install --save-dev vitest
```

- [ ] **Step 2: Add `test` script to package.json**

In `codey-mac/package.json`, under `"scripts"`, add:

```json
"test": "vitest run"
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Verify Vitest runs (no tests yet → exits 0 with "no test files found")**

Run: `cd codey-mac && npm test`
Expected: exits successfully (Vitest may report "No test files found" — that's fine).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/package.json codey-mac/package-lock.json codey-mac/vitest.config.ts
git commit -m "chore(codey-mac): add vitest for unit tests"
```

---

## Task 2: Write parser failing tests

**Files:**
- Create: `codey-mac/src/components/teamMessageFormat.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { parseTeamMessage, extractPreview } from './teamMessageFormat'

describe('parseTeamMessage', () => {
  it('returns null for plain text', () => {
    expect(parseTeamMessage('hello world')).toBeNull()
  })

  it('returns null for content that lacks the team marker', () => {
    expect(parseTeamMessage('### Some heading\n\nbody')).toBeNull()
  })

  it('parses summary + multiple steps', () => {
    const input = [
      '🧭 Manager summary: All done.',
      '',
      '### Step 1: alice',
      '',
      'alice did a thing.',
      '',
      '---',
      '',
      '### Step 2: bob',
      '',
      'bob also did a thing.',
    ].join('\n')
    const r = parseTeamMessage(input)
    expect(r).not.toBeNull()
    expect(r!.summary).toBe('All done.')
    expect(r!.steps).toHaveLength(2)
    expect(r!.steps[0]).toEqual({ step: 1, worker: 'alice', output: 'alice did a thing.' })
    expect(r!.steps[1]).toEqual({ step: 2, worker: 'bob', output: 'bob also did a thing.' })
  })

  it('parses steps without a summary', () => {
    const input = [
      '### Step 1: alice',
      '',
      'output here',
    ].join('\n')
    const r = parseTeamMessage(input)
    expect(r).not.toBeNull()
    expect(r!.summary).toBeNull()
    expect(r!.steps).toHaveLength(1)
  })

  it('preserves "(revision)" suffix in worker name', () => {
    const input = '### Step 3: alice (revision)\n\nfixed it'
    const r = parseTeamMessage(input)
    expect(r!.steps[0].worker).toBe('alice (revision)')
  })

  it('returns null when any chunk fails to match the step pattern', () => {
    const input = [
      '🧭 Manager summary: x',
      '',
      'not a step heading at all',
    ].join('\n')
    expect(parseTeamMessage(input)).toBeNull()
  })
})

describe('extractPreview', () => {
  it('returns "(no output)" for empty', () => {
    expect(extractPreview('')).toBe('(no output)')
    expect(extractPreview('   \n\n  ')).toBe('(no output)')
  })

  it('takes first sentence of last non-empty paragraph', () => {
    const text = 'First paragraph here.\n\nSecond paragraph. Has two sentences.'
    expect(extractPreview(text)).toBe('Has two sentences.')
  })

  it('handles Chinese full stop', () => {
    const text = '中间段落\n\n结论一。结论二。'
    expect(extractPreview(text)).toBe('结论一。')
  })

  it('returns whole paragraph when no sentence terminator', () => {
    expect(extractPreview('just a fragment')).toBe('just a fragment')
  })

  it('truncates long previews to ~120 chars with ellipsis', () => {
    const long = 'a'.repeat(200)
    const out = extractPreview(long)
    expect(out.length).toBeLessThanOrEqual(121)
    expect(out.endsWith('…')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd codey-mac && npm test`
Expected: FAIL — `teamMessageFormat` module not found.

---

## Task 3: Implement parser

**Files:**
- Create: `codey-mac/src/components/teamMessageFormat.ts`

- [ ] **Step 1: Write the implementation**

```ts
export interface TeamStep {
  step: number
  worker: string
  output: string
}

export interface ParsedTeamMessage {
  summary: string | null
  steps: TeamStep[]
}

const SUMMARY_PREFIX = '🧭 Manager summary: '
const STEP_HEADING = /^### Step (\d+): (.+?)\n\n([\s\S]*)$/

export function parseTeamMessage(content: string): ParsedTeamMessage | null {
  if (!content) return null

  let body = content
  let summary: string | null = null

  if (body.startsWith(SUMMARY_PREFIX)) {
    const nl = body.indexOf('\n')
    summary = body.slice(SUMMARY_PREFIX.length, nl === -1 ? undefined : nl).trim()
    body = nl === -1 ? '' : body.slice(nl + 1).replace(/^\n+/, '')
  }

  if (!body.startsWith('### Step ')) return null

  const chunks = body.split('\n\n---\n\n')
  const steps: TeamStep[] = []
  for (const chunk of chunks) {
    const m = chunk.match(STEP_HEADING)
    if (!m) return null
    steps.push({
      step: parseInt(m[1], 10),
      worker: m[2].trim(),
      output: m[3].trim(),
    })
  }
  if (steps.length === 0) return null
  return { summary, steps }
}

const MAX_PREVIEW = 120

export function extractPreview(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return '(no output)'
  const paragraphs = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const last = paragraphs[paragraphs.length - 1] ?? trimmed
  const m = last.match(/^([^.!?。！？]*[.!?。！？])/)
  const sentence = (m ? m[1] : last).trim()
  if (sentence.length <= MAX_PREVIEW) return sentence
  return sentence.slice(0, MAX_PREVIEW) + '…'
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd codey-mac && npm test`
Expected: PASS — all parser and preview tests green.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/teamMessageFormat.ts codey-mac/src/components/teamMessageFormat.test.ts
git commit -m "feat(codey-mac): add team message parser with preview extraction"
```

---

## Task 4: Remove inline tool-call rendering

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Delete the tool-call render block**

In `ChatTab.tsx`, remove the entire block from line `539` through `605` — the `{msg.toolCalls && msg.toolCalls.length > 0 && (() => { ... })()}` IIFE. Leave the surrounding message bubble untouched. After deletion, the bubble's children begin directly with:

```tsx
{msg.content && <Markdown variant={isUser ? 'user' : 'assistant'}>{msg.content}</Markdown>}
```

- [ ] **Step 2: Remove `expandedIds` state**

Delete line `101`:

```tsx
const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
```

- [ ] **Step 3: Remove the `toolFormat` import**

Delete line `7`:

```tsx
import { formatHeadline, hasDetail as toolHasDetail, ToolDetail, normalizeTool } from './toolFormat'
```

- [ ] **Step 4: Remove dead style entries**

In the `styles` object (around line `867-876`), delete these keys:
`toolCallsContainer`, `toolCallRow`, `toolCallInfo`, `toolCallSep`, `chevron`, `toolDetail`.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd codey-mac && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If unused-import or unused-variable errors surface for anything else removed, fix by deleting the dead reference.)

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "refactor(codey-mac): remove inline tool-call rendering from messages"
```

---

## Task 5: Render team messages as collapsible step cards

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Add the parser import**

At the top of `ChatTab.tsx`, alongside other imports from `./`, add:

```tsx
import { parseTeamMessage, extractPreview } from './teamMessageFormat'
```

- [ ] **Step 2: Add per-step collapse state**

Inside the `ChatTab` component (near other `useState` hooks, e.g. just below where `expandedIds` was removed), add:

```tsx
const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
```

The set holds keys of the form `${msg.id}::${step}`.

- [ ] **Step 3: Add the TeamMessage subcomponent**

Place this component definition above the `ChatTab` component (or as a top-level helper inside the file, next to other small components like `TypingDots`):

```tsx
const TeamMessage: React.FC<{
  messageId: string
  parsed: ReturnType<typeof parseTeamMessage> & object
  isStreaming: boolean
  expanded: Set<string>
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
}> = ({ messageId, parsed, isStreaming, expanded, setExpanded }) => {
  const lastIdx = parsed.steps.length - 1
  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
  return (
    <div>
      {parsed.summary && (
        <div style={styles.teamSummary}>🧭 {parsed.summary}</div>
      )}
      {parsed.steps.map((s, i) => {
        const key = `${messageId}::${s.step}`
        const isLastDuringStream = isStreaming && i === lastIdx
        const isOpen = isLastDuringStream
          ? !expanded.has(key + '::collapsed')
          : expanded.has(key)
        const onClick = () => {
          if (isLastDuringStream) toggle(key + '::collapsed')
          else toggle(key)
        }
        const preview = extractPreview(s.output)
        return (
          <div key={key} style={styles.teamStepCard}>
            <div style={styles.teamStepHeader} onClick={onClick}>
              <span style={{ ...styles.teamStepChevron, transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              <span style={styles.teamStepLabel}>Step {s.step}: {s.worker}</span>
              {!isOpen && <span style={styles.teamStepPreview}> · {preview}</span>}
            </div>
            {isOpen && (
              <div style={styles.teamStepBody}>
                <Markdown variant="assistant">{s.output}</Markdown>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

Note the inverted-collapse trick for the streaming step: it defaults to expanded, and clicking adds a `::collapsed` marker to the set. Once streaming ends, the step uses normal collapse semantics (default collapsed, click to expand).

- [ ] **Step 4: Add the styles**

In the `styles` object, add:

```tsx
teamSummary: {
  fontSize: 13, fontWeight: 600, color: C.accent,
  padding: '6px 8px', marginBottom: 8,
  borderLeft: `3px solid ${C.accent}`, background: 'rgba(255,255,255,0.03)',
  borderRadius: 4,
},
teamStepCard: { marginBottom: 6 },
teamStepHeader: {
  display: 'flex', alignItems: 'baseline', cursor: 'pointer',
  fontSize: 12, color: C.fg2, padding: '2px 0', userSelect: 'none',
},
teamStepChevron: {
  display: 'inline-block', fontSize: 11, marginRight: 6,
  transition: 'transform 0.15s ease', color: C.fg3, flexShrink: 0,
},
teamStepLabel: { color: C.fg, fontWeight: 500 },
teamStepPreview: {
  color: C.fg3, fontStyle: 'italic', marginLeft: 4,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  flex: 1, minWidth: 0,
},
teamStepBody: { marginTop: 4, marginLeft: 17 },
```

- [ ] **Step 5: Wire it into the message bubble**

In `ChatTab.tsx`, replace the line that currently renders message content for non-user messages:

```tsx
{msg.content && <Markdown variant={isUser ? 'user' : 'assistant'}>{msg.content}</Markdown>}
```

with:

```tsx
{msg.content && (() => {
  if (isUser) return <Markdown variant="user">{msg.content}</Markdown>
  const parsed = parseTeamMessage(msg.content)
  if (!parsed) return <Markdown variant="assistant">{msg.content}</Markdown>
  const isStreaming = !!flight && msg === lastMsg
  return (
    <TeamMessage
      messageId={msg.id}
      parsed={parsed}
      isStreaming={isStreaming}
      expanded={expandedSteps}
      setExpanded={setExpandedSteps}
    />
  )
})()}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd codey-mac && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Manual smoke test in dev**

Run: `cd codey-mac && npm run dev`

Open the app, run a `/team <name> <task>` against a test workspace with at least 2 workers, and verify:
- While streaming: the in-progress step card is expanded; earlier steps are collapsed with one-line preview.
- After streaming ends: all step cards are collapsed; clicking expands.
- The manager summary line appears at the top in accent color (only when present).
- The right Context Panel still shows tool calls and updates as before.
- A non-team chat (`/chat` style) message renders as plain Markdown without any card wrapper.
- No tool-call rows appear inside any message bubble.

If any check fails, fix in this task before committing. (If you can't run the UI in this environment, say so explicitly — type-check passing is necessary but not sufficient.)

- [ ] **Step 8: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(codey-mac): collapsible per-step cards for team messages"
```

---

## Self-review notes

- **Spec coverage:** A → Task 4. B (parser, preview rule, collapse default, streaming-step expanded, no info lines, no summary → omit, fall-through for non-team) → Tasks 2/3/5.
- **Type consistency:** `parseTeamMessage` return shape (`{summary, steps[]}`) is used identically in tests and TeamMessage component.
- **No placeholders:** every code step shows the actual code; every command has expected output.
- **Backend untouched:** other channels and gateway behavior unaffected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-message-compaction.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
