import AVFoundation
import Foundation

/// Captures microphone audio at 16 kHz mono Float32 using AVAudioEngine.
final class AudioCapture {
    private let engine = AVAudioEngine()
    private var pcmBuffer: [Float] = []
    private let sampleRate: Double = 16000
    private let maxDurationSeconds: Double = 300  // 5-minute cap
    private(set) var isRecording = false

    /// Called with the full PCM buffer when recording stops.
    var onRecordingComplete: (([Float]) -> Void)?

    /// Called from the audio tap thread (~every buffer, ~20-50ms) with a 0..1
    /// RMS level of the latest input. Receiver must hop to main if it touches
    /// AppKit. Used by the HUD waveform indicator.
    var onLevel: ((Float) -> Void)?

    func startRecording() throws {
        guard !isRecording else { return }

        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)

        // Install tap at device sample rate, we'll resample to 16 kHz
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.processBuffer(buffer)
        }

        pcmBuffer.removeAll()
        try engine.start()
        isRecording = true
    }

    func stopRecording() {
        guard isRecording else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        onRecordingComplete?(pcmBuffer)
    }

    /// Stop the engine and DISCARD the buffer without firing the complete
    /// callback. Used by the Esc-to-cancel path so the transcription pipeline
    /// never sees the audio.
    func cancelRecording() {
        guard isRecording else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        pcmBuffer.removeAll()
    }

    private func processBuffer(_ buffer: AVAudioPCMBuffer) {
        let frameLength = Int(buffer.frameLength)
        guard let channelData = buffer.floatChannelData else { return }

        let srcRate = buffer.format.sampleRate
        let channelCount = Int(buffer.format.channelCount)

        // Quick RMS of this raw buffer for the level meter — compute on the
        // original (pre-resample) mono mix to avoid the resampling cost being
        // on the audio thread path twice. ~20-50ms cadence depending on
        // device buffer size.
        var rmsSq: Float = 0

        // Mix to mono if stereo
        var mono = [Float](repeating: 0, count: frameLength)
        for ch in 0..<channelCount {
            let ptr = channelData[ch]
            for i in 0..<frameLength {
                mono[i] += ptr[i]
            }
        }
        if channelCount > 1 {
            let scale = 1.0 / Float(channelCount)
            for i in 0..<frameLength { mono[i] *= scale }
        }

        if frameLength > 0 {
            for i in 0..<frameLength { rmsSq += mono[i] * mono[i] }
            let rms = sqrt(rmsSq / Float(frameLength))
            // Mic input typically peaks around 0.1-0.3 RMS for normal speech;
            // scale into 0..1 for the meter so quiet voice still looks lively.
            let level = min(1.0, rms * 6.0)
            if let cb = onLevel {
                cb(level)
            }
        }

        // Resample to 16 kHz if needed
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
            pcmBuffer.append(contentsOf: resampled)
        } else {
            pcmBuffer.append(contentsOf: mono)
        }

        // Auto-stop at buffer cap
        if Double(pcmBuffer.count) / sampleRate >= maxDurationSeconds {
            DispatchQueue.main.async { [weak self] in
                self?.stopRecording()
            }
        }
    }
}
