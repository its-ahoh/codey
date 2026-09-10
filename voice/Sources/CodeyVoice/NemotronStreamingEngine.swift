import Foundation
import FluidAudio

/// One downloadable build of the on-device streaming recognizer.
///
/// Config and the Mac app refer to it by an id of the form
/// `nemotron/<multilingual|latin>/<chunkMs>ms`, e.g.
/// `nemotron/multilingual/1120ms`. `multilingual` is the full-vocabulary
/// build (en/es/fr/it/pt/de/zh/ja); `latin` is a pruned, faster build for the
/// six Latin-script languages only. The chunk tier is how much audio the
/// model waits for before it emits: smaller is snappier, larger is a little
/// more accurate and punctuates better.
struct NemotronVariant: Equatable {
    static let idPrefix = "nemotron/"
    /// FluidAudio deliberately uses a short, stable cache name rather than
    /// the Hugging Face repository name. Keep this in sync with
    /// `Repo.nemotronMultilingual.folderName`.
    static let repoFolder = "nemotron-multilingual"
    static let chunkTiers = [560, 1120, 2240]
    static let `default` = NemotronVariant(languageDir: "multilingual", chunkMs: 1120)

    let languageDir: String
    let chunkMs: Int

    init(languageDir: String, chunkMs: Int) {
        self.languageDir = languageDir
        self.chunkMs = chunkMs
    }

    /// Parses `nemotron/<dir>/<ms>ms`. Returns nil for anything else, so a
    /// WhisperKit variant name is never mistaken for a streaming one.
    init?(id: String) {
        guard id.hasPrefix(Self.idPrefix) else { return nil }
        let parts = id.dropFirst(Self.idPrefix.count).split(separator: "/").map(String.init)
        guard parts.count == 2, parts[1].hasSuffix("ms"),
              let ms = Int(parts[1].dropLast(2)),
              Self.chunkTiers.contains(ms),
              parts[0] == "multilingual" || parts[0] == "latin"
        else { return nil }
        self.languageDir = parts[0]
        self.chunkMs = ms
    }

    static func isStreamingModelId(_ id: String) -> Bool { NemotronVariant(id: id) != nil }

    var id: String { "\(Self.idPrefix)\(languageDir)/\(chunkMs)ms" }

    /// The language hint FluidAudio's downloader maps onto `languageDir`
    /// (`languageDirectory(for:)` sends Latin-script codes to `latin` and
    /// everything else to `multilingual`).
    var downloadLanguageCode: String { languageDir == "latin" ? "en" : "auto" }

    /// Where FluidAudio caches this variant. Mirrors `downloadVariant`'s
    /// default so the Mac app can check for the files without loading them.
    var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("FluidAudio", isDirectory: true)
            .appendingPathComponent("Models", isDirectory: true)
            .appendingPathComponent(Self.repoFolder, isDirectory: true)
            .appendingPathComponent(languageDir, isDirectory: true)
            .appendingPathComponent("\(chunkMs)ms", isDirectory: true)
    }

    var isDownloaded: Bool {
        let fm = FileManager.default
        let plainFiles = ["metadata.json", "tokenizer.json"]
        guard plainFiles.allSatisfy({ fm.fileExists(atPath: directory.appendingPathComponent($0).path) }) else {
            return false
        }

        // metadata.json is downloaded alongside the model bundles, not as a
        // completion marker. An interrupted transfer can therefore leave it
        // behind while a CoreML bundle is unusable. Check the load-critical
        // bundle internals before advertising the variant as downloaded.
        let bundles = ["encoder.mlmodelc", "decoder.mlmodelc", "joint.mlmodelc"]
        return bundles.allSatisfy { name in
            let bundle = directory.appendingPathComponent(name, isDirectory: true)
            let metadata = bundle.appendingPathComponent("coremldata.bin")
            let weights = bundle.appendingPathComponent("weights/weight.bin")
            guard fm.fileExists(atPath: metadata.path),
                  let attrs = try? fm.attributesOfItem(atPath: weights.path),
                  let size = attrs[.size] as? NSNumber
            else { return false }
            return size.int64Value > 1024
        }
    }

    /// Fetch the compiled models from HuggingFace (no-op when cached).
    /// Progress is reported as a 0...1 fraction.
    func download(progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
        try await StreamingNemotronMultilingualAsrManager.downloadVariant(
            languageCode: downloadLanguageCode,
            chunkMs: chunkMs,
            progressHandler: { progress($0.fractionCompleted) }
        )
    }

    /// Load a variant and repair a cache whose files have the right names and
    /// sizes but bad bytes. CoreML reports that case as execution-plan error
    /// -14; FluidAudio's downloader only validates byte count, so it otherwise
    /// keeps reusing the poisoned cache forever.
    func loadManagerWithRecovery(
        progress: @escaping @Sendable (Double) -> Void = { _ in }
    ) async throws -> StreamingNemotronMultilingualAsrManager {
        let dir = isDownloaded ? directory : try await download(progress: progress)
        let first = StreamingNemotronMultilingualAsrManager()
        do {
            try await first.loadModels(from: dir)
            return first
        } catch {
            await first.cleanup()
            guard Self.isCoreMLLoadFailure(error), !Task.isCancelled else { throw error }

            print("NemotronVariant: CoreML rejected cached model; deleting and downloading a clean copy")
            try FileManager.default.removeItem(at: directory)
            let repairedDir = try await download(progress: progress)
            let retry = StreamingNemotronMultilingualAsrManager()
            do {
                try await retry.loadModels(from: repairedDir)
                return retry
            } catch {
                await retry.cleanup()
                throw error
            }
        }
    }

    private static func isCoreMLLoadFailure(_ error: Error) -> Bool {
        var current: NSError? = error as NSError
        while let value = current {
            if value.domain == "com.apple.CoreML" { return true }
            current = value.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return false
    }
}

