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
    /// Unused by WhisperKit (we don't surface partial decodes today); kept to
    /// satisfy the protocol. Wire up once we move to streaming decode.
    var onPartial: ((String) -> Void)?
    private var lastUsed: Date = .distantPast
    // Kept the pipeline warm across pauses in dictation. 30s was over-eager —
    // it punished every "type a sentence, think, type another" cadence with a
    // 1–3s cold reload. 5 min covers normal interactive use; the unload still
    // fires when the user genuinely walks away.
    private let idleUnloadAfter: TimeInterval = 300
    private let loadQueue = DispatchQueue(label: "codey.voice.whisperkit.load")
    /// Background sliding-window task that pulls partial transcripts from the
    /// in-progress recording. Owned by the engine so we can cancel it on
    /// stop/cancel without the coordinator having to track Task lifetimes.
    private var streamingTask: Task<Void, Never>?
    /// Streaming state — protected by `streamingLock` since the streaming
    /// task writes from a detached priority thread and the final transcribe
    /// reads on the main task. See `StreamingState` for what each field
    /// represents.
    private var streamingState = StreamingState()
    private let streamingLock = NSLock()

    /// Snapshot of where the sliding-window streamer has progressed so far.
    /// We split the running transcript into:
    ///   - "confirmed": segments that have stayed put across multiple decodes
    ///     and won't be re-decoded again (their audio is below
    ///     `confirmedEndSeconds`). Text is final.
    ///   - "tail": the most recent segment, which may still mutate as more
    ///     audio arrives. Re-decoded every iteration via `clipTimestamps`.
    /// `lastEmittedFullText` is the joined `confirmed + tail` from the most
    /// recent emission — used to skip the final decode when the user stops
    /// recording right after the streamer just emitted.
    private struct StreamingState {
        var confirmedText: String = ""
        var confirmedEndSeconds: Float = 0
        var tailText: String = ""
        var lastEmittedFullText: String = ""
        var lastSnapshotSampleCount: Int = 0
        var lastSnapshotAt: Date = .distantPast
        var inProgress: Bool = false
    }

    init(config: VoiceConfig) {
        self.config = config
    }

    /// Start emitting partial transcripts while the user is still talking.
    /// Pulls a snapshot of the live audio buffer every iteration, decodes the
    /// whole thing, and pushes the result through `onPartial`. Re-decoding the
    /// full buffer each round is wasteful on long recordings but simple and
    /// correct — turbo on Apple Silicon handles a 30 s clip in ~1–2 s, so the
    /// partial just lags by one decode round, which is fine for a HUD preview.
    /// The final, authoritative transcription still runs via the existing
    /// `transcribe(audio:language:)` path on `stopRecording`.
    ///
    /// `audioSnapshot` must return a coherent copy of the captured Float32
    /// samples at 16 kHz; see `AudioCapture.currentSamplesSnapshot()`.
    func startStreaming(audioSnapshot: @escaping @Sendable () -> [Float], language: String) {
        stopStreaming() // idempotent: cancel any previous run
        // Reset accumulator state — last run's confirmed text is irrelevant.
        streamingLock.withLock {
            self.streamingState = StreamingState()
            self.streamingState.inProgress = true
        }
        let lang = language
        streamingTask = Task.detached(priority: .userInitiated) { [weak self] in
            guard let self = self else { return }
            let pipe: WhisperKit
            do {
                pipe = try await self.ensurePipeline()
            } catch {
                print("WhisperKitEngine.startStreaming: load failed — \(error.localizedDescription)")
                return
            }

            // Wait for at least ~1 s of audio before the first decode — turbo
            // refuses to commit on very short clips and we'd just get empty
            // strings back.
            let minSamples = 16_000
            var lastSnapshotCount = 0

            while !Task.isCancelled {
                // Tighter sleep (400 ms) means the last emitted partial is on
                // average ~half-decode-time fresher when the user releases,
                // which directly improves fast-path hit rate. Each iteration
                // is still bounded by decode duration (~200–700 ms with
                // clipTimestamps on tail-only audio), so the loop's actual
                // period is ~600–1100 ms, not 400 ms.
                try? await Task.sleep(nanoseconds: 400_000_000)
                if Task.isCancelled { break }

                let samples = audioSnapshot()
                let snapshotAt = Date()  // captured at snapshot time, not after decode
                guard samples.count >= minSamples else { continue }
                // Skip a decode round if no new audio arrived (e.g. user paused
                // long enough that the buffer is unchanged).
                guard samples.count > lastSnapshotCount else { continue }
                lastSnapshotCount = samples.count

                // Read the confirmed boundary that the last successful decode
                // settled on. WhisperKit will skip everything before this
                // timestamp internally, so each iteration only decodes the
                // unconfirmed tail rather than re-doing the whole buffer.
                let (clipStart, confirmedTextSoFar) = self.streamingLock.withLock {
                    (self.streamingState.confirmedEndSeconds, self.streamingState.confirmedText)
                }

                var options = self.streamingOptions(language: lang)
                if clipStart > 0 { options.clipTimestamps = [clipStart] }

                self.lastUsed = Date()
                do {
                    let normalized = self.peakNormalize(samples, target: 0.9)
                    let results = try await pipe.transcribe(audioArray: normalized, decodeOptions: options)
                    if Task.isCancelled { break }

                    // Sort segments by start time; treat all-but-last as newly
                    // confirmed (the trailing segment is still being shaped by
                    // incoming audio so it can flip wording on the next pass).
                    let segments = results.flatMap { $0.segments }.sorted { $0.start < $1.start }
                    var newConfirmedText = confirmedTextSoFar
                    var newConfirmedEnd = clipStart
                    if segments.count > 1 {
                        for seg in segments.dropLast() {
                            // clipTimestamps is a hint, not a hard cut — a
                            // segment that re-spans the boundary occasionally
                            // shows up. Guard against double-appending.
                            if seg.end > newConfirmedEnd {
                                newConfirmedText += Self.stripWhisperTags(seg.text)
                                newConfirmedEnd = seg.end
                            }
                        }
                    }
                    let tail = Self.stripWhisperTags(segments.last?.text ?? "")
                    let fullText = (newConfirmedText + tail).trimmingCharacters(in: .whitespacesAndNewlines)

                    self.streamingLock.withLock {
                        self.streamingState.confirmedText = newConfirmedText
                        self.streamingState.confirmedEndSeconds = newConfirmedEnd
                        self.streamingState.tailText = tail
                        self.streamingState.lastEmittedFullText = fullText
                        self.streamingState.lastSnapshotSampleCount = samples.count
                        // Use the snapshot timestamp, not "now" — otherwise
                        // `elapsed` in the fast-path check is inflated by the
                        // decode duration itself.
                        self.streamingState.lastSnapshotAt = snapshotAt
                    }

                    if !fullText.isEmpty, let cb = self.onPartial {
                        await MainActor.run { cb(fullText) }
                    }
                } catch {
                    // Partial decode errors are non-fatal — keep the loop going
                    // so a transient hiccup doesn't kill the live preview.
                    print("WhisperKitEngine.startStreaming: partial decode error — \(error.localizedDescription)")
                }
            }
        }
    }

    /// Decode options shared by the streaming loop and the post-stop "settle"
    /// decode. Kept lean — temperature fallback off, fewer workers — because
    /// these run on a partial buffer and we want fast iteration; the final
    /// non-streaming `transcribe()` path keeps the more conservative options.
    private func streamingOptions(language: String) -> DecodingOptions {
        var options = DecodingOptions()
        options.task = .transcribe
        if !language.isEmpty && language != "auto" { options.language = language }
        options.temperature = 0.0
        options.sampleLength = 144
        // We need segment timestamps to track the confirmed/unconfirmed
        // boundary — `withoutTimestamps = true` would strip them.
        options.withoutTimestamps = false
        options.usePrefillPrompt = true
        options.chunkingStrategy = .vad
        options.temperatureFallbackCount = 0
        options.concurrentWorkerCount = 2
        return options
    }

    /// Cancel the streaming loop if one is running. Safe to call multiple
    /// times. The in-flight decode (if any) will finish but its result is
    /// discarded once the task observes cancellation.
    func stopStreaming() {
        streamingTask?.cancel()
        streamingTask = nil
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
        let modelChanged = config.localModel != self.config.localModel
        self.config = config
        if modelChanged {
            // Drop the pipeline; next transcribe will reload the new variant.
            loadQueue.sync { self.pipeline = nil; self.loadedModel = nil }
        }
    }

    func transcribe(audio: [Float], language: String) async throws -> String {
        // Fast path: if the streamer ALREADY produced a partial that covers
        // (essentially) the entire captured buffer and did so very recently,
        // reuse it as the final result *before* waiting on the cancelled
        // streaming task. Otherwise an in-flight partial decode that hasn't
        // observed cancellation yet (500 ms–2 s remaining) would block us
        // until it finishes — eating most of what fast-path is supposed to
        // save. The orphan decode is allowed to run to completion in the
        // background; its result is dropped by the coordinator (state is
        // already `.idle` by the time `onPartial` fires).
        let cached = streamingLock.withLock { streamingState }
        if !cached.lastEmittedFullText.isEmpty {
            let newSamples = audio.count - cached.lastSnapshotSampleCount
            let elapsed = Date().timeIntervalSince(cached.lastSnapshotAt)
            if newSamples < 8_000 && elapsed < 1.5 {
                print("WhisperKitEngine: reusing streaming partial as final (\(cached.lastEmittedFullText.count) chars, \(newSamples) new samples, \(String(format: "%.2f", elapsed))s old)")
                streamingLock.withLock { self.streamingState = StreamingState() }
                // Detach the orphan task — we don't await it. Setting nil here
                // is racy with the task's own bookkeeping but the cancel was
                // already issued; the task's eventual write to streamingTask
                // is irrelevant since the next startStreaming resets it.
                streamingTask = nil
                return cached.lastEmittedFullText
            }
        }

        // Fast-path didn't fire — we're going to hit the pipeline ourselves,
        // so first wait for any in-flight streaming decode to finish.
        // WhisperKit isn't documented as safe under concurrent transcribe
        // calls; serializing here is the cheap way to guarantee correctness.
        if let task = streamingTask {
            _ = await task.value
            streamingTask = nil
        }

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

        // If the streaming pass already confirmed a prefix, skip over it here
        // so the final "settle decode" only re-does the unconfirmed tail. We
        // keep `withoutTimestamps = true` (default for the final path) — the
        // confirmed prefix has its boundary, that's all we need.
        if cached.confirmedEndSeconds > 0 {
            options.clipTimestamps = [cached.confirmedEndSeconds]
        }

        let t0 = Date()
        let results = try await pipe.transcribe(audioArray: normalized, decodeOptions: options)
        let elapsed = Date().timeIntervalSince(t0)
        let tailText = results.map { Self.stripWhisperTags($0.text) }.joined(separator: " ")
        let merged = (cached.confirmedText + tailText).trimmingCharacters(in: .whitespacesAndNewlines)
        print(String(format: "WhisperKitEngine: decode took %.2fs (%d samples, %@)", elapsed, normalized.count, cached.confirmedEndSeconds > 0 ? "tail from \(cached.confirmedEndSeconds)s" : "full"))
        // Drop the cached streaming state — it's been consumed.
        streamingLock.withLock { self.streamingState = StreamingState() }
        return merged
    }

    /// Strip Whisper special tokens (`<|startoftranscript|>`, `<|en|>`,
    /// `<|transcribe|>`, `<|0.00|>`, …) from segment text. They leak into
    /// `seg.text` when `withoutTimestamps = false` — which we need on the
    /// streaming path to get segment boundaries for `clipTimestamps`. Stripping
    /// here is simpler than juggling decoder options.
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
