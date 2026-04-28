import React from 'react'
import { C } from '../theme'

type Input = Record<string, unknown> | undefined

export type CanonicalTool =
  | 'Read' | 'Write' | 'Edit' | 'Bash' | 'Grep' | 'Glob' | 'LS'
  | 'WebFetch' | 'WebSearch' | 'TodoWrite' | 'Task' | 'Notebook'
  | 'Patch' | 'Plan' | 'Other'

const NAME_MAP: Record<string, CanonicalTool> = {
  // claude-code
  read: 'Read', write: 'Write', edit: 'Edit', multiedit: 'Edit',
  bash: 'Bash', grep: 'Grep', glob: 'Glob', ls: 'LS',
  webfetch: 'WebFetch', websearch: 'WebSearch',
  todowrite: 'TodoWrite', todoread: 'TodoWrite',
  task: 'Task', agent: 'Task',
  notebookedit: 'Notebook',
  // codex
  shell: 'Bash', shell_command: 'Bash', local_shell_call: 'Bash', exec: 'Bash',
  read_file: 'Read', write_file: 'Write', create_file: 'Write',
  apply_patch: 'Patch', patch: 'Patch',
  update_plan: 'Plan', plan: 'Plan',
  web_search: 'WebSearch',
  // opencode
  list: 'LS',
}

export const normalizeTool = (raw: string | undefined): CanonicalTool => {
  if (!raw) return 'Other'
  return NAME_MAP[raw.toLowerCase()] ?? 'Other'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))

