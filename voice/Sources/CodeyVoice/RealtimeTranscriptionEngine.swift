import Foundation

/// Transcribes audio via the OpenAI Realtime WebSocket API (transcription-session).
///
/// ## Streaming flow
///
///   `startRealtimeSession(language:)` → N×`appendAudioChunk(_:)` →
///   `transcribe(audio:language:)` / `cancelSession()`
///
/// The coordinator opens a WebSocket session when recording starts, forwards
/// audio chunks as they arrive, then finalizes via the protocol
/// `transcribe(audio:language:)` which commits the buffer and awaits the final
/// transcript. If the session failed to connect, `transcribe()` falls back
/// to the batch HTTP API transparently.
///
/// ## Lifecycle
///
/// One socket per utterance. Opened in `startRealtimeSession`, closed on
/// `cancelSession`, on idle timeout (>30 s), or on `deinit`.
final class RealtimeTranscriptionEngine: NSObject, TranscriptionEngineProtocol, @unchecked Sendable {
    // MARK: - Configuration

    private let session: URLSession
    private let configLock = NSLock()
    private var _config: VoiceConfig

    private let stateLock = NSLock()
    private var _webSocketTask: URLSessionWebSocketTask? {
        didSet { oldValue?.cancel(with: .normalClosure, reason: nil) }
    }
    private var _connectContinuation: CheckedContinuation<Void, Error>?
    private var _transcribeContinuation: CheckedContinuation<String, Error>?
    private var _accumulatedText = ""
    private var _finalTranscript: String?
    /// True once `didOpenWithProtocol` fires (session is usable).
    private var _isSessionActive = false
    /// True once `didCompleteWithError` or an explicit disconnect fires.
    private var _isDisconnected = false

    private var _lastUsed = Date.distantPast
    private let idleUnloadAfter: TimeInterval = 30

    var onPartial: ((String) -> Void)?

    // MARK: - Init / deinit

