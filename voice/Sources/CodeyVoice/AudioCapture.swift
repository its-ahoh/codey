import AVFoundation
import Foundation
import QuartzCore  // CACurrentMediaTime

/// Captures microphone audio at 16 kHz mono Float32 using AVAudioEngine.
final class AudioCapture {
    private let engine = AVAudioEngine()
    private var pcmBuffer: [Float] = []
    /// Guards `pcmBuffer` so streaming consumers can read a coherent snapshot
    /// while the audio tap thread keeps appending. Lock is held only for the
    /// length of an `append` or a snapshot copy — never across the resample
    /// math, so contention is minimal.
    private let bufferLock = NSLock()
    private let sampleRate: Double = 16000
    private let maxDurationSeconds: Double = 300  // 5-minute cap
    private(set) var isRecording = false
    /// Last time we fired `onLevel`, in mach absolute time. Cheap to read on
    /// the tap thread; used to throttle the level meter to ~20 Hz so we don't
    /// hop to the main queue more often than the user can perceive.
    private var lastLevelEmit: TimeInterval = 0

    /// Called with the full PCM buffer when recording stops.
    var onRecordingComplete: (([Float]) -> Void)?

    /// Called from the audio tap thread with each freshly resampled 16 kHz mono
    /// chunk (~20-50 ms). Receiver must hop to main if it touches AppKit. Used by
    /// the realtime transcription engine to forward audio over WebSocket as it
    /// arrives. Always-accumulate + additionally-emit: the full buffer snapshot
    /// remains available via currentSamplesSnapshot(). Nil = batch-only behavior.
    var onChunk: (([Float]) -> Void)?

    /// Called from the audio tap thread (~every buffer, ~20-50ms) with a 0..1
    /// RMS level of the latest input. Receiver must hop to main if it touches
    /// AppKit. Used by the HUD waveform indicator.
    var onLevel: ((Float) -> Void)?

    /// Pre-allocate the recording buffer so the audio tap thread never has to
    /// realloc while the user is talking. Previously this also called
    /// `engine.prepare()` to warm Core Audio, but installing the tap *after*
    /// prepare turned out to leave the graph in a state where the tap never
    /// fired — buffer stayed empty, transcribe-step bailed out. Apple's docs
    /// require taps to be installed before prepare; doing it lazily in
    /// `startRecording` is simpler and only costs a small one-time delay on
    /// the very first press.
    func prewarm() {
        bufferLock.lock()
        if pcmBuffer.capacity < Int(sampleRate * maxDurationSeconds) {
            pcmBuffer.reserveCapacity(Int(sampleRate * maxDurationSeconds))
        }
        bufferLock.unlock()
    }

    func startRecording() throws {
        guard !isRecording else { return }

        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)

        // Install tap at device sample rate, we'll resample to 16 kHz
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.processBuffer(buffer)
        }

        bufferLock.lock()
        pcmBuffer.removeAll(keepingCapacity: true)  // keep the reserved 5-min capacity
        bufferLock.unlock()
        try engine.start()
        isRecording = true
    }

    func stopRecording() {
        guard isRecording else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        bufferLock.lock()
        let snapshot = pcmBuffer
        bufferLock.unlock()
        onRecordingComplete?(snapshot)
    }

    /// Coherent copy of the buffer captured so far. Safe to call from any
    /// thread while recording. Used by the local streaming transcriber to
    /// pull periodic snapshots without disturbing the audio tap.
    func currentSamplesSnapshot() -> [Float] {
        bufferLock.lock()
        defer { bufferLock.unlock() }
        return pcmBuffer
    }

    /// Stop the engine and DISCARD the buffer without firing the complete
    /// callback. Used by the Esc-to-cancel path so the transcription pipeline
    /// never sees the audio.
    func cancelRecording() {
        guard isRecording else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        bufferLock.lock(); pcmBuffer.removeAll(); bufferLock.unlock()
    }

    private func processBuffer(_ buffer: AVAudioPCMBuffer) {
        let frameLength = Int(buffer.frameLength)
        guard let channelData = buffer.floatChannelData else { return }

        let srcRate = buffer.format.sampleRate
        let channelCount = Int(buffer.format.channelCount)

        // Mix to mono. We do this even when channelCount == 1 (just a copy)
        // so the rest of the path is uniform.
        var mono = [Float](repeating: 0, count: frameLength)
        for ch in 0..<channelCount {
            let ptr = channelData[ch]
            for i in 0..<frameLength { mono[i] += ptr[i] }
        }
        if channelCount > 1 {
            let scale = 1.0 / Float(channelCount)
            for i in 0..<frameLength { mono[i] *= scale }
        }

        // Level meter — throttled to ~20 Hz so the HUD meter updates don't
        // hop to main on every audio tap (20–50 ms cadence).
        if frameLength > 0, let cb = onLevel {
            let now = CACurrentMediaTime()
            if now - lastLevelEmit >= 0.05 {
                lastLevelEmit = now
                var sumSq: Float = 0
                for i in 0..<frameLength { sumSq += mono[i] * mono[i] }
                let rms = sqrt(sumSq / Float(frameLength))
                cb(min(1.0, rms * 6.0))
            }
        }

        // Resample to 16 kHz if needed (linear interpolation — fast enough
        // for our buffer sizes and produces audio that's quite acceptable
        // for Whisper's mel-spectrogram front end).
        let chunk: [Float]
        if srcRate != sampleRate {
            let ratio = srcRate / sampleRate
            let outCount = Int(Double(frameLength) / ratio)
            var resampled = [Float](repeating: 0, count: outCount)
            for i in 0..<outCount {
                let srcIdx = Double(i) * ratio
                let idx0 = Int(srcIdx)
                let frac = Float(srcIdx - Double(idx0))
                if idx0 + 1 < frameLength {
                    resampled[i] = mono[idx0] * (1 - frac) + mono[idx0 + 1] * frac
                } else if idx0 < frameLength {
                    resampled[i] = mono[idx0]
                }
            }
            chunk = resampled
        } else {
            chunk = mono
        }

        bufferLock.lock()
        pcmBuffer.append(contentsOf: chunk)
        let totalCount = pcmBuffer.count
        bufferLock.unlock()

        // Emit the resampled chunk for realtime streaming consumers (e.g. the
        // WebSocket transcription engine). Always accumulate above; additionally
        // emit exactly once here when a consumer is subscribed. Fires outside the
        // lock so the consumer can take its time without blocking the audio tap.
        if let cb = onChunk {
            cb(chunk)
        }

        // Auto-stop at buffer cap
        if Double(totalCount) / sampleRate >= maxDurationSeconds {
            DispatchQueue.main.async { [weak self] in
                self?.stopRecording()
            }
        }
    }
}
