import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { C } from '../theme'

interface MarkdownProps {
  children: string
  variant?: 'user' | 'assistant'
  layout?: 'compact' | 'roomy'
}

/** Shape of one density's metrics; both entries must supply every field. */
interface Metrics {
  fontSize: number
  lineHeight: number
  /** Bottom margin for block-level elements (p, ul, ol, blockquote, code blocks). */
  blockGap: number
  /** Bottom margin for the table wrapper. */
  tableGap: number
  li: number
  hr: string
  h1: { fontSize: number; margin: string }
  h2: { fontSize: number; margin: string }
  h3: { fontSize: number; margin: string }
  h4: { fontSize: number; margin: string }
}

/** Two typographic densities. `compact` is the historical chat metric and stays
 *  the default, so every secondary surface (team panels, automation, quick
 *  question) is untouched. `roomy` is for the main assistant turn, which renders
 *  as a document rather than a bubble: at 13px/1.55 a paragraph's bottom margin
 *  (8px) was barely larger than the gap between its own lines (~7px), so the
 *  paragraph stopped reading as a unit. Heading margins are deliberately
 *  asymmetric — a heading belongs to the text below it, not midway between two
 *  blocks. */
const METRICS = {
  compact: {
    fontSize: 13,
    lineHeight: 1.55,
    blockGap: 8,
    tableGap: 10,
    li: 2,
    hr: '10px 0',
    h1: { fontSize: 17, margin: '8px 0 6px' },
    h2: { fontSize: 15, margin: '8px 0 6px' },
    h3: { fontSize: 14, margin: '8px 0 4px' },
    h4: { fontSize: 13, margin: '6px 0 4px' },
  },
  roomy: {
    fontSize: 14,
    // 1.7 rather than 1.55: Chinese has a high character-face ratio and no
    // ascenders or descenders, so identical leading reads tighter than it does
    // for Latin text.
    lineHeight: 1.7,
    blockGap: 14,
    tableGap: 14,
    li: 5,
    hr: '18px 0',
    h1: { fontSize: 20, margin: '22px 0 8px' },
    h2: { fontSize: 17, margin: '20px 0 8px' },
    h3: { fontSize: 15, margin: '18px 0 6px' },
    h4: { fontSize: 14, margin: '16px 0 6px' },
  },
} as const satisfies Record<'compact' | 'roomy', Metrics>

const MONO = 'ui-monospace, "SF Mono", Menlo, Monaco, "Courier New", monospace'

const CodeBlock: React.FC<{
  children: React.ReactNode
  background: string
  borderColor: string
  blockMargin: number
}> = ({ children, background, borderColor, blockMargin }) => {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const child: any = React.Children.toArray(children)[0]
  const className: string = child?.props?.className ?? ''
  const lang = /language-(\w+)/.exec(className)?.[1]
  const codeText: string = typeof child?.props?.children === 'string'
    ? child.props.children
    : Array.isArray(child?.props?.children)
      ? child.props.children.join('')
      : String(child?.props?.children ?? '')

  React.useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

  const onCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) return
      await navigator.clipboard.writeText(codeText.replace(/\n$/, ''))
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch { /* keep the button unchanged when copying fails */ }
  }

  return (
    <div
      style={{
        background,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        margin: `6px 0 ${blockMargin}px`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 10px',
          fontSize: 10,
          color: C.fg3,
          fontFamily: MONO,
          borderBottom: `1px solid ${borderColor}`,
          background: 'rgba(0,0,0,0.08)',
        }}
      >
        <span style={{ textTransform: 'lowercase' }}>{lang ?? 'text'}</span>
        <button
          type="button"
          onClick={() => { void onCopy() }}
          style={{
            background: copied ? `${C.green}1f` : 'transparent',
            border: `1px solid ${copied ? C.green : borderColor}`,
            color: copied ? C.green : C.fg3,
            borderRadius: 4,
            padding: '1px 6px',
            fontSize: 10,
            fontWeight: copied ? 700 : 400,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
          }}
          title={copied ? 'Copied' : 'Copy'}
          aria-live="polite"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          overflowX: 'auto',
          fontSize: 12,
          lineHeight: 1.5,
          fontFamily: MONO,
          color: C.codeFg,
          background: 'transparent',
          whiteSpace: 'pre',
          tabSize: 2,
        }}
      >
        <code style={{ background: 'transparent', padding: 0, fontFamily: MONO, color: 'inherit' }}>
          {codeText.replace(/\n$/, '')}
        </code>
      </pre>
    </div>
  )
}

// Add markdown hard breaks ("  \n") only inside prose paragraphs, so the
// author's single line breaks survive rendering. Leave block-level
// constructs alone — fenced code, indented code, tables, lists, headings,
// blockquotes, HRs — otherwise GFM stops recognizing them as blocks (e.g.
// a hard-break on the line above a table glues it into the prose paragraph
// and the table is rendered as plain text).
const INVOKE_XML_RE = /<invoke\s+name="AskUserQuestion">[\s\S]*?<\/invoke>/g

