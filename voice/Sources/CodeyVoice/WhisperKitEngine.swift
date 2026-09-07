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
    /// Mutable config is behind a lock because transcription/prewarm tasks can
    /// read config concurrently with updateConfig (gateway poll).
    private let configLock = NSLock()
    private var _config: VoiceConfig
    /// Whisper is intentionally batch-only: Listening never performs partial
    /// decoding. Kept only to satisfy the shared engine protocol.
    var onPartial: ((String) -> Void)?
    private var lastUsed: Date = .distantPast
    // Kept the pipeline warm across pauses in dictation. 30s was over-eager —
    // it punished every "type a sentence, think, type another" cadence with a
    // 1-3s cold reload. 5 min turned out to be over-eager too: a measured cold
    // reload of large-v3-turbo is ~4.8s, and dictation across a working
    // session has gaps far longer than five minutes, so the reload was landing
    // on a large share of presses. 30 min covers a working session while still
    // releasing the ~600 MB and the ANE state when the user genuinely walks
    // away, which was the point of moving off whisper.cpp's eager context.
    private let idleUnloadAfter: TimeInterval = 1800
    /// How long to wait for the pipeline before giving up.
    ///
    /// This was 10s, which is right for the steady state — a warm load is
    /// ~200ms and a cold one ~5s — but wrong for the case that actually
    /// matters: when CoreML has to recompile the model for the Neural Engine
    /// it takes minutes (measured at 315s), and that recompile is triggered by
    /// something the user never sees, namely a new build of this binary. The
    /// old budget turned a slow-but-succeeding load into a hard failure, and
    /// the log said so in the same breath as "ready (load took 314.7s)".
    ///
    /// Ten minutes is not a wait anyone should sit through; it is a ceiling
    /// that stops a genuinely wedged load from hanging forever. The user's
    /// escape hatch is pressing the key again, which now abandons the turn.
    private static let loadTimeoutSeconds: TimeInterval = 600
    /// Past this, say out loud that we are compiling rather than hanging.
    private static let slowLoadWarnSeconds: TimeInterval = 8
    /// Pin compute units: ANE for the encoder (fastest on M-series, big mel +
    /// attention layers), GPU for the decoder (token-by-token autoregressive,
    /// ANE underutilized here). This is the WhisperKit benchmark-winning combo
    /// on Apple Silicon - leaving it at `.all` sometimes lets CoreML route the
    /// encoder to GPU, costing 30-40% throughput.
    ///
    /// Exposed rather than local because CoreML compiles and caches per
    /// compute-unit configuration, so the `--warm-model` path has to ask for
    /// the exact same one. It used to use the default, which meant every warm
    /// compiled a variant the engine never loads: the marker recorded a
    /// plausible-looking 12.9s while the first real press still paid the full
    /// ~320s ANE compile. Anything that loads this model must go through here.
    static let computeOptions = ModelComputeOptions(
        audioEncoderCompute: .cpuAndNeuralEngine,
        textDecoderCompute: .cpuAndGPU
    )
    private let loadQueue = DispatchQueue(label: "codey.voice.whisperkit.load")
    /// The load currently in flight, with the variant it is loading.
    ///
    /// `ensurePipeline` is reachable from prewarm and final transcription at
    /// once. Callers join the in-flight load so a cold start cannot materialize
    /// the same weights more than once. Keyed by variant so a load kicked off
    /// before the user switched models isn't handed back as the new one.
    private var loadTask: (model: String, task: Task<WhisperKit, Error>)?
    private let loadTaskLock = NSLock()

    init(config: VoiceConfig) {
        self._config = config
    }

    /// Tokenized vocabulary hint for `DecodingOptions.promptTokens`, or nil
    /// when the user has no terms.
    ///
    /// Whisper conditions the decoder on this as if it were the text just
    /// before the audio, so a name the model would otherwise snap to a common
    /// word becomes reachable. This was dead on WhisperKit 0.18, where setting
    /// `promptTokens` to anything at all returned an empty transcript; 1.1
    /// fixed it. Verified against `large-v3-v20240930_turbo_632MB`:
    /// "Whisper Kid" -> "WhisperKit", "Cody" -> "Codey", and 用Code -> 用Codey
    /// on Chinese audio, with no change to a clip containing none of the terms.
    ///
    /// Special tokens are filtered out: the values are spliced in ahead of the
    /// SOT/language/task prefill, and a stray `<|...|>` there desynchronizes
    /// the whole prefix. Returns nil rather than an empty array so the option
    /// stays unset when there is nothing to say — WhisperKit takes a different
    /// (slower) decode path whenever `promptTokens` is non-nil.
    private func vocabularyPromptTokens(_ pipe: WhisperKit, language: String) -> [Int]? {
        let terms = configLock.withLock { _config.vocabulary }
        guard let text = Vocabulary.promptText(terms, repeats: 2, language: language),
              let tokenizer = pipe.tokenizer else { return nil }
        let specialBegin = tokenizer.specialTokens.specialTokenBegin
        // Leading space: Whisper's BPE encodes a word differently at the start
        // of a segment than mid-sentence, and mid-sentence is what the model
        // will actually be decoding.
        let tokens = tokenizer.encode(text: " " + text).filter { $0 < specialBegin }
        return tokens.isEmpty ? nil : tokens
    }

    /// Eagerly load the model so the first user press doesn't pay the
    /// multi-second load cost. Safe to call multiple times — no-op if already
    /// loaded with the same variant. Errors are logged and swallowed; the
    /// next real `transcribe` call will surface them properly.
    func prewarm() {
        Task.detached(priority: .utility) { [weak self] in
            guard let self = self else { return }
            do {
                _ = try await self.ensurePipeline()
                self.lastUsed = Date()
            } catch {
                print("WhisperKitEngine: prewarm failed — \(error.localizedDescription)")
            }
        }
    }

    func updateConfig(_ config: VoiceConfig) {
        let modelChanged = configLock.withLock { config.localModel != _config.localModel }
        configLock.withLock { _config = config }
        if modelChanged {
            // Drop the pipeline; next transcribe will reload the new variant.
            forceUnload(reason: "local model changed to \(config.localModel)")
        }
    }

    func transcribe(audio: [Float], language: String) async throws -> String {
        let pipe = try await withLoadTimeout(seconds: Self.loadTimeoutSeconds) { try await self.ensurePipeline() }
        lastUsed = Date()

        // Peak-normalize to ~0.9 before sending. Mic levels often peak around
        // 0.1-0.2 in real recordings; large-v3 turbo's confidence drops on
        // low-energy audio and short clips can come back empty. Software gain
        // here gives the encoder a stronger signal without us touching system
        // mic settings.
        let normalized = peakNormalize(audio, target: 0.9)

        var options = DecodingOptions()
        options.promptTokens = vocabularyPromptTokens(pipe, language: language)
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
        // Retrying a low-confidence chunk at a higher temperature costs a full
        // extra decode pass each time, and CJK on quantized turbo trips the
        // threshold often enough that the same audio could run three times.
        // That is the source of the "sometimes 1s, sometimes 5s" spread the
        // user actually feels; the quality it buys back is a marginally
        // cleaner sentence on the clips that were already marginal.
        options.temperatureFallbackCount = 0
        // VAD splits long press-to-talk clips into N voiced chunks; with
        // workers > 1 they decode concurrently. 4 saturates ANE+GPU on
        // M-series; short single-chunk clips are unaffected.
        options.concurrentWorkerCount = 4

        let t0 = Date()
        let results = try await pipe.transcribe(audioArray: normalized, decodeOptions: options)
        let elapsed = Date().timeIntervalSince(t0)
        let text = results.map { Self.stripWhisperTags($0.text) }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        print(String(format: "WhisperKitEngine: decode took %.2fs (%d samples, full)", elapsed, normalized.count))
        return text
    }

    /// Defensively strip any Whisper special tokens from result text.
    static func stripWhisperTags(_ text: String) -> String {
        guard text.contains("<|") else { return text }
        // Pattern matches `<|...|>` lazily so a single sequence isn't merged
        // across multiple tokens on the same line.
        let pattern = #"<\|[^|]*\|>"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
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

    /// Whether the pipeline for the *currently selected* variant is already in
    /// memory, i.e. a press right now would decode rather than first sit
    /// through a load. Compares against the normalized name for the same
    /// reason `ensurePipeline` does: `loadedModel` is normalized, the config
    /// may hold the prefixed folder name, and a raw comparison would report
    /// "not ready" forever.
    var isReady: Bool {
        let modelName = normalizeVariant(configLock.withLock { _config.localModel })
        return loadQueue.sync { pipeline != nil && loadedModel == modelName }
    }

    func unloadIfIdle() {
        guard pipeline != nil else { return }
        if Date().timeIntervalSince(lastUsed) >= idleUnloadAfter {
            forceUnload(reason: "idle for >\(Int(idleUnloadAfter))s")
        }
    }

    func forceUnload(reason: String) {
        // A provider switch can happen while CoreML is still compiling. Mark
        // that load cancelled even when no pipeline has been installed yet;
        // `loadPipeline` checks before publishing it so the old engine cannot
        // quietly become resident after the switch.
        let inFlight = loadTaskLock.withLock { () -> Task<WhisperKit, Error>? in
            let task = loadTask?.task
            loadTask = nil
            return task
        }
        inFlight?.cancel()
        loadQueue.sync {
            guard pipeline != nil else { return }
            print("WhisperKitEngine: unloading pipeline (\(reason))")
            self.pipeline = nil
            self.loadedModel = nil
        }
    }

    // MARK: - Internals

    private func ensurePipeline() async throws -> WhisperKit {
        let currentModel = configLock.withLock { _config.localModel }
        // WhisperKit's HF glob is `*openai*<variant>/*`; the variant must be
        // the bare name (`large-v3-turbo`), not the full folder name
        // (`openai_whisper-large-v3-turbo`). UI/config may store either form.
        //
        // Normalize BEFORE the cache check. `loadedModel` records the
        // normalized name, so comparing it against the raw config value meant
        // a config holding the prefixed form — which is what the model picker
        // writes — never matched, and every single transcription silently
        // reloaded the pipeline from disk. Measured at ~4.1s of a ~5.4s
        // "warm" decode, i.e. most of the wait was this.
        let modelName = normalizeVariant(currentModel)
        if let p = pipeline, loadedModel == modelName {
            return p
        }

        // Join an in-flight load for the same variant rather than starting a
        // second one. The task clears itself on the way out, so a failed load
        // is retried by the next caller instead of being cached as a failure.
        let task: Task<WhisperKit, Error> = loadTaskLock.withLock {
            if let existing = loadTask, existing.model == modelName {
                return existing.task
            }
            let created = Task<WhisperKit, Error> { [weak self] in
                guard let self = self else {
                    throw NSError(domain: "WhisperKitEngine", code: -3, userInfo: [NSLocalizedDescriptionKey: "Engine deallocated during load"])
                }
                defer {
                    self.loadTaskLock.withLock {
                        if self.loadTask?.model == modelName { self.loadTask = nil }
                    }
                }
                return try await self.loadPipeline(named: modelName)
            }
            loadTask = (modelName, created)
            return created
        }
        return try await task.value
    }

    /// Materialize the CoreML pipeline. Only ever called from the single task
    /// `ensurePipeline` owns, so it doesn't need its own guarding.
    private func loadPipeline(named modelName: String) async throws -> WhisperKit {
        let t0 = Date()
        print("WhisperKitEngine: loading model '\(modelName)'")
        // Machine-readable twin of the log line above. Electron turns these
        // into the "preparing" state the composer shows: the prose line is for
        // humans reading the log, and parsing it would break the first time
        // someone reworded it.
        print("model:loading \(modelName)")

        // A silent multi-minute load is indistinguishable from a hang, and
        // this one has a specific cause worth naming: CoreML recompiles for
        // the Neural Engine whenever the client binary changes, so the first
        // press after an app update pays it once. Ticking here turns "Codey
        // is broken" into "Codey is busy, and here is why".
        let heartbeat = Task.detached(priority: .utility) {
            var waited: TimeInterval = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.slowLoadWarnSeconds * 1_000_000_000))
                if Task.isCancelled { break }
                waited += Self.slowLoadWarnSeconds
                print(String(format: "WhisperKitEngine: still preparing '%@' (%.0fs) - CoreML is compiling for the Neural Engine, this happens once per app build", modelName, waited))
            }
        }
        defer { heartbeat.cancel() }

        let kitConfig = WhisperKitConfig(
            model: modelName,
            computeOptions: Self.computeOptions,
            verbose: false,
            logLevel: .info,
            prewarm: false,
            load: true,
            download: true
        )
        let pipe: WhisperKit
        do {
            pipe = try await WhisperKit(kitConfig)
            try Task.checkCancellation()
        } catch {
            // Electron is holding a "preparing" indicator up on the strength of
            // `model:loading`. Without a terminal marker it would stay there
            // forever on a failed load.
            print("model:failed \(modelName)")
            throw error
        }
        let elapsed = Date().timeIntervalSince(t0)
        self.pipeline = pipe
        self.loadedModel = modelName
        print(String(format: "WhisperKitEngine: model '%@' ready (load took %.1fs)", modelName, elapsed))
        print(String(format: "model:ready %@ %.1f", modelName, elapsed))
        return pipe
    }

    private func withLoadTimeout<T: Sendable>(seconds: TimeInterval, _ op: @Sendable @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await op() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw NSError(domain: "WhisperKitEngine", code: -1, userInfo: [NSLocalizedDescriptionKey: "Model still not ready after \(Int(seconds))s. Try again - the load continues in the background."])
            }
            guard let first = try await group.next() else {
                throw NSError(domain: "WhisperKitEngine", code: -2, userInfo: [NSLocalizedDescriptionKey: "Task group returned no result"])
            }
            group.cancelAll()
            return first
        }
    }
}