const basename = (p: string): string => {
  const cleaned = p.replace(/\/+$/, '')
  const i = cleaned.lastIndexOf('/')
  return i >= 0 ? cleaned.slice(i + 1) : cleaned
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…')

const oneLine = (s: string, n = 80): string => truncate(s.replace(/\s+/g, ' ').trim(), n)

/** Build the compact headline shown on the tool-call row. */
export const formatHeadline = (rawTool: string | undefined, input: Input): string => {
  const tool = normalizeTool(rawTool)
  const i = input ?? {}
  const path = str(i.file_path ?? i.path ?? i.filename ?? i.notebook_path)
  switch (tool) {
    case 'Read': {
      const range = i.offset != null || i.limit != null
        ? ` [${i.offset ?? 0}${i.limit != null ? `:+${i.limit}` : ''}]`
        : ''
      return `Read(${path ? basename(path) : '?'})${range}`
    }
    case 'Write': return `Write(${path ? basename(path) : '?'})`
    case 'Edit': return `Edit(${path ? basename(path) : '?'})`
    case 'Notebook': return `NotebookEdit(${path ? basename(path) : '?'})`
    case 'Bash': {
      const cmd = str(i.command ?? i.cmd ?? i.script)
      return `Bash(${oneLine(cmd, 70) || '?'})`
    }
    case 'Grep': {
      const pat = str(i.pattern ?? i.query ?? i.regex)
      const where = str(i.path ?? i.glob ?? '')
      return `Grep(${oneLine(pat, 50)}${where ? ` in ${basename(where)}` : ''})`
    }
    case 'Glob': return `Glob(${str(i.pattern ?? i.glob ?? '?')})`
    case 'LS': return `LS(${str(i.path ?? '.') || '.'})`
    case 'WebFetch': {
      const url = str(i.url ?? i.uri ?? '')
      return `WebFetch(${oneLine(url, 60) || '?'})`
    }
    case 'WebSearch': return `WebSearch(${oneLine(str(i.query ?? i.q ?? ''), 60) || '?'})`
    case 'TodoWrite': {
      const todos = (i.todos as Array<unknown> | undefined) ?? []
      return `TodoWrite${todos.length ? ` (${todos.length} items)` : ''}`
    }
    case 'Task': {
      const desc = str(i.description ?? i.subagent_type ?? i.prompt ?? '')
      return `Task(${oneLine(desc, 60) || '?'})`
    }
    case 'Patch': {
      const target = str(i.path ?? i.file_path ?? '')
      return `Patch(${target ? basename(target) : 'multi-file'})`
    }
    case 'Plan': return 'UpdatePlan'
    default: {
      const name = rawTool || 'tool'
      const summary = Object.entries(i)
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${oneLine(str(v), 30)}`)
        .join(', ')
      return summary ? `${name}(${summary})` : name
    }
  }
}

// ── Inline diff (line-level LCS) ──────────────────────────────────────────────

type DiffLine = { kind: 'eq' | 'add' | 'del'; text: string }

const lineDiff = (a: string, b: string): DiffLine[] => {
  const A = a.split('\n')
  const B = b.split('\n')
  const m = A.length, n = B.length
  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ kind: 'eq', text: A[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: A[i] }); i++ }
    else { out.push({ kind: 'add', text: B[j] }); j++ }
  }
  while (i < m) out.push({ kind: 'del', text: A[i++] })
  while (j < n) out.push({ kind: 'add', text: B[j++] })
  return out
}

const diffStyles: Record<string, React.CSSProperties> = {
  wrap: { fontFamily: 'Menlo, Monaco, "Courier New", monospace', fontSize: 11.5, lineHeight: 1.45, borderRadius: 4, overflow: 'hidden', border: `1px solid ${C.border}` },
  row: { display: 'flex', whiteSpace: 'pre', padding: '0 6px' },
  add: { background: 'rgba(50,215,75,0.13)', color: '#7ee895' },
  del: { background: 'rgba(255,69,58,0.13)', color: '#ff8a82' },
  eq:  { color: '#9a9a9a' },
  marker: { width: 14, color: '#666', flexShrink: 0 },
}

const DiffView: React.FC<{ oldText: string; newText: string }> = ({ oldText, newText }) => {
  const lines = lineDiff(oldText, newText)
  return (
    <div style={diffStyles.wrap}>
      {lines.map((l, idx) => {
        const style = l.kind === 'add' ? diffStyles.add : l.kind === 'del' ? diffStyles.del : diffStyles.eq
        const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
        return (
          <div key={idx} style={{ ...diffStyles.row, ...style }}>
            <span style={diffStyles.marker}>{marker}</span>
            <span>{l.text || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Detail rendering ──────────────────────────────────────────────────────────

const detailStyles: Record<string, React.CSSProperties> = {
  label: { fontSize: 10, color: '#777', fontFamily: 'Menlo, Monaco, "Courier New", monospace', marginBottom: 4, marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  pre: { margin: 0, fontSize: 11.5, color: '#d0d0d0', fontFamily: 'Menlo, Monaco, "Courier New", monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  block: { padding: 8, background: 'rgba(0,0,0,0.35)', borderRadius: 4, border: `1px solid ${C.border}` },
  meta: { fontSize: 11, color: '#a0a0a0', fontFamily: 'Menlo, Monaco, "Courier New", monospace' },
  todoRow: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, padding: '2px 0', fontFamily: 'Menlo, Monaco, "Courier New", monospace' },
}

const TodoList: React.FC<{ todos: Array<{ content?: string; status?: string; activeForm?: string }> }> = ({ todos }) => (
  <div>
    {todos.map((t, i) => {
      const status = t.status ?? 'pending'
      const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
      const color = status === 'completed' ? C.green : status === 'in_progress' ? C.yellow : '#888'
      return (
        <div key={i} style={detailStyles.todoRow}>
          <span style={{ color, width: 14, flexShrink: 0 }}>{mark}</span>
          <span style={{ color: status === 'completed' ? '#888' : '#d0d0d0', textDecoration: status === 'completed' ? 'line-through' : 'none' }}>
            {t.content ?? t.activeForm ?? ''}
          </span>
        </div>
      )
    })}
  </div>
)

const Block: React.FC<{ label: string; children: React.ReactNode; mono?: boolean }> = ({ label, children, mono = true }) => (
  <>
    <div style={detailStyles.label}>{label}</div>
    <div style={mono ? detailStyles.block : undefined}>{children}</div>
  </>
)

export const ToolDetail: React.FC<{
  rawTool: string | undefined
  input: Input
  output?: string
}> = ({ rawTool, input, output }) => {
  const tool = normalizeTool(rawTool)
  const i = input ?? {}
  const Pre: React.FC<{ children: string }> = ({ children }) => <pre style={detailStyles.pre}>{children}</pre>

  switch (tool) {
    case 'Read': {
      const path = str(i.file_path ?? i.path ?? i.filename)
      return (
        <>
          <div style={detailStyles.meta}>{path || '(no path)'}</div>
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Edit': {
      const path = str(i.file_path ?? i.path)
      const oldS = str(i.old_string ?? i.oldText ?? '')
      const newS = str(i.new_string ?? i.newText ?? '')
      return (
        <>
          {path && <div style={detailStyles.meta}>{path}</div>}
          {(oldS || newS) && (
            <>
              <div style={detailStyles.label}>Diff</div>
              <DiffView oldText={oldS} newText={newS} />
            </>
          )}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Write': {
      const path = str(i.file_path ?? i.path)
      const content = str(i.content ?? i.text ?? '')
      return (
        <>
          {path && <div style={detailStyles.meta}>{path}</div>}
          {content && <Block label="Content"><Pre>{content}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Bash': {
      const cmd = str(i.command ?? i.cmd ?? i.script)
      const desc = str(i.description ?? '')
      return (
        <>
          {desc && <div style={detailStyles.meta}>{desc}</div>}
          {cmd && <Block label="$"><Pre>{cmd}</Pre></Block>}
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Grep': {
      const pat = str(i.pattern ?? i.query ?? i.regex)
      const where = str(i.path ?? i.glob ?? '')
      return (
        <>
          <div style={detailStyles.meta}>{pat}{where ? `  in ${where}` : ''}</div>
          {output && <Block label="Matches"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'TodoWrite': {
      const todos = (i.todos as Array<{ content?: string; status?: string; activeForm?: string }> | undefined) ?? []
      return todos.length
        ? <TodoList todos={todos} />
        : output ? <Block label="Output"><Pre>{output}</Pre></Block> : null
    }
    case 'Patch': {
      const patch = str(i.patch ?? i.diff ?? i.input ?? '')
      return (
        <>
          {patch && <Block label="Patch"><Pre>{patch}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'WebFetch':
    case 'WebSearch': {
      const url = str(i.url ?? i.query ?? i.q ?? '')
      const prompt = str(i.prompt ?? '')
      return (
        <>
          {url && <div style={detailStyles.meta}>{url}</div>}
          {prompt && <Block label="Prompt"><Pre>{prompt}</Pre></Block>}
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Task': {
      const desc = str(i.description ?? '')
      const prompt = str(i.prompt ?? '')
      const sub = str(i.subagent_type ?? '')
      return (
        <>
          {sub && <div style={detailStyles.meta}>agent: {sub}</div>}
          {desc && <div style={detailStyles.meta}>{desc}</div>}
          {prompt && <Block label="Prompt"><Pre>{prompt}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Plan': {
      const plan = str(i.plan ?? i.explanation ?? '')
      return (
        <>
          {plan && <Block label="Plan"><Pre>{plan}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    default: {
      return (
        <>
          {input && Object.keys(input).length > 0 && (
            <Block label="Input"><Pre>{JSON.stringify(input, null, 2)}</Pre></Block>
          )}
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
  }
}

/** Whether a tool call has any expandable detail worth rendering. */
export const hasDetail = (rawTool: string | undefined, input: Input, output?: string): boolean => {
  if (output) return true
  if (!input) return false
  const tool = normalizeTool(rawTool)
  if (tool === 'Edit') return !!(input.old_string || input.new_string)
  if (tool === 'TodoWrite') return Array.isArray(input.todos) && (input.todos as unknown[]).length > 0
  return Object.keys(input).length > 0
}
