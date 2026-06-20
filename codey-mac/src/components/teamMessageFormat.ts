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

  if (!body.startsWith('### Step ')) return parseSequentialTeamMessage(content)

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

// The Sequential / `all` dispatch paths render a different transcript than the
// `### Step` auto/advisor format. Shape (gateway `continueGraphRun` /
// `runAllMembersInOrder`):
//
//   📊 Team **X** flow results
//
//   **worker-a**:
//   <output, may span blank lines and contain **bold**>
//
//   **worker-b**: ❌ Failed - ...
//
//   ---
//   ### 🧠 Team blackboard
//   ...
//
// A "**name**:" worker header has its colon OUTSIDE the bold, which
// distinguishes it from blackboard labels like "**Decisions:**" (colon inside).
const SEQ_HEADER = /^📊 Team \*\*.+?\*\* (?:flow )?results\s*\n+/
const BLACKBOARD_MARKER = '### 🧠 Team blackboard'
const WORKER_HEADER = /^\*\*([^\n*]+?)\*\*:[ \t]?(.*)$/

function parseSequentialTeamMessage(content: string): ParsedTeamMessage | null {
  const header = content.match(SEQ_HEADER)
  if (!header) return null
  let body = content.slice(header[0].length)

  // Drop the trailing blackboard section (and a preceding `---` separator).
  const bbIdx = body.indexOf(BLACKBOARD_MARKER)
  if (bbIdx !== -1) body = body.slice(0, bbIdx).replace(/\n*-{3,}\s*$/, '').trimEnd()

  const steps: TeamStep[] = []
  let current: { worker: string; lines: string[] } | null = null
  const flush = () => {
    if (current) steps.push({ step: steps.length + 1, worker: current.worker.trim(), output: current.lines.join('\n').trim() })
  }
  for (const line of body.split('\n')) {
    const m = line.match(WORKER_HEADER)
    if (m) {
      flush()
      current = { worker: m[1], lines: m[2] ? [m[2]] : [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  return steps.length > 0 ? { summary: null, steps } : null
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
