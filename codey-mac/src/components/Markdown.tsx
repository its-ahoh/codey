import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { C } from '../theme'

interface MarkdownProps {
  children: string
  variant?: 'user' | 'assistant'
}

const MONO = 'ui-monospace, "SF Mono", Menlo, Monaco, "Courier New", monospace'

function preserveLineBreaks(src: string): string {
  const parts = src.split(/(```[\s\S]*?```)/g)
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p
      return p.replace(/(?<!\n)\n(?!\n)/g, '  \n')
    })
    .join('')
}

export const Markdown: React.FC<MarkdownProps> = ({ children, variant = 'assistant' }) => {
  const onUser = variant === 'user'
  const inlineCodeBg = onUser ? 'rgba(0,0,0,0.22)' : '#1a1a1a'
  const inlineCodeFg = onUser ? '#f0f0f0' : '#e6e6e6'
  const codeBlockBg = onUser ? 'rgba(0,0,0,0.25)' : '#141414'
  const codeBlockBorder = onUser ? 'rgba(255,255,255,0.12)' : C.border2
  const linkColor = onUser ? '#cfe6ff' : C.accent
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
            <div style={{ overflowX: 'auto', margin: '0 0 8px 0' }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  border: `1px solid ${tableBorder}`,
                }}
              >
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead style={{ background: tableHeadBg }}>{children}</thead>,
          th: ({ children }) => (
            <th
              style={{
                textAlign: 'left',
                padding: '6px 10px',
                borderBottom: `1px solid ${tableBorder}`,
                fontWeight: 600,
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{ padding: '6px 10px', borderTop: `1px solid ${tableBorder}` }}>
              {children}
            </td>
          ),
          code: ({ inline, className, children, ...props }: any) => {
            const content = String(children ?? '').replace(/\n$/, '')
            if (inline) {
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
                  }}
                >
                  {content}
                </code>
              )
            }
            const lang = /language-(\w+)/.exec(className || '')?.[1]
            return (
              <pre
                style={{
                  background: codeBlockBg,
                  border: `1px solid ${codeBlockBorder}`,
                  borderRadius: 8,
                  padding: '10px 12px',
                  margin: '6px 0 8px',
                  overflowX: 'auto',
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontFamily: MONO,
                  color: '#e6e6e6',
                  position: 'relative',
                }}
              >
                {lang && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 8,
                      fontSize: 10,
                      color: C.fg3,
                      fontFamily: MONO,
                      textTransform: 'lowercase',
                    }}
                  >
                    {lang}
                  </div>
                )}
                <code style={{ fontFamily: MONO }}>{content}</code>
              </pre>
            )
          },
        }}
      >
        {preserveLineBreaks(children)}
      </ReactMarkdown>
    </div>
  )
}
