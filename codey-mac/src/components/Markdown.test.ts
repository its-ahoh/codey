import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'

const render = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { children: text }))

describe('Markdown emphasis next to Chinese punctuation', () => {
  it('bolds a label that ends in a full-width colon and runs straight into Chinese text', () => {
    const html = render('**颜色：**蓝色') // lint-allow-non-english
    expect(html).toContain('>颜色：</strong>') // lint-allow-non-english
    expect(html).not.toContain('**')
  })

  it('bolds text wrapped in Chinese quotes followed by Chinese text', () => {
    const html = render('今天**「下雨」**了') // lint-allow-non-english
    expect(html).toContain('>「下雨」</strong>') // lint-allow-non-english
  })

  it('bolds several labels across lines', () => {
    const html = render('**水果：**苹果\n**饮料：**牛奶') // lint-allow-non-english
    expect(html).toContain('>水果：</strong>') // lint-allow-non-english
    expect(html).toContain('>饮料：</strong>') // lint-allow-non-english
    expect(html).not.toContain('**')
  })

  it('still renders ordinary English emphasis', () => {
    expect(render('a **bold** word')).toContain('>bold</strong>')
  })
})

describe('Markdown images', () => {
  it('renders an upload snapshot as an img', () => {
    const html = render('![Sales](</w/.codey/uploads/outputs/1-x-chart.png>)')
    expect(html).toContain('<img')
    expect(html).toContain('codey-asset://file/')
  })

  it('renders a remote image as a link, not an img', () => {
    const html = render('![r](https://e.com/x.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://e.com/x.png"')
  })
})

describe('Markdown mermaid', () => {
  it('server-renders the code fallback until mermaid has drawn the diagram', () => {
    const html = render('```mermaid\ngraph TD\nA-->B\n```')
    expect(html).toContain('data-mermaid-pending')
    expect(html).toContain('graph TD')
  })

  it('leaves other code blocks alone', () => {
    expect(render('```ts\nconst a = 1\n```')).not.toContain('data-mermaid-pending')
  })
})
