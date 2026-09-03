import { describe, it, expect } from 'vitest'
import { parseUnifiedPatch } from './unifiedPatch'

const PATCH = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
@@ -10,2 +10,3 @@
 ten
+eleven
 twelve
\\ No newline at end of file
`

describe('parseUnifiedPatch', () => {
  it('splits hunks with before/after text and the new-file start line', () => {
    const hunks = parseUnifiedPatch(PATCH)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toEqual({ oldText: 'const a = 1\nconst b = 2\nconst c = 4', newText: 'const a = 1\nconst b = 3\nconst c = 4', startLine: 1 })
    expect(hunks[1]).toEqual({ oldText: 'ten\ntwelve', newText: 'ten\neleven\ntwelve', startLine: 10 })
  })
  it('handles a new file diffed against /dev/null', () => {
    const hunks = parseUnifiedPatch('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n')
    expect(hunks).toEqual([{ oldText: '', newText: 'one\ntwo', startLine: 1 }])
  })
  it('returns nothing for empty input', () => {
    expect(parseUnifiedPatch('')).toEqual([])
  })
})
