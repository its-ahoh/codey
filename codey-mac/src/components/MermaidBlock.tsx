import React from 'react'

type Mermaid = typeof import('mermaid').default

let loader: Promise<Mermaid> | null = null
const loadMermaid = (): Promise<Mermaid> => (loader ??= import('mermaid').then(module => module.default))
let sequence = 0
const RENDER_DELAY_MS = 300

/**
 * Draws a Mermaid code block. The ordinary code block stays visible while the
 * renderer loads, while streamed source is incomplete, and after parse errors.
 */
export const MermaidBlock: React.FC<{ code: string; fallback: React.ReactNode }> = ({ code, fallback }) => {
  const [svg, setSvg] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    setSvg(null)
    // Streaming changes `code` per token; draw only once the source settles.
    const timer = setTimeout(() => {
      loadMermaid()
        .then(mermaid => {
          if (!active) return null
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
          })
          return mermaid.render(`codey-mermaid-${++sequence}`, code)
        })
        .then(result => {
          if (active && result) setSvg(result.svg)
        })
        .catch(() => { /* Keep the code fallback when parsing or rendering fails. */ })
    }, RENDER_DELAY_MS)

    return () => { active = false; clearTimeout(timer) }
  }, [code])

  if (!svg) return <div data-mermaid-pending="">{fallback}</div>
  return (
    <div
      style={{ overflowX: 'auto', margin: '6px 0 10px' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