/// On-device *streaming* transcription via FluidAudio's Nemotron CoreML port.
///
/// Unlike `WhisperKitEngine`, which re-decodes a growing buffer to fake a
/// live preview, this model consumes audio in fixed chunks and emits tokens
/// as it goes, so the HUD text is the real decode in progress. The flow
/// mirrors `RealtimeTranscriptionEngine`:
///
///   `startSession(language:)` -> N x `appendAudioChunk(_:)` ->
///   `transcribe(audio:language:)` (finishes the session) / `cancelSession()`
///
/// `transcribe` ignores the full buffer when a session is open because every
/// sample has already been fed; it only flushes the tail and returns the
/// final text. Without a session (no chunks were forwarded) it decodes the
/// buffer from scratch so the protocol contract still holds.
///
/// Lazy-loaded and idle-unloaded on the same schedule as WhisperKit; only one
/// of the two on-device engines is ever resident because the coordinator
/// unloads whichever one the user switched away from.
final class NemotronStreamingEngine: TranscriptionEngineProtocol, @unchecked Sendable {
    private let configLock = NSLock()
    private var _config: VoiceConfig
    var onPartial: ((String) -> Void)?

    /// The manager owns both the resident CoreML models and decode state.
    /// There is one manager because Codey only runs one local stream; using
    /// FluidAudio's multi-stream shared-model path here would also omit the
    /// model directory needed for lazy custom-vocabulary decoder loading.
    private var manager: StreamingNemotronMultilingualAsrManager?
    private var loadedVariant: NemotronVariant?
    private let loadQueue = DispatchQueue(label: "codey.voice.nemotron.load")
    private var loadTask: (variant: NemotronVariant, task: Task<StreamingNemotronMultilingualAsrManager, Error>)?
    private let loadTaskLock = NSLock()

    private var lastUsed: Date = .distantPast
    /// Same reasoning as WhisperKit's: long enough to cover a working session,
    /// short enough to give the memory back when the user walks away.
    private let idleUnloadAfter: TimeInterval = 1800
    private static let loadTimeoutSeconds: TimeInterval = 600
    private static let slowLoadWarnSeconds: TimeInterval = 8

    /// Audio is handed to the actor through a chain of tasks so chunks are
    /// processed in arrival order; a bare `Task {}` per chunk would not
    /// guarantee that. `sessionActive` gates the chain so a chunk that lands
    /// after cancel is dropped rather than decoded into the next turn.
    private let sessionLock = NSLock()
    private var _sessionActive = false
    private var _feedTask: Task<Void, Never>?
    private var _sessionGeneration = 0

    init(config: VoiceConfig) {
        self._config = config
    }

    private var variant: NemotronVariant {
        let id = configLock.withLock { _config.streamingModel }
        return NemotronVariant(id: id) ?? .default
    }

    // MARK: - Session

    /// Open a decode session for a new utterance. Loads the model if needed.
    /// A startup prewarm and the first recording share `ensureManager`'s task,
    /// so a hotkey arriving during the short resident-load window is not lost.
    func startSession(language: String) {
        let generation = sessionLock.withLock { () -> Int in
            _sessionGeneration += 1
            _sessionActive = true
            _feedTask = nil
            return _sessionGeneration
        }
        let terms = configLock.withLock { _config.vocabulary }
        let lang = Self.languageHint(language)
        let task = Task { [weak self] in
            guard let self = self else { return }
            do {
                let mgr = try await self.ensureManager()
                guard self.isSession(generation) else { return }
                await mgr.reset()
                await mgr.setLanguage(lang)
                await mgr.setCustomVocabulary(terms.map { CustomVocabularyTerm(text: $0.term) })
                await mgr.setPartialCallback { [weak self] text in
                    guard let self = self, self.isSession(generation) else { return }
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty, let cb = self.onPartial else { return }
                    DispatchQueue.main.async { cb(trimmed) }
                }
                self.lastUsed = Date()
            } catch {
                print("NemotronStreamingEngine.startSession: load failed — \(error.localizedDescription)")
                self.sessionLock.withLock {
                    if self._sessionGeneration == generation { self._sessionActive = false }
                }
            }
        }
        sessionLock.withLock { _feedTask = task }
    }

