import React from 'react'

type Mermaid = typeof import('mermaid').default

let loader: Promise<Mermaid> | null = null
const loadMermaid = (): Promise<Mermaid> => (loader ??= import('mermaid').then(module => module.default))
let sequence = 0

/**
 * Draws a Mermaid code block. The ordinary code block stays visible while the
 * renderer loads, while streamed source is incomplete, and after parse errors.
 */
export const MermaidBlock: React.FC<{ code: string; fallback: React.ReactNode }> = ({ code, fallback }) => {
  const [svg, setSvg] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    setSvg(null)
    loadMermaid()
      .then(mermaid => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
        })
        return mermaid.render(`codey-mermaid-${++sequence}`, code)
      })
      .then(result => {
        if (active) setSvg(result.svg)
      })
      .catch(() => { /* Keep the code fallback when parsing or rendering fails. */ })

    return () => { active = false }
  }, [code])

  if (!svg) return <div data-mermaid-pending="">{fallback}</div>
  return (
    <div
      style={{ overflowX: 'auto', margin: '6px 0 10px' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
