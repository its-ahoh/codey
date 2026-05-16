import Foundation
import WhisperBridge

/// Wraps whisper.cpp for audio transcription.
final class WhisperEngine {
    private var ctx: OpaquePointer?
    private let queue = DispatchQueue(label: "whisper-inference", qos: .userInitiated)

    var isLoaded: Bool { ctx != nil }

    /// Load a ggml model from disk. Dispatches onto the inference queue to avoid races.
    func loadModel(at path: String) throws {
        try queue.sync {
            if ctx != nil {
                whisper_free(ctx)
                ctx = nil
            }
            ctx = whisper_init_from_file(path)
            guard ctx != nil else {
                throw WhisperError.modelLoadFailed(path)
            }
        }
    }

    /// Explicit teardown — call from VoiceCoordinator.applicationWillTerminate.
    /// Must not be called while a `transcribe` is in flight.
    func shutdown() {
        queue.sync {
            if let ctx {
                whisper_free(ctx)
            }
            ctx = nil
        }
    }

    /// Transcribe 16 kHz mono Float32 audio. Returns UTF-8 text.
    func transcribe(audio: [Float], language: String = "auto") async throws -> String {
        return try await withCheckedThrowingContinuation { cont in
            queue.async { [weak self] in
                guard let self, let ctx = self.ctx else {
                    cont.resume(throwing: WhisperError.modelNotLoaded)
                    return
                }
                var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)

                // Set language — keep NSString alive through whisper_full via withExtendedLifetime
                let langNS = language == "auto" ? nil : (language as NSString)
                if let langNS {
                    params.language = langNS.utf8String!
                    params.detect_language = false
                } else {
                    params.language = "auto"
                    params.detect_language = true
                }

                // Tuning for real-time use
                params.n_threads = Int32(max(1, ProcessInfo.processInfo.activeProcessorCount / 2))
                params.print_realtime = false
                params.print_progress = false
                params.print_timestamps = false
                params.print_special = false
                params.translate = false
                params.single_segment = false
                params.no_timestamps = true

                // Run inference — keep langNS alive so params.language pointer stays valid
                let result = withExtendedLifetime(langNS) {
                    whisper_full(ctx, params, audio, Int32(audio.count))
                }
                guard result == 0 else {
                    cont.resume(throwing: WhisperError.inferenceFailed(result))
                    return
                }

                // Extract text
                let nSegments = whisper_full_n_segments(ctx)
                var text = ""
                for i in 0..<nSegments {
                    if let cStr = whisper_full_get_segment_text(ctx, i) {
                        text += String(cString: cStr)
                    }
                }

                cont.resume(returning: text.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
    }

    deinit {
        // Safety net: shutdown() should already have been called.
        // No queue dispatch here — by the time deinit runs, no external
        // strong references exist, so no transcribe closures can be queued.
        if let ctx {
            whisper_free(ctx)
        }
    }
}

enum WhisperError: LocalizedError {
    case modelLoadFailed(String)
    case modelNotLoaded
    case inferenceFailed(Int32)

    var errorDescription: String? {
        switch self {
        case .modelLoadFailed(let path): return "Failed to load model at \(path)"
        case .modelNotLoaded: return "No model loaded"
        case .inferenceFailed(let code): return "Whisper inference failed (code \(code))"
        }
    }
}