    /// Forward a 16 kHz mono chunk from the microphone. No-op when no
    /// session is open, so it is safe to leave wired to the audio tap.
    func appendAudioChunk(_ chunk: [Float]) {
        let (active, previous, generation) = sessionLock.withLock {
            (_sessionActive, _feedTask, _sessionGeneration)
        }
        guard active, !chunk.isEmpty else { return }
        let task = Task { [weak self] in
            await previous?.value
            guard let self = self, self.isSession(generation), let mgr = self.manager else { return }
            do {
                _ = try await mgr.process(samples: chunk)
            } catch {
                print("NemotronStreamingEngine: chunk decode error — \(error.localizedDescription)")
            }
        }
        sessionLock.withLock { if _sessionGeneration == generation { _feedTask = task } }
    }

    /// Drop the open session without producing text.
    func cancelSession() {
        let mgr: StreamingNemotronMultilingualAsrManager? = sessionLock.withLock {
            _sessionActive = false
            _feedTask = nil
            _sessionGeneration += 1
            return manager
        }
        if let mgr = mgr {
            Task { await mgr.reset() }
        }
    }

    private func isSession(_ generation: Int) -> Bool {
        sessionLock.withLock { _sessionActive && _sessionGeneration == generation }
    }

    // MARK: - TranscriptionEngineProtocol