function stripHallucinatedInvoke(src: string): string {
  if (!src.includes('<invoke name="AskUserQuestion">')) return src
  return src.replace(INVOKE_XML_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function preserveLineBreaks(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inFence = false
  const isBlockish = (line: string): boolean => {
    const t = line.trim()
    return (
      t === '' ||
      /^\|/.test(t) ||                      // table row
      /^[-*+]\s/.test(t) ||                 // unordered list
      /^\d+[.)]\s/.test(t) ||               // ordered list
      /^#{1,6}\s/.test(t) ||                // heading
      /^>/.test(t) ||                       // blockquote
      /^(-{3,}|_{3,}|\*{3,})$/.test(t) ||   // hr
      /^(```|~~~)/.test(t) ||               // fence delimiter
      /^ {4,}\S/.test(line)                 // indented code
    )
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || isBlockish(line)) { out.push(line); continue }
    const next = lines[i + 1]
    if (next === undefined || next.trim() === '' || isBlockish(next)) {
      out.push(line)
      continue
    }
    out.push(/  $/.test(line) ? line : line + '  ')
  }
  return out.join('\n')
}

const MarkdownInner: React.FC<MarkdownProps> = ({ children, variant = 'assistant', layout = 'compact' }) => {
  const onUser = variant === 'user'
  const M = METRICS[layout]
  const inlineCodeBg = onUser ? 'rgba(0,0,0,0.22)' : C.inlineCodeBg
  const inlineCodeFg = onUser ? C.onAccent : C.inlineCodeFg
  const codeBlockBg = onUser ? 'rgba(0,0,0,0.25)' : C.codeBg
  const codeBlockBorder = onUser ? 'rgba(255,255,255,0.12)' : C.border2
  const linkColor = onUser ? C.onAccent : C.accent
  const quoteBorder = onUser ? 'rgba(255,255,255,0.35)' : C.border2
  const quoteFg = onUser ? 'rgba(255,255,255,0.85)' : C.fg2
  const ruleColor = onUser ? 'rgba(255,255,255,0.2)' : C.border2
  const tableBorder = onUser ? 'rgba(255,255,255,0.18)' : C.border2
  const tableHeadBg = onUser ? 'rgba(0,0,0,0.2)' : C.surface3

  return (
    <div
      className={layout === 'roomy' ? 'md-roomy' : undefined}
      style={{ minWidth: 0, maxWidth: '100%', fontSize: M.fontSize, lineHeight: M.lineHeight, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p style={{ margin: `0 0 ${M.blockGap}px 0` }}>{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={e => {
                e.preventDefault()
                if (href) window.codey?.openExternal?.(href)
              }}
              style={{ color: linkColor, textDecoration: 'underline' }}
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
          em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
          del: ({ children }) => <del style={{ opacity: 0.6 }}>{children}</del>,
          h1: ({ children }) => <h1 style={{ fontSize: M.h1.fontSize, fontWeight: 700, margin: M.h1.margin }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: M.h2.fontSize, fontWeight: 700, margin: M.h2.margin }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: M.h3.fontSize, fontWeight: 700, margin: M.h3.margin }}>{children}</h3>,
          h4: ({ children }) => <h4 style={{ fontSize: M.h4.fontSize, fontWeight: 700, margin: M.h4.margin }}>{children}</h4>,
          ul: ({ children }) => <ul style={{ margin: `0 0 ${M.blockGap}px 0`, paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: `0 0 ${M.blockGap}px 0`, paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: M.li }}>{children}</li>,
          hr: () => <hr style={{ border: 'none', borderTop: `1px solid ${ruleColor}`, margin: M.hr }} />,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                borderLeft: `3px solid ${quoteBorder}`,
                paddingLeft: 10,
                margin: `0 0 ${M.blockGap}px 0`,
                color: quoteFg,
              }}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: `6px 0 ${M.tableGap}px`, maxWidth: '100%' }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  border: `1px solid ${tableBorder}`,
                  width: 'max-content',
                  minWidth: '100%',
                }}
              >
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead style={{ background: tableHeadBg }}>{children}</thead>,
          tr: ({ children }) => <tr>{children}</tr>,
          th: ({ children }) => (
            <th
              style={{
                textAlign: 'left',
                padding: '6px 10px',
                borderBottom: `1px solid ${tableBorder}`,
                borderRight: `1px solid ${tableBorder}`,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                padding: '6px 10px',
                borderTop: `1px solid ${tableBorder}`,
                borderRight: `1px solid ${tableBorder}`,
                verticalAlign: 'top',
              }}
            >
              {children}
            </td>
          ),
          pre: ({ children }: any) => {
            return (
              <CodeBlock background={codeBlockBg} borderColor={codeBlockBorder} blockMargin={M.blockGap}>
                {children}
              </CodeBlock>
            )
          },
          code: ({ className, children, ...props }: any) => {
            const isBlock = /language-/.test(className || '')
            if (isBlock) {
              return <code className={className} style={{ fontFamily: MONO, background: 'transparent', padding: 0 }}>{children}</code>
            }
            return (
              <code
                {...props}
                style={{
                  background: inlineCodeBg,
                  color: inlineCodeFg,
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: 12,
                  fontFamily: MONO,
                  // Preserve spaces while still allowing long inline snippets
                  // to wrap inside a narrow message bubble.
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflowWrap: 'anywhere',
                }}
              >
                {children}
              </code>
            )
          },
        }}
      >
        {preserveLineBreaks(stripHallucinatedInvoke(children))}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = React.memo(MarkdownInner)
