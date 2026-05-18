import Foundation
import WhisperKit

/// Map UI/config variant strings to the bare folder names WhisperKit expects.
/// - Strips the `openai_whisper-` repo prefix.
/// - Rewrites legacy hyphenated names (e.g. `large-v3-turbo`) to the real
///   HuggingFace folder names (`large-v3_turbo_954MB`, preferred quantized).
///   Saved configs from earlier builds may still hold the hyphen form.
func normalizeVariant(_ raw: String) -> String {
    let stripped = raw.hasPrefix("openai_whisper-")
        ? String(raw.dropFirst("openai_whisper-".count))
        : raw
    let aliases: [String: String] = [
        "large-v3-turbo": "large-v3_turbo_954MB",
        "large-v3-v20240930-turbo": "large-v3-v20240930_turbo_632MB",
    ]
    return aliases[stripped] ?? stripped
}

/// On-device transcription via WhisperKit (CoreML / ANE).
///
/// Lazy-loaded: the model isn't materialized until the first `transcribe(...)`
/// call. After `idleUnloadAfter` seconds with no activity, `unloadIfIdle()`
/// drops the pipeline so the Neural Engine state and ~600 MB of weights are
/// released — keeping idle resource use near zero (the whole point of moving
/// off whisper.cpp's eager Metal context).
final class WhisperKitEngine: TranscriptionEngineProtocol, @unchecked Sendable {
    private var pipeline: WhisperKit?
    private var loadedModel: String?
    private var config: VoiceConfig
    private var lastUsed: Date = .distantPast
    private let idleUnloadAfter: TimeInterval = 30
    private let loadQueue = DispatchQueue(label: "codey.voice.whisperkit.load")

    init(config: VoiceConfig) {
        self.config = config
    }

    func updateConfig(_ config: VoiceConfig) {
        let modelChanged = config.localModel != self.config.localModel
        self.config = config
        if modelChanged {
            // Drop the pipeline; next transcribe will reload the new variant.
            loadQueue.sync { self.pipeline = nil; self.loadedModel = nil }
        }
    }

    func transcribe(audio: [Float], language: String) async throws -> String {
        let pipe = try await withLoadTimeout(seconds: 10) { try await self.ensurePipeline() }
        lastUsed = Date()

        // Peak-normalize to ~0.9 before sending. Mic levels often peak around
        // 0.1-0.2 in real recordings; large-v3 turbo's confidence drops on
        // low-energy audio and short clips can come back empty. Software gain
        // here gives the encoder a stronger signal without us touching system
        // mic settings.
        let normalized = peakNormalize(audio, target: 0.9)

        var options = DecodingOptions()
        options.task = .transcribe
        if !language.isEmpty && language != "auto" {
            options.language = language
        }
        // Greedy + low temp keeps things fast on ANE; turbo is accurate enough.
        options.temperature = 0.0
        // Decoder max output tokens. 144 ≈ 18s of speech, enough for the
        // press-to-talk use case; lower than the 224 default = fewer worst-case
        // decoder steps.
        options.sampleLength = 144
        // We never use timestamps in the injected text — disabling lets the
        // decoder skip generating timestamp tokens at every step.
        options.withoutTimestamps = true
        // Prefill SOT/language/task tokens in one shot rather than step-by-step.
        // Both faster (first-token latency) and more stable (less drift toward
        // English on short Chinese clips).
        options.usePrefillPrompt = true
        // Skip silence chunks via voice activity detection — large win on
        // press-to-talk audio that has leading/trailing silence and pauses.
        options.chunkingStrategy = .vad
        // If a chunk decodes with very low logprob, retry with slightly higher
        // temperature instead of returning an empty/garbled result. CJK on
        // quantized turbo trips this often; 0 means "give up, return empty".
        options.temperatureFallbackCount = 2
        // VAD splits long press-to-talk clips into N voiced chunks; with
        // workers > 1 they decode concurrently. 4 saturates ANE+GPU on
        // M-series; short single-chunk clips are unaffected.
        options.concurrentWorkerCount = 4

        let t0 = Date()
        let results = try await pipe.transcribe(audioArray: normalized, decodeOptions: options)
        print(String(format: "WhisperKitEngine: decode took %.2fs (%d samples)", Date().timeIntervalSince(t0), normalized.count))
        let text = results.map { $0.text }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return text
    }

    private func peakNormalize(_ samples: [Float], target: Float) -> [Float] {
        var peak: Float = 0
        for s in samples {
            let a = abs(s)
            if a > peak { peak = a }
        }
        guard peak > 0.0001, peak < target else { return samples }
        let gain = target / peak
        return samples.map { $0 * gain }
    }

    func unloadIfIdle() {
        guard pipeline != nil else { return }
        if Date().timeIntervalSince(lastUsed) >= idleUnloadAfter {
            forceUnload(reason: "idle for >\(Int(idleUnloadAfter))s")
        }
    }

    func forceUnload(reason: String) {
        guard pipeline != nil else { return }
        loadQueue.sync {
            print("WhisperKitEngine: unloading pipeline (\(reason))")
            self.pipeline = nil
            self.loadedModel = nil
        }
    }

    // MARK: - Internals

    private func ensurePipeline() async throws -> WhisperKit {
        if let p = pipeline, loadedModel == config.localModel {
            return p
        }
        // WhisperKit's HF glob is `*openai*<variant>/*`; the variant must be
        // the bare name (`large-v3-turbo`), not the full folder name
        // (`openai_whisper-large-v3-turbo`). UI/config may store either form.
        let modelName = normalizeVariant(config.localModel)
        let t0 = Date()
        print("WhisperKitEngine: loading model '\(modelName)'")

        // Pin compute units: ANE for encoder (fastest on M-series, big mel +
        // attention layers), GPU for decoder (token-by-token autoregressive,
        // ANE underutilized here). This is the WhisperKit benchmark-winning
        // combo on Apple Silicon — leaving it to .all sometimes lets CoreML
        // route encoder to GPU, costing 30-40% throughput.
        let computeOptions = ModelComputeOptions(
            audioEncoderCompute: .cpuAndNeuralEngine,
            textDecoderCompute: .cpuAndGPU
        )
        let kitConfig = WhisperKitConfig(
            model: modelName,
            computeOptions: computeOptions,
            verbose: false,
            logLevel: .info,
            prewarm: false,
            load: true,
            download: true
        )
        let pipe = try await WhisperKit(kitConfig)
        let elapsed = Date().timeIntervalSince(t0)
        self.pipeline = pipe
        self.loadedModel = modelName
        print(String(format: "WhisperKitEngine: model '%@' ready (load took %.1fs)", modelName, elapsed))
        return pipe
    }

    private func withLoadTimeout<T: Sendable>(seconds: TimeInterval, _ op: @Sendable @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await op() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw NSError(domain: "WhisperKitEngine", code: -1, userInfo: [NSLocalizedDescriptionKey: "Model load/transcribe timed out after \(Int(seconds))s"])
            }
            guard let first = try await group.next() else {
                throw NSError(domain: "WhisperKitEngine", code: -2, userInfo: [NSLocalizedDescriptionKey: "Task group returned no result"])
            }
            group.cancelAll()
            return first
        }
    }
}
