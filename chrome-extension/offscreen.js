let recordingStream = null
let recorder = null
let recordingChunks = []

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function releaseStream() {
  recordingStream?.getTracks().forEach(track => track.stop())
  recordingStream = null
}

function encodeWav(chunks, sampleRate) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const value of chunk) {
      const sample = Math.max(-1, Math.min(1, value))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

async function startRecording() {
  if (recorder && recorder.state !== 'inactive') return { ok: true }
  recordingStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  })
  const mimeType = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    .find(type => MediaRecorder.isTypeSupported(type))
  recorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream)
  recordingChunks = []
  recorder.addEventListener('dataavailable', event => {
    if (event.data.size) recordingChunks.push(event.data)
  })
  recorder.start()
  return { ok: true }
}

async function stopRecording() {
  if (!recorder || recorder.state === 'inactive') throw new Error('Voice recording is not active')
  const activeRecorder = recorder
  return await new Promise((resolve, reject) => {
    activeRecorder.addEventListener('error', event => reject(event.error || new Error('Voice recording failed')), { once: true })
    activeRecorder.addEventListener('stop', async () => {
      let decodeContext = null
      try {
        const blob = new Blob(recordingChunks, { type: activeRecorder.mimeType || 'audio/webm' })
        if (!blob.size) throw new Error('The recording was empty')
        decodeContext = new AudioContext()
        const decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer())
        const samples = new Float32Array(decoded.getChannelData(0))
        const wav = encodeWav([samples], decoded.sampleRate)
        resolve({ ok: true, mimeType: 'audio/wav', data: bufferToBase64(wav) })
      } catch (error) {
        reject(error)
      } finally {
        if (decodeContext) void decodeContext.close().catch(() => undefined)
        recorder = null
        recordingChunks = []
        releaseStream()
      }
    }, { once: true })
    activeRecorder.stop()
  })
}

function cancelRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  recorder = null
  recordingChunks = []
  releaseStream()
  return { ok: true }
}

const voicePort = chrome.runtime.connect({ name: 'codey-voice' })

voicePort.onMessage.addListener(message => {
  void (async () => {
    let result
    try {
      if (message.type === 'codey:voice-start') result = await startRecording()
      else if (message.type === 'codey:voice-stop') result = await stopRecording()
      else if (message.type === 'codey:voice-cancel') result = cancelRecording()
      else result = { ok: false, error: 'Unknown voice command' }
    } catch (error) {
      recorder = null
      recordingChunks = []
      releaseStream()
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : '',
      }
    }
    voicePort.postMessage({ id: message.id, result })
  })()
})
