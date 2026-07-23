import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { C } from '../theme'

interface MarkdownProps {
  children: string
  variant?: 'user' | 'assistant'
}

const MONO = 'ui-monospace, "SF Mono", Menlo, Monaco, "Courier New", monospace'

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

const MarkdownInner: React.FC<MarkdownProps> = ({ children, variant = 'assistant' }) => {
  const onUser = variant === 'user'
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
    <div style={{ fontSize: 13, lineHeight: 1.55, wordBreak: 'break-word' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p style={{ margin: '0 0 8px 0' }}>{children}</p>,
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
          h1: ({ children }) => <h1 style={{ fontSize: 17, fontWeight: 700, margin: '8px 0 6px' }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 15, fontWeight: 700, margin: '8px 0 6px' }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 700, margin: '8px 0 4px' }}>{children}</h3>,
          h4: ({ children }) => <h4 style={{ fontSize: 13, fontWeight: 700, margin: '6px 0 4px' }}>{children}</h4>,
          ul: ({ children }) => <ul style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
          hr: () => <hr style={{ border: 'none', borderTop: `1px solid ${ruleColor}`, margin: '10px 0' }} />,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                borderLeft: `3px solid ${quoteBorder}`,
                paddingLeft: 10,
                margin: '0 0 8px 0',
                color: quoteFg,
              }}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '6px 0 10px', maxWidth: '100%' }}>
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
            const child: any = React.Children.toArray(children)[0]
            const className: string = child?.props?.className ?? ''
            const lang = /language-(\w+)/.exec(className)?.[1]
            // Pull the raw code text so we can render it inside a <pre>
            // (whitespace-preserving) and offer a Copy button. Rendering as
            // <div> + <code> here would let the browser collapse newlines
            // because <div>'s default white-space is `normal`.
            const codeText: string = typeof child?.props?.children === 'string'
              ? child.props.children
              : Array.isArray(child?.props?.children)
                ? child.props.children.join('')
                : String(child?.props?.children ?? '')
            const onCopy = () => {
              try { navigator.clipboard?.writeText(codeText.replace(/\n$/, '')) } catch { /* noop */ }
            }
            return (
              <div
                style={{
                  background: codeBlockBg,
                  border: `1px solid ${codeBlockBorder}`,
                  borderRadius: 8,
                  margin: '6px 0 8px',
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
                    borderBottom: `1px solid ${codeBlockBorder}`,
                    background: 'rgba(0,0,0,0.08)',
                  }}
                >
                  <span style={{ textTransform: 'lowercase' }}>{lang ?? 'text'}</span>
                  <button
                    onClick={onCopy}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${codeBlockBorder}`,
                      color: C.fg3,
                      borderRadius: 4,
                      padding: '1px 6px',
                      fontSize: 10,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                    title="Copy"
                  >
                    Copy
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
                  // Identifiers such as `certificate_request` are semantic
                  // units. Keep the entire token together instead of inheriting
                  // the prose container's break-word behavior.
                  whiteSpace: 'pre',
                  wordBreak: 'normal',
                  overflowWrap: 'normal',
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
