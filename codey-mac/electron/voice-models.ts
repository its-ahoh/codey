// Pure helpers for the two on-device speech engines the CodeyVoice helper
// can run: WhisperKit (`provider: 'local'`) and Nemotron streaming via
// FluidAudio (`provider: 'localStreaming'`). No Electron or fs imports so it
// is unit-testable; main.ts owns the file-system and child-process glue.
//
// The two engines are a *switch*, not a pair: only the selected one is ever
// loaded, so offering both costs one model's worth of memory, not two. That
// is why everything here asks "which on-device model is selected" rather
// than dealing with both at once.

export type VoiceProvider = 'api' | 'local' | 'localStreaming' | 'realtime'

/** Streaming model ids look like `nemotron/multilingual/1120ms`. */
export const STREAMING_MODEL_PREFIX = 'nemotron/'

/** FluidAudio's cache folder for the multilingual Nemotron repo. */
export const STREAMING_REPO_FOLDER = 'nemotron-multilingual'

/** Chunk tiers the repo ships. Smaller = snappier, larger = a touch more accurate. */
export const STREAMING_CHUNK_TIERS = [560, 1120, 2240] as const

const STREAMING_LANGUAGE_DIRS = ['multilingual', 'latin'] as const
export type StreamingLanguageDir = (typeof STREAMING_LANGUAGE_DIRS)[number]

export interface StreamingModel {
  languageDir: StreamingLanguageDir
  chunkMs: number
}

/** Both local engines run inside the helper; the API providers stay in Electron. */
export function isOnDeviceVoiceProvider(provider: unknown): boolean {
  return provider === 'local' || provider === 'localStreaming'
}

/** Parse `nemotron/<multilingual|latin>/<ms>ms`; null for anything else (incl. WhisperKit names). */
export function parseStreamingModelId(id: unknown): StreamingModel | null {
  if (typeof id !== 'string' || !id.startsWith(STREAMING_MODEL_PREFIX)) return null
  const parts = id.slice(STREAMING_MODEL_PREFIX.length).split('/')
  if (parts.length !== 2) return null
  const [languageDir, tier] = parts
  if (!(STREAMING_LANGUAGE_DIRS as readonly string[]).includes(languageDir)) return null
  const m = /^(\d+)ms$/.exec(tier)
  if (!m) return null
  const chunkMs = Number(m[1])
  if (!(STREAMING_CHUNK_TIERS as readonly number[]).includes(chunkMs)) return null
  return { languageDir: languageDir as StreamingLanguageDir, chunkMs }
}

export function streamingModelId(model: StreamingModel): string {
  return `${STREAMING_MODEL_PREFIX}${model.languageDir}/${model.chunkMs}ms`
}

/**
 * The model the selected on-device engine will load, or null for the API
 * providers. Mirrors `activeEngine` in VoiceCoordinator.swift.
 */
export function selectedOnDeviceModel(voice: { provider?: unknown; localModel?: unknown; streamingModel?: unknown } | null | undefined): string | null {
  if (!voice) return null
  if (voice.provider === 'local') {
    const m = typeof voice.localModel === 'string' ? voice.localModel.trim() : ''
    return m || null
  }
  if (voice.provider === 'localStreaming') {
    const m = typeof voice.streamingModel === 'string' ? voice.streamingModel.trim() : ''
    return m || null
  }
  return null
}

/**
 * Where FluidAudio caches a streaming variant. Mirrors `NemotronVariant.directory`
 * in the helper: `~/Library/Application Support/FluidAudio/Models/<repo>/<dir>/<ms>ms`.
 * Path segments are joined with `/` so callers can hand it to `path.join`
 * or use it as-is on macOS, the only platform the helper runs on.
 */
export function streamingModelDir(home: string, id: string): string | null {
  const model = parseStreamingModelId(id)
  if (!model) return null
  return [home, 'Library', 'Application Support', 'FluidAudio', 'Models', STREAMING_REPO_FOLDER, model.languageDir, `${model.chunkMs}ms`].join('/')
}

/** Every streaming id the helper knows how to download, for the on-disk scan. */
export function allStreamingModelIds(): string[] {
  const ids: string[] = []
  for (const languageDir of STREAMING_LANGUAGE_DIRS) {
    for (const chunkMs of STREAMING_CHUNK_TIERS) ids.push(streamingModelId({ languageDir, chunkMs }))
  }
  return ids
}

/**
 * Bundles the streaming engine must be able to load. FluidAudio downloads
 * these alongside `metadata.json`, so the presence of that file says nothing
 * about whether the transfer finished.
 */
export const STREAMING_REQUIRED_BUNDLES = ['encoder.mlmodelc', 'decoder.mlmodelc', 'joint.mlmodelc'] as const

/** Any real CoreML weight blob is megabytes; this only rules out empty stubs. */
export const STREAMING_MIN_WEIGHT_BYTES = 1024

/** Reads the disk so `streamingModelIsComplete` stays free of `fs`. */
export interface FileProbe {
  /** Byte size of a file, or null when it is missing or not a file. */
  size(path: string): number | null
}

/**
 * Whether a downloaded streaming variant is actually loadable.
 *
 * An interrupted download leaves the folder, `metadata.json` and the
 * `.mlmodelc` skeletons in place while a weight blob is still a
 * `weight.bin.partial`. CoreML then fails with execution-plan error -14 at
 * warm-up time. Mirrors `NemotronVariant.isDownloaded` in the helper so the
 * UI offers Download instead of a warm error that never clears.
 */
export function streamingModelIsComplete(dir: string, probe: FileProbe): boolean {
  for (const plain of ['metadata.json', 'tokenizer.json']) {
    if (probe.size(`${dir}/${plain}`) === null) return false
  }
  return STREAMING_REQUIRED_BUNDLES.every(bundle => {
    if (probe.size(`${dir}/${bundle}/coremldata.bin`) === null) return false
    const weights = probe.size(`${dir}/${bundle}/weights/weight.bin`)
    return weights !== null && weights > STREAMING_MIN_WEIGHT_BYTES
  })
}
