import Foundation

/// Convert Float32 samples in `[-1, 1]` to 16-bit signed PCM little-endian Data.
/// Each Float32 sample is clamped, scaled by 32767, and stored as little-endian Int16.
/// Shared by the WAV encoder (batch path) and the realtime WebSocket path.
func pcm16Data(from samples: [Float]) -> Data {
    var data = Data(count: samples.count * 2)
    data.withUnsafeMutableBytes { raw in
        let pcm = raw.baseAddress!.assumingMemoryBound(to: Int16.self)
        for i in 0..<samples.count {
            let s = samples[i]
            let c = s < -1 ? -1 : (s > 1 ? 1 : s)
            pcm[i] = Int16(c * 32767.0).littleEndian
        }
    }
    return data
}
