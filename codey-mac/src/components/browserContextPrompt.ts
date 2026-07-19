import type { BrowserPageContext } from '../codey-api'

function metric(value: number | null, unit = 'ms'): string {
  return value === null ? 'unavailable' : `${value}${unit}`
}

export function buildBrowserContextPrompt(context: BrowserPageContext): string {
  const performance = [
    `DOM content loaded: ${metric(context.performance.domContentLoadedMs)}`,
    `Page load: ${metric(context.performance.loadMs)}`,
    `Transferred: ${metric(context.performance.transferBytes, ' bytes')}`,
  ].join('; ')
  return [
    'Help me with the page currently open in Codey Browser.',
    `URL: ${context.url}`,
    `Title: ${context.title || '(untitled)'}`,
    context.description ? `Description: ${context.description}` : '',
    `Navigation performance: ${performance}`,
    '',
    'Visible page text:',
    context.text || '(No visible text was available.)',
  ].filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n')
}