    init(config: VoiceConfig) {
        self._config = config
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: cfg)
    }

    deinit {
        disconnect()
        // Drain any remaining continuations so nothing hangs forever.
        stateLock.withLock {
            _connectContinuation?.resume(throwing: CancellationError())
            _connectContinuation = nil
            _transcribeContinuation?.resume(throwing: CancellationError())
            _transcribeContinuation = nil
        }
    }

    // MARK: - TranscriptionEngineProtocol

    func updateConfig(_ config: VoiceConfig) {
        configLock.withLock { _config = config }
    }

    func unloadIfIdle() {
        let shouldClose = stateLock.withLock { () -> Bool in
            guard _webSocketTask != nil, !_isSessionActive else { return false }
            if Date().timeIntervalSince(_lastUsed) >= idleUnloadAfter {
                _isDisconnected = true
                _webSocketTask = nil
                return true
            }
            return false
        }
        if shouldClose {
            print("realtime: closed idle socket (>\(Int(idleUnloadAfter))s)")
        }
    }

    /// Transcribe audio using either the active WebSocket session (commit +
    /// await final transcript) or the batch HTTP API as a fallback when the
    /// session never connected (or disconnected mid-utterance).
    func transcribe(audio: [Float], language: String) async throws -> String {
        // Check whether the WebSocket session is active. If not, fall through
        // to the batch HTTP path.
        let sessionWasActive = stateLock.withLock { _isSessionActive }

        if sessionWasActive {
            return try await commitAndRequest()
        }

        print("realtime: session not active — falling back to batch API")
        return try await batchFallback(audio: audio, language: language)
    }

    // MARK: - Streaming API (called by VoiceCoordinator)

    /// Open a WebSocket to the Realtime API and send `session.update` to
    /// configure the session. Returns once the connection opens and the server
    /// acknowledges the session configuration. Throws on failure.
    func startRealtimeSession(language: String) async throws {
        let (apiKey, realtimeUrl, realtimeModel) = configLock.withLock {
            (_config.apiKey, _config.realtimeUrl, _config.realtimeModel)
        }
        guard !apiKey.isEmpty else { throw TranscriptionError.noAPIKey }
        guard let url = URL(string: realtimeUrl) else {
            throw TranscriptionError.invalidURL(realtimeUrl)
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        // Create the WebSocket task with self as delegate so we get
        // didOpenWithProtocol / didCompleteWithError callbacks.
        let ws = session.webSocketTask(with: request)
        stateLock.withLock {
            _webSocketTask = ws
            _isDisconnected = false
            _isSessionActive = false
            _lastUsed = Date()
        }

        // Await connection confirmation (resumed in didOpenWithProtocol or
        // didCompleteWithError).
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            stateLock.withLock {
                if _isDisconnected {
                    continuation.resume(throwing: TranscriptionError.connectionFailed("already disconnected"))
                    return
                }
                _connectContinuation = continuation
            }
            ws.resume()
        }

        // Send session configuration
        let updateData = try buildSessionUpdate(
            language: language,
            model: realtimeModel
        )
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            ws.send(.data(updateData)) { error in
                if let error = error {
                    continuation.resume(throwing: TranscriptionError.apiError(0, "session.update: \(error.localizedDescription)"))
                } else {
                    continuation.resume()
                }
            }
        }

        // Start the background receive loop for delta/completed events.
        let loopWs = ws
        Task { [weak self] in
            await self?.receiveLoop(ws: loopWs)
        }

        print("realtime: session started (model=\(realtimeModel))")
    }

    /// Encode `samples` as PCM16 base64 and send as `input_audio_buffer.append`.
    /// Safe to call from any thread (audio tap). Silently drops when no session
    /// is open (fire-and-forget).
    func appendAudioChunk(_ samples: [Float]) {
        let ws = stateLock.withLock { () -> URLSessionWebSocketTask? in
            guard _isSessionActive, !_isDisconnected else { return nil }
            _lastUsed = Date()
            return _webSocketTask
        }
        guard let ws = ws else { return }

        let pcmData = pcm16Data(from: samples)
        let base64 = pcmData.base64EncodedString()
        let event: [String: Any] = [
            "type": "input_audio_buffer.append",
            "audio": base64,
        ]
        guard let msgData = try? JSONSerialization.data(withJSONObject: event) else { return }
        ws.send(.data(msgData)) { error in
            if let error = error {
                print("realtime: append error — \(error.localizedDescription)")
            }
        }
    }

    /// Disconnect the current WebSocket session immediately without committing
    /// the audio buffer (used on Esc-to-cancel or provider switch).
    func cancelSession() {
        disconnect()
    }

    // MARK: - WebSocket commit + await transcript

    /// Send `input_audio_buffer.commit` followed by `response.create`, then
    /// await the final transcript from the server event stream.
    private func commitAndRequest() async throws -> String {
        let ws = stateLock.withLock { () -> URLSessionWebSocketTask? in
            // Reset accumulated state for a fresh utterance.
            _accumulatedText = ""
            _finalTranscript = nil
            return _webSocketTask
        }
        guard let ws = ws else {
            throw TranscriptionError.connectionFailed("socket closed before commit")
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.stateLock.withLock { self._transcribeContinuation = continuation }

            // 1. Commit the audio buffer so the server starts transcribing.
            let commit: [String: Any] = ["type": "input_audio_buffer.commit"]
            guard let commitData = try? JSONSerialization.data(withJSONObject: commit) else {
                self.stateLock.withLock { self._transcribeContinuation = nil }
                continuation.resume(throwing: TranscriptionError.badResponse)
                return
            }
            ws.send(.data(commitData)) { [self] error in
                if let error = error {
                    stateLock.withLock { self._transcribeContinuation = nil }
                    continuation.resume(throwing: TranscriptionError.apiError(0, "commit: \(error.localizedDescription)"))
                    return
                }

                // 2. Request the response to get the transcript delivered.
                let create: [String: Any] = ["type": "response.create"]
                guard let createData = try? JSONSerialization.data(withJSONObject: create) else {
                    stateLock.withLock { self._transcribeContinuation = nil }
                    continuation.resume(throwing: TranscriptionError.badResponse)
                    return
                }
                ws.send(.data(createData)) { [self] error in
                    if let error = error {
                        stateLock.withLock { self._transcribeContinuation = nil }
                        continuation.resume(throwing: TranscriptionError.apiError(0, "response.create: \(error.localizedDescription)"))
                    }
                    // Success — the receive loop delivers the transcript events.
                }
            }
        }
    }

    // MARK: - Batch HTTP fallback

    /// One-shot batch transcription via the standard `/audio/transcriptions`
    /// endpoint. Used when the WebSocket session never connected or
    /// disconnected mid-utterance.
    private func batchFallback(audio: [Float], language: String) async throws -> String {
        let config = configLock.withLock { _config }
        let httpEngine = TranscriptionEngine(config: config)
        return try await httpEngine.transcribe(audio: audio, language: language)
    }

    // MARK: - Internal: WebSocket receive loop

    /// Background loop reading WebSocket messages and dispatching by event type.
    private func receiveLoop(ws: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await ws.receive()
                stateLock.withLock { _lastUsed = Date() }

                switch message {
                case .data(let data):
                    handleEvent(data: data)
                case .string(let string):
                    if let data = string.data(using: .utf8) {
                        handleEvent(data: data)
                    }
                @unknown default:
                    break
                }
            } catch {
                print("realtime: receive error — \(error.localizedDescription)")
                if let nsError = error as NSError?,
                   nsError.domain == NSURLErrorDomain,
                   nsError.code == NSURLErrorNetworkConnectionLost {
                    handleConnectionLost()
                    break
                }
            }
        }
    }

    // MARK: - Internal: Event dispatch

    private func handleEvent(data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else {
            return
        }

        switch type {
        case "conversation.item.input_audio_transcription.delta":
            if let delta = obj["delta"] as? String {
                stateLock.withLock { _accumulatedText.append(delta) }
                let snapshot = stateLock.withLock { _accumulatedText }
                if let cb = onPartial {
                    DispatchQueue.main.async { cb(snapshot) }
                }
            }

        case "conversation.item.input_audio_transcription.completed":
            let transcript = (obj["transcript"] as? String) ?? ""
            stateLock.withLock {
                _finalTranscript = transcript
            }

        case "response.text.done":
            if let text = obj["text"] as? String {
                stateLock.withLock { _finalTranscript = text }
            }

        case "response.done":
            let transcript = stateLock.withLock { () -> String in
                let t = _finalTranscript ?? _accumulatedText
                _isSessionActive = false
                return t
            }
            let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)

            stateLock.withLock {
                if let cont = _transcribeContinuation {
                    _transcribeContinuation = nil
                    cont.resume(returning: trimmed)
                }
            }

        case "error":
            let msg = (obj["error"] as? [String: Any])?["message"] as? String
                ?? (obj["error"] as? String)
                ?? "unknown error"
            print("realtime: server error — \(msg)")
            stateLock.withLock {
                if let cont = _transcribeContinuation {
                    _transcribeContinuation = nil
                    cont.resume(throwing: TranscriptionError.apiError(0, msg))
                }
            }

        case "session.created", "session.updated":
            // Lifecycle acknowledgment — no action needed.
            break

        default:
            print("realtime: unhandled event type=\(type)")
        }
    }

    // MARK: - Internal: Connection management

    private func handleConnectionLost() {
        stateLock.withLock {
            _isDisconnected = true
            _isSessionActive = false
            if let cont = _transcribeContinuation {
                _transcribeContinuation = nil
                cont.resume(throwing: TranscriptionError.connectionFailed("connection lost"))
            }
        }
    }

    private func disconnect() {
        stateLock.withLock {
            _isDisconnected = true
            _isSessionActive = false
            _connectContinuation?.resume(throwing: CancellationError())
            _connectContinuation = nil
            _webSocketTask = nil
        }
    }

    // MARK: - Session update builder

    /// Build the JSON data for `session.update` with the required `"session"`
    /// wrapper key. Uses `NSNull()` to explicitly disable server VAD so the
    /// manual commit model is the only commit source.
    private func buildSessionUpdate(language: String, model: String) throws -> Data {
        let lang = language.isEmpty || language == "auto" ? "" : language
        var transcription: [String: Any] = [
            "model": model,
        ]
        if !lang.isEmpty {
            transcription["language"] = lang
        }

        let body: [String: Any] = [
            "type": "session.update",
            "session": [
                "modalities": ["text"],
                "input_audio_format": "pcm16",
                "input_audio_transcription": transcription,
                "turn_detection": NSNull(),  // disabled — we control start/stop
            ] as [String: Any],
        ]
        return try JSONSerialization.data(withJSONObject: body)
    }
}

