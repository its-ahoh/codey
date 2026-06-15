export interface TeamStep {
  step: number
  worker: string
  output: string
}

export interface ParsedTeamMessage {
  summary: string | null
  steps: TeamStep[]
}

const SUMMARY_PREFIX = '🧭 Advisor summary: '
const STEP_HEADING = /^### Step (\d+): (.+?)\n\n([\s\S]*)$/

export function parseTeamMessage(content: string): ParsedTeamMessage | null {
  if (!content) return null

  let body = content
  let summary: string | null = null

  if (body.startsWith(SUMMARY_PREFIX)) {
    const nl = body.indexOf('\n')
    summary = body.slice(SUMMARY_PREFIX.length, nl === -1 ? undefined : nl).trim()
    body = nl === -1 ? '' : body.slice(nl + 1).replace(/^\n+/, '')
  }

  if (!body.startsWith('### Step ')) return null

  const chunks = body.split('\n\n---\n\n')
  const steps: TeamStep[] = []
  for (const chunk of chunks) {
    const m = chunk.match(STEP_HEADING)
    if (!m) return null
    steps.push({
      step: parseInt(m[1], 10),
      worker: m[2].trim(),
      output: m[3].trim(),
    })
  }
  if (steps.length === 0) return null
  return { summary, steps }
}

const MAX_PREVIEW = 120

export function extractPreview(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return '(no output)'
  const paragraphs = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const last = paragraphs[paragraphs.length - 1] ?? trimmed
  // Split by western sentence boundaries (word + terminator + space), take last chunk
  const westernParts = last.split(/(?<=\w[.!?])\s+/)
  const chunk = westernParts[westernParts.length - 1].trim()
  // Extract the first complete sentence from that chunk
  const m = chunk.match(/^([^.!?。！？]*[.!?。！？])/) // lint-allow-non-english: splits on Chinese sentence terminators
  const sentence = (m ? m[1] : chunk).trim()
  if (sentence.length <= MAX_PREVIEW) return sentence
  return sentence.slice(0, MAX_PREVIEW) + '…'
}
