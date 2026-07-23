declare module 'highlight.js/lib/core' {
  type LanguageDefinition = (hljs?: unknown) => unknown

  interface HighlightCore {
    registerLanguage: (name: string, language: LanguageDefinition) => void
    highlight: (language: string, code: string, ignoreIllegals?: boolean) => { value: string }
  }

  const hljs: HighlightCore
  export default hljs
}

declare module 'highlight.js/lib/languages/*' {
  const language: (hljs?: unknown) => unknown
  export default language
}