// MARK: - URLSessionWebSocketDelegate conformance

/// The session delegate receives connection lifecycle events that we use to
/// resolve (or fail) the `startRealtimeSession` continuation.
extension RealtimeTranscriptionEngine: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        print("realtime: WebSocket connected")
        stateLock.withLock {
            _isSessionActive = true
            _isDisconnected = false
            if let cont = _connectContinuation {
                _connectContinuation = nil
                cont.resume()
            }
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error = error {
            print("realtime: WebSocket disconnected with error — \(error.localizedDescription)")
        } else {
            print("realtime: WebSocket closed normally")
        }
        stateLock.withLock {
            _isDisconnected = true
            _isSessionActive = false
            // If a connect continuation is still pending, fail it.
            if let cont = _connectContinuation {
                _connectContinuation = nil
                cont.resume(throwing: error.map { TranscriptionError.connectionFailed($0.localizedDescription) }
                    ?? TranscriptionError.connectionFailed("connection closed"))
            }
            // If a transcribe continuation is still pending, fail it.
            if let cont = _transcribeContinuation {
                _transcribeContinuation = nil
                cont.resume(throwing: error.map { TranscriptionError.apiError(0, $0.localizedDescription) }
                    ?? TranscriptionError.apiError(0, "connection closed before transcript"))
            }
        }
    }
}
