import { describe, expect, it } from 'vitest'
import {
  allStreamingModelIds,
  isBogusWarmMarkerKey,
  isOnDeviceVoiceProvider,
  parseStreamingModelId,
  selectedOnDeviceModel,
  streamingModelDir,
  streamingModelId,
  streamingModelIsComplete,
  warmMarkerDeleteKeys,
  warmMarkerWriteKeys,
} from './voice-models'

describe('isOnDeviceVoiceProvider', () => {
  it('treats both local engines as on-device and the API ones as not', () => {
    expect(isOnDeviceVoiceProvider('local')).toBe(true)
    expect(isOnDeviceVoiceProvider('localStreaming')).toBe(true)
    expect(isOnDeviceVoiceProvider('api')).toBe(false)
    expect(isOnDeviceVoiceProvider('realtime')).toBe(false)
    expect(isOnDeviceVoiceProvider(undefined)).toBe(false)
  })
})

describe('parseStreamingModelId', () => {
  it('parses the canonical id shape', () => {
    expect(parseStreamingModelId('nemotron/multilingual/1120ms')).toEqual({ languageDir: 'multilingual', chunkMs: 1120 })
    expect(parseStreamingModelId('nemotron/latin/560ms')).toEqual({ languageDir: 'latin', chunkMs: 560 })
  })

  it('rejects WhisperKit names and malformed ids', () => {
    expect(parseStreamingModelId('openai_whisper-large-v3_turbo_954MB')).toBeNull()
    expect(parseStreamingModelId('nemotron/multilingual')).toBeNull()
    expect(parseStreamingModelId('nemotron/klingon/1120ms')).toBeNull()
    expect(parseStreamingModelId('nemotron/multilingual/fast')).toBeNull()
    expect(parseStreamingModelId('nemotron/multilingual/999ms')).toBeNull()
    expect(parseStreamingModelId(undefined)).toBeNull()
  })

  it('round-trips through streamingModelId', () => {
    for (const id of allStreamingModelIds()) {
      expect(streamingModelId(parseStreamingModelId(id)!)).toBe(id)
    }
  })
})

describe('selectedOnDeviceModel', () => {
  it('picks the model that matches the provider, never the other engine', () => {
    const voice = { provider: 'local', localModel: 'openai_whisper-small', streamingModel: 'nemotron/multilingual/1120ms' }
    expect(selectedOnDeviceModel(voice)).toBe('openai_whisper-small')
    expect(selectedOnDeviceModel({ ...voice, provider: 'localStreaming' })).toBe('nemotron/multilingual/1120ms')
  })

  it('is null for API providers and for a blank model', () => {
    expect(selectedOnDeviceModel({ provider: 'api', localModel: 'x', streamingModel: 'y' })).toBeNull()
    expect(selectedOnDeviceModel({ provider: 'realtime' })).toBeNull()
    expect(selectedOnDeviceModel({ provider: 'localStreaming', streamingModel: '  ' })).toBeNull()
    expect(selectedOnDeviceModel(null)).toBeNull()
  })
})

describe('streamingModelDir', () => {
  it('mirrors the helper cache layout', () => {
    expect(streamingModelDir('/Users/me', 'nemotron/multilingual/2240ms')).toBe(
      '/Users/me/Library/Application Support/FluidAudio/Models/nemotron-multilingual/multilingual/2240ms',
    )
  })

  it('is null for a non-streaming id so a WhisperKit folder is never deleted by mistake', () => {
    expect(streamingModelDir('/Users/me', 'openai_whisper-base')).toBeNull()
  })
})

describe('streamingModelIsComplete', () => {
  const DIR = '/cache/1120ms'
  // What a finished download looks like on disk.
  const full: Record<string, number> = {
    [`${DIR}/metadata.json`]: 3005,
    [`${DIR}/tokenizer.json`]: 284969,
    [`${DIR}/encoder.mlmodelc/coremldata.bin`]: 572,
    [`${DIR}/encoder.mlmodelc/weights/weight.bin`]: 564646848,
    [`${DIR}/decoder.mlmodelc/coremldata.bin`]: 433,
    [`${DIR}/decoder.mlmodelc/weights/weight.bin`]: 29870592,
    [`${DIR}/joint.mlmodelc/coremldata.bin`]: 341,
    [`${DIR}/joint.mlmodelc/weights/weight.bin`]: 18911744,
  }
  const probeFor = (files: Record<string, number>) => ({
    size: (p: string) => (p in files ? files[p] : null),
  })

  it('accepts a finished download', () => {
    expect(streamingModelIsComplete(DIR, probeFor(full))).toBe(true)
  })

  it('rejects an interrupted download that only left weight.bin.partial behind', () => {
    const partial = { ...full }
    delete partial[`${DIR}/encoder.mlmodelc/weights/weight.bin`]
    partial[`${DIR}/encoder.mlmodelc/weights/weight.bin.partial`] = 215602925
    expect(streamingModelIsComplete(DIR, probeFor(partial))).toBe(false)
  })

  it('rejects a zero-byte weight stub', () => {
    expect(streamingModelIsComplete(DIR, probeFor({ ...full, [`${DIR}/joint.mlmodelc/weights/weight.bin`]: 0 }))).toBe(false)
  })

  it('rejects a folder whose tokenizer never arrived', () => {
    const missing = { ...full }
    delete missing[`${DIR}/tokenizer.json`]
    expect(streamingModelIsComplete(DIR, probeFor(missing))).toBe(false)
  })
})

describe('warm marker keys', () => {
  it('aliases a Whisper id so either spelling looks up', () => {
    expect(new Set(warmMarkerWriteKeys('openai_whisper-large-v3_turbo_954MB'))).toEqual(
      new Set(['large-v3_turbo_954MB', 'openai_whisper-large-v3_turbo_954MB'])
    )
    expect(new Set(warmMarkerWriteKeys('large-v3_turbo_954MB'))).toEqual(
      new Set(['large-v3_turbo_954MB', 'openai_whisper-large-v3_turbo_954MB'])
    )
  })

  it('stores a streaming id under its own name only', () => {
    expect(warmMarkerWriteKeys('nemotron/multilingual/1120ms')).toEqual(['nemotron/multilingual/1120ms'])
  })

  it('clears the bogus prefixed alias older builds wrote for streaming ids', () => {
    // Without this the leftover key still matched in the UI's variant check
    // and a deleted streaming model kept reporting "Ready".
    expect(warmMarkerDeleteKeys('nemotron/multilingual/1120ms')).toEqual([
      'nemotron/multilingual/1120ms',
      'openai_whisper-nemotron/multilingual/1120ms',
    ])
  })

  it('deletes every key it would have written for a Whisper id', () => {
    const written = new Set(warmMarkerWriteKeys('large-v3_turbo_954MB'))
    for (const key of written) {
      expect(warmMarkerDeleteKeys('large-v3_turbo_954MB')).toContain(key)
    }
  })
})

describe('isBogusWarmMarkerKey', () => {
  it('flags the prefixed streaming alias left by older builds', () => {
    expect(isBogusWarmMarkerKey('openai_whisper-nemotron/multilingual/1120ms')).toBe(true)
  })

  it('leaves real Whisper and streaming keys alone', () => {
    expect(isBogusWarmMarkerKey('openai_whisper-large-v3_turbo_954MB')).toBe(false)
    expect(isBogusWarmMarkerKey('nemotron/multilingual/1120ms')).toBe(false)
  })
})
