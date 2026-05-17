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

    private func processBuffer(_ buffer: AVAudioPCMBuffer) {
        let frameLength = Int(buffer.frameLength)
        guard let channelData = buffer.floatChannelData else { return }

        let srcRate = buffer.format.sampleRate
        let channelCount = Int(buffer.format.channelCount)

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