    func transcribe(audio: [Float], language: String) async throws -> String {
        let (active, pending) = sessionLock.withLock { (_sessionActive, _feedTask) }
        if active {
            // Every sample has been fed already; wait for the chain to drain,
            // then flush whatever is left in the model's buffer.
            await pending?.value
            let mgr = try await withLoadTimeout(seconds: Self.loadTimeoutSeconds) { try await self.ensureManager() }
            sessionLock.withLock {
                _sessionActive = false
                _feedTask = nil
            }
            let t0 = Date()
            let text = try await mgr.finish()
            lastUsed = Date()
            print(String(format: "NemotronStreamingEngine: finish took %.2fs (%d samples streamed)", Date().timeIntervalSince(t0), audio.count))
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // No session (nothing was forwarded live) — decode the clip whole.
        let mgr = try await withLoadTimeout(seconds: Self.loadTimeoutSeconds) { try await self.ensureManager() }
        let terms = configLock.withLock { _config.vocabulary }
        await mgr.reset()
        await mgr.setLanguage(Self.languageHint(language))
        await mgr.setCustomVocabulary(terms.map { CustomVocabularyTerm(text: $0.term) })
        await mgr.setPartialCallback { _ in }
        let t0 = Date()
        _ = try await mgr.process(samples: audio)
        let text = try await mgr.finish()
        lastUsed = Date()
        print(String(format: "NemotronStreamingEngine: batch decode took %.2fs (%d samples)", Date().timeIntervalSince(t0), audio.count))
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func updateConfig(_ config: VoiceConfig) {
        let changed = configLock.withLock { config.streamingModel != _config.streamingModel }
        configLock.withLock { _config = config }
        if changed {
            forceUnload(reason: "streaming model changed to \(config.streamingModel)")
        }
    }

    func unloadIfIdle() {
        guard manager != nil else { return }
        if Date().timeIntervalSince(lastUsed) >= idleUnloadAfter {
            forceUnload(reason: "idle for >\(Int(idleUnloadAfter))s")
        }
    }

    func forceUnload(reason: String) {
        // Invalidate a prewarm that has not installed its models yet. CoreML
        // may not observe cancellation until its current load returns, so
        // `load(_:)` also checks cancellation immediately before publishing
        // the manager. This prevents a model selected before a provider
        // switch from becoming resident after the switch.
        let inFlight = loadTaskLock.withLock { () -> Task<StreamingNemotronMultilingualAsrManager, Error>? in
            let task = loadTask?.task
            loadTask = nil
            return task
        }
        inFlight?.cancel()
        let mgr: StreamingNemotronMultilingualAsrManager? = loadQueue.sync {
            guard manager != nil else { return nil }
            print("NemotronStreamingEngine: unloading models (\(reason))")
            let m = manager
            manager = nil
            loadedVariant = nil
            return m
        }
        if let mgr = mgr {
            Task { await mgr.cleanup() }
        }
    }

    /// Whether a press right now would decode immediately rather than first
    /// sit through a load. Compared by variant so a model switch in Settings
    /// reports "not ready" until the new one is resident.
    var isReady: Bool {
        let wanted = variant
        return loadQueue.sync { manager != nil && loadedVariant == wanted }
    }

    func prewarm() {
        Task.detached(priority: .utility) { [weak self] in
            guard let self = self else { return }
            do {
                _ = try await self.ensureManager()
                self.lastUsed = Date()
            } catch {
                print("NemotronStreamingEngine: prewarm failed — \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Loading

    private func ensureManager() async throws -> StreamingNemotronMultilingualAsrManager {
        let wanted = variant
        if let existing = loadQueue.sync(execute: { loadedVariant == wanted ? manager : nil }) {
            return existing
        }
        let task: Task<StreamingNemotronMultilingualAsrManager, Error> = loadTaskLock.withLock {
            if let existing = loadTask, existing.variant == wanted {
                return existing.task
            }
            let created = Task<StreamingNemotronMultilingualAsrManager, Error> { [weak self] in
                guard let self = self else {
                    throw NSError(domain: "NemotronStreamingEngine", code: -3, userInfo: [NSLocalizedDescriptionKey: "Engine deallocated during load"])
                }
                defer {
                    self.loadTaskLock.withLock {
                        if self.loadTask?.variant == wanted { self.loadTask = nil }
                    }
                }
                return try await self.load(wanted)
            }
            loadTask = (wanted, created)
            return created
        }
        return try await task.value
    }

    private func load(_ variant: NemotronVariant) async throws -> StreamingNemotronMultilingualAsrManager {
        let t0 = Date()
        let name = variant.id
        print("NemotronStreamingEngine: loading '\(name)'")
        // Same machine-readable markers WhisperKit emits; Electron turns them
        // into the composer's "preparing" state.
        print("model:loading \(name)")

        let heartbeat = Task.detached(priority: .utility) {
            var waited: TimeInterval = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.slowLoadWarnSeconds * 1_000_000_000))
                if Task.isCancelled { break }
                waited += Self.slowLoadWarnSeconds
                print(String(format: "NemotronStreamingEngine: still preparing '%@' (%.0fs) - CoreML is compiling for the Neural Engine, this happens once per app build", name, waited))
            }
        }
        defer { heartbeat.cancel() }

        do {
            // Standard single-manager loading remembers the variant directory, allowing
            // FluidAudio to bring up its logits-producing decoder lazily when
            // the user has custom vocabulary. Codey never needs the shared
            // path intended for several simultaneous transcription streams.
            let mgr = try await variant.loadManagerWithRecovery()
            try Task.checkCancellation()
            // Drop whatever was resident before installing the new one so two
            // variants never overlap in memory.
            let previous: StreamingNemotronMultilingualAsrManager? = loadQueue.sync {
                let p = manager
                manager = mgr
                loadedVariant = variant
                return p
            }
            if let previous = previous { await previous.cleanup() }
            let elapsed = Date().timeIntervalSince(t0)
            print(String(format: "NemotronStreamingEngine: '%@' ready (load took %.1fs)", name, elapsed))
            print(String(format: "model:ready %@ %.1f", name, elapsed))
            return mgr
        } catch {
            print("model:failed \(name)")
            throw error
        }
    }

    private func withLoadTimeout<T: Sendable>(seconds: TimeInterval, _ op: @Sendable @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await op() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw NSError(domain: "NemotronStreamingEngine", code: -1, userInfo: [NSLocalizedDescriptionKey: "Model still not ready after \(Int(seconds))s. Try again - the load continues in the background."])
            }
            guard let first = try await group.next() else {
                throw NSError(domain: "NemotronStreamingEngine", code: -2, userInfo: [NSLocalizedDescriptionKey: "Task group returned no result"])
            }
            group.cancelAll()
            return first
        }
    }

    // MARK: - Language

    /// Map the config's short codes onto the prompt dictionary's region
    /// codes. Anything unknown is passed through; the model falls back to
    /// auto-detect for codes it does not recognise.
    static func languageHint(_ language: String) -> String {
        let code = language.trimmingCharacters(in: .whitespacesAndNewlines)
        if code.isEmpty || code == "auto" { return "auto" }
        let regioned: [String: String] = [
            "en": "en-US", "zh": "zh-CN", "ja": "ja-JP", "es": "es-ES",
            "fr": "fr-FR", "it": "it-IT", "pt": "pt-BR", "de": "de-DE",
        ]
        return regioned[code.lowercased()] ?? code
    }
}
