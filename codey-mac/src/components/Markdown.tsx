import React from 'react'

interface MarkdownProps {
  children: string
  variant?: 'user' | 'assistant'
}

export const Markdown: React.FC<MarkdownProps> = ({ children }) => (
  <span style={{ whiteSpace: 'pre-wrap' }}>{children}</span>
)
